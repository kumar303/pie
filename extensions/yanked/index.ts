/**
 * Yanked Extension
 *
 * Yank (save) the current pi prompt for later with Ctrl+Shift+Y.
 * The prompt is cleared, copied to the system clipboard, and stored
 * in ~/.cache/yanked-pi-extension/v1/.
 *
 * Commands:
 *   /yanked pop   - Fill the editor with the last yanked prompt
 *   /yanked list  - Browse and select a yanked prompt to pop
 *
 * Note: Ctrl+Y is already bound to tui.editor.yank (kill ring paste),
 * so this extension uses Ctrl+Shift+Y to avoid conflicts.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import {
  createFileStore,
  pushPrompt,
  popPrompt,
  listPrompts,
  removePromptAt,
} from "./store.ts";
import { copyToClipboard } from "./clipboard.ts";
import type { StoreIO } from "./store.ts";

export { yankPrompt, handlePop, handleList };

function yankPrompt(
  store: StoreIO,
  getEditorText: () => string,
  setEditorText: (text: string) => void,
  notify: (msg: string, level: "info" | "warning" | "error") => void,
  copy: (text: string) => void,
): void {
  const text = getEditorText();
  if (!text.trim()) {
    notify("Nothing to yank — editor is empty", "warning");
    return;
  }

  // Save to store first — if this fails, the editor still has the text.
  try {
    pushPrompt(store, text);
  } catch (err: any) {
    notify(`Failed to save prompt: ${err.message}`, "error");
    return;
  }

  // Only clear after successful save.
  setEditorText("");

  try {
    copy(text);
  } catch (err: any) {
    notify(
      `Yanked prompt saved but clipboard copy failed: ${err.message}`,
      "warning",
    );
    return;
  }

  notify("Prompt yanked and copied to clipboard", "info");
}

function handlePop(
  store: StoreIO,
  getEditorText: () => string,
  setEditorText: (text: string) => void,
  notify: (msg: string, level: "info" | "warning" | "error") => void,
): void {
  const currentText = getEditorText();
  if (currentText.trim()) {
    notify(
      "Cannot pop — editor is not empty. Clear it first to avoid losing your current prompt.",
      "error",
    );
    return;
  }

  // Read the prompt without removing it yet.
  const prompts = listPrompts(store);
  if (prompts.length === 0) {
    notify("No yanked prompts to pop", "warning");
    return;
  }
  const text = prompts[prompts.length - 1].text;

  // Set editor text first — if this fails, the prompt is still in the store.
  setEditorText(text);

  // Only remove from store after the editor has the text.
  try {
    popPrompt(store);
  } catch (err: any) {
    notify(
      `Prompt restored to editor but failed to update store: ${err.message}`,
      "error",
    );
    return;
  }

  notify("Popped yanked prompt into editor", "info");
}

async function handleList(
  store: StoreIO,
  getEditorText: () => string,
  setEditorText: (text: string) => void,
  notify: (msg: string, level: "info" | "warning" | "error") => void,
  select: (
    title: string,
    items: string[],
  ) => Promise<string | null | undefined>,
): Promise<void> {
  const prompts = listPrompts(store);
  if (prompts.length === 0) {
    notify("No yanked prompts stored", "warning");
    return;
  }

  const items = prompts.map((p, i) => {
    const preview = p.text.length > 60 ? p.text.slice(0, 57) + "..." : p.text;
    const singleLine = preview.replace(/\n/g, "↵");
    return `${i + 1}. ${singleLine}`;
  });

  // Show most recent last (pre-selected by pi's select dialog)
  const selected = await select("Yanked prompts (Enter to pop)", items);
  if (selected == null) return;

  // Extract index from "N. preview" format
  const match = selected.match(/^(\d+)\./);
  if (!match) return;
  const index = parseInt(match[1], 10) - 1;
  if (isNaN(index)) return;

  const currentText = getEditorText();
  if (currentText.trim()) {
    notify(
      "Cannot pop — editor is not empty. Clear it first to avoid losing your current prompt.",
      "error",
    );
    return;
  }

  const text = removePromptAt(store, index);
  if (text === null) {
    notify("Failed to pop — prompt no longer exists", "error");
    return;
  }

  // Set editor text — if this fails after removal, re-insert the prompt.
  try {
    setEditorText(text);
  } catch (err: any) {
    // Re-insert the prompt so it's not lost.
    try {
      pushPrompt(store, text);
    } catch (storeErr: any) {
      notify(
        `CRITICAL: Yanked prompt lost! Text: ${text.slice(0, 100)}... Store error: ${storeErr.message}`,
        "error",
      );
      return;
    }
    notify(
      `Failed to fill editor: ${err.message}. Prompt preserved in store.`,
      "error",
    );
    return;
  }

  notify("Popped yanked prompt into editor", "info");
}

export default function (pi: ExtensionAPI) {
  const store = createFileStore();

  // Ctrl+Shift+Y: yank the current prompt
  pi.registerShortcut(Key.ctrlShift("y"), {
    description: "Yank (save) the current prompt",
    handler: async (ctx) => {
      yankPrompt(
        store,
        () => ctx.ui.getEditorText(),
        (text) => ctx.ui.setEditorText(text),
        (msg, level) => ctx.ui.notify(msg, level),
        copyToClipboard,
      );
    },
  });

  // /yanked command
  pi.registerCommand("yanked", {
    description: "Manage yanked prompts: pop, list",
    handler: async (args, ctx) => {
      const subcommand = args.trim().toLowerCase();

      if (subcommand === "pop") {
        handlePop(
          store,
          () => ctx.ui.getEditorText(),
          (text) => ctx.ui.setEditorText(text),
          (msg, level) => ctx.ui.notify(msg, level),
        );
        return;
      }

      if (subcommand === "list") {
        await handleList(
          store,
          () => ctx.ui.getEditorText(),
          (text) => ctx.ui.setEditorText(text),
          (msg, level) => ctx.ui.notify(msg, level),
          (title, items) => ctx.ui.select(title, items),
        );
        return;
      }

      ctx.ui.notify(
        "Usage: /yanked pop — pop last prompt, /yanked list — browse prompts",
        "warning",
      );
    },
    getArgumentCompletions: (prefix: string) => {
      const commands = ["pop", "list"];
      return commands
        .filter((c) => c.startsWith(prefix))
        .map((c) => ({ value: c, label: c }));
    },
  });
}
