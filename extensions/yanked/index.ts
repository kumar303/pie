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
import type { Component } from "@mariozechner/pi-tui";
import { Key, matchesKey, Text, wrapTextWithAnsi } from "@mariozechner/pi-tui";

/**
 * Minimal subset of the Theme API the list view depends on. We type against
 * this rather than the full `Theme` class so the view is easy to construct
 * from the `ctx.ui.custom` factory without dragging in pi-coding-agent's
 * theme module.
 */
interface ListViewTheme {
  fg(color: "accent" | "dim" | "text", text: string): string;
  bold(text: string): string;
}
import {
  createFileStore,
  pushPrompt,
  popPrompt,
  listPrompts,
  removePromptAt,
} from "./store.ts";
import { copyToClipboard } from "./clipboard.ts";
import type { StoreIO } from "./store.ts";

/** Dependencies overridable for tests. */
export interface YankedDeps {
  /** Override the on-disk store directory. Defaults to ~/.cache/yanked-pi-extension/v1. */
  storePath?: string;
  /** Override the store entirely (for simulating I/O failures). Takes precedence over storePath. */
  store?: StoreIO;
  copyToClipboard?: (text: string) => void;
  /** Override the terminal width used to format list items. Defaults to process.stdout.columns. */
  getTerminalWidth?: () => number;
  /**
   * Override how the user picks an item from the list view. Receives the
   * pre-formatted display strings and resolves with the chosen 0-based
   * display index, or `undefined` if the user cancelled. Tests inject this
   * to bypass real TUI rendering; production uses a custom overlay built on
   * `ctx.ui.custom`.
   */
  pickIndex?: (items: string[]) => Promise<number | undefined>;
}

/** Maximum number of visible lines per item in the /yanked list view. */
const MAX_LIST_ITEM_LINES = 5;

/**
 * Format a stored prompt as a list item for the /yanked list selector.
 *
 * - Prefixes the first line with `${displayNumber}. ` and indents wrapped or
 *   continued lines with the same number of spaces (the "number gutter") so
 *   they align under the prompt text.
 * - Soft-wraps each input line to the available content width so long single
 *   lines don’t overflow the dialog.
 * - Caps the result at MAX_LIST_ITEM_LINES; when the prompt has more lines,
 *   the last visible line is replaced with `[N more lines]`.
 */
/**
 * Width of the cursor prefix (“▸ ” for the selected item, “  ” otherwise)
 * that the list view prepends to every rendered line. We reserve this many
 * columns when wrapping so wrapped continuation lines stay within the
 * available content width.
 */
const CURSOR_PREFIX_WIDTH = 2;

export function formatListItem(
  text: string,
  displayNumber: number,
  terminalWidth: number,
): string {
  const prefix = `${displayNumber}. `;
  // Continuations are indented by exactly the gutter width so they line up
  // under the prompt text on the first line. The view itself adds the cursor
  // prefix to every rendered line, which keeps both the first-line gutter
  // and the continuation indent visually aligned.
  const indent = " ".repeat(prefix.length);
  // The view’s Text component reserves 1 column of padding on each side, the
  // cursor prefix takes another `CURSOR_PREFIX_WIDTH`, and the gutter takes
  // `prefix.length` on the first line.
  const contentWidth = Math.max(
    1,
    terminalWidth - 2 - CURSOR_PREFIX_WIDTH - prefix.length,
  );

  // Wrap each input line individually so explicit newlines are preserved
  // and each wrapped continuation gets the hanging indent.
  const lines = text
    .split("\n")
    .flatMap((line) =>
      line === "" ? [""] : wrapTextWithAnsi(line, contentWidth),
    );

  if (lines.length <= MAX_LIST_ITEM_LINES) {
    return [prefix + lines[0], ...lines.slice(1).map((l) => indent + l)].join(
      "\n",
    );
  }

  const visibleCount = MAX_LIST_ITEM_LINES - 1;
  const visible = lines.slice(0, visibleCount);
  const hidden = lines.length - visibleCount;
  const formatted = [
    prefix + visible[0],
    ...visible.slice(1).map((l) => indent + l),
    `${indent}[${hidden} more lines]`,
  ];
  return formatted.join("\n");
}

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
  pickIndex: (items: string[]) => Promise<number | null | undefined>,
  getTerminalWidth: () => number,
): Promise<void> {
  const prompts = listPrompts(store);
  if (prompts.length === 0) {
    notify("No yanked prompts stored", "warning");
    return;
  }

  // Show most recent first. Each item gets its lines wrapped at the available
  // terminal width with a hanging indent under the number gutter, and is
  // capped at MAX_LIST_ITEM_LINES (the rest collapsed into "[N more lines]").
  const width = getTerminalWidth();
  const reversed = [...prompts].reverse();
  const items = reversed.map((p, i) => formatListItem(p.text, i + 1, width));

  const displayIndex = await pickIndex(items);
  if (displayIndex == null) return;
  // reversed[displayIndex] corresponds to prompts[prompts.length - 1 - displayIndex]
  const index = prompts.length - 1 - displayIndex;

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

function defaultGetTerminalWidth(): number {
  return process.stdout.columns ?? 80;
}

/**
 * Build the list view used by `/yanked list`. Renders a header with the title
 * and our own legend ("Enter pop" instead of the framework default "Enter
 * select"), then the items as multi-line entries with the cursor-highlighted
 * row in the accent color.
 *
 * `done(index)` is called with the 0-based display index when the user picks
 * an item, or `undefined` if they cancel.
 */
export function createYankedListView(
  tui: { requestRender(): void },
  theme: ListViewTheme,
  items: string[],
  done: (value: number | undefined) => void,
): Component {
  let cursor = 0;
  const text = new Text("", 1, 0);

  const TITLE = "Yanked prompts";
  const LEGEND = "↑/↓ navigate  Enter pop  Esc cancel";

  const rebuild = () => {
    const lines: string[] = [
      theme.bold(theme.fg("accent", TITLE)),
      theme.fg("dim", LEGEND),
      "",
    ];
    for (let i = 0; i < items.length; i++) {
      const itemLines = items[i].split("\n");
      const isSelected = i === cursor;
      const cursorPrefix = isSelected ? theme.fg("accent", "▸ ") : "  ";
      const continuationPrefix = "  ";
      for (let li = 0; li < itemLines.length; li++) {
        const linePrefix = li === 0 ? cursorPrefix : continuationPrefix;
        const body = isSelected
          ? theme.fg("accent", itemLines[li])
          : itemLines[li];
        lines.push(linePrefix + body);
      }
    }
    text.setText(lines.join("\n"));
  };

  rebuild();

  return {
    render: (width: number) => text.render(width),
    invalidate: () => text.invalidate(),
    handleInput: (data: string) => {
      if (matchesKey(data, Key.escape)) {
        done(undefined);
        return;
      }
      if (matchesKey(data, Key.enter)) {
        done(cursor);
        return;
      }
      if (matchesKey(data, Key.up)) {
        cursor = cursor === 0 ? items.length - 1 : cursor - 1;
        rebuild();
        tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.down)) {
        cursor = cursor === items.length - 1 ? 0 : cursor + 1;
        rebuild();
        tui.requestRender();
        return;
      }
    },
  };
}

export default function (pi: ExtensionAPI, deps: YankedDeps = {}) {
  const store =
    deps.store ??
    (deps.storePath ? createFileStore(deps.storePath) : createFileStore());
  const copy = deps.copyToClipboard ?? copyToClipboard;

  // Ctrl+Shift+Y: yank the current prompt
  pi.registerShortcut(Key.ctrlShift("y"), {
    description: "Yank (save) the current prompt",
    handler: async (ctx) => {
      yankPrompt(
        store,
        () => ctx.ui.getEditorText(),
        (text) => ctx.ui.setEditorText(text),
        (msg, level) => ctx.ui.notify(msg, level),
        copy,
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
        const pickIndex =
          deps.pickIndex ??
          ((items: string[]) =>
            ctx.ui.custom<number | undefined>((tui, theme, _kb, done) =>
              createYankedListView(tui, theme, items, done),
            ));
        await handleList(
          store,
          () => ctx.ui.getEditorText(),
          (text) => ctx.ui.setEditorText(text),
          (msg, level) => ctx.ui.notify(msg, level),
          pickIndex,
          () => (deps.getTerminalWidth ?? defaultGetTerminalWidth)(),
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
