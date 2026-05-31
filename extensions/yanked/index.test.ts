import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import yankedExtension, { createYankedListView } from "./index.ts";
import type { YankedDeps } from "./index.ts";
import { createFileStore } from "./store.ts";
import type { StoreIO, YankedPrompt } from "./store.ts";

interface RegisteredCommand {
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) => unknown[] | null | Promise<unknown[] | null>;
}

interface RegisteredShortcut {
  description?: string;
  handler: (ctx: ExtensionContext) => Promise<void> | void;
}

interface NotifyCall {
  message: string;
  level: "info" | "warning" | "error";
}

interface PiHarness {
  pi: ExtensionAPI;
  commands: Map<string, RegisteredCommand>;
  shortcuts: Map<string, RegisteredShortcut>;
  editor: { text: string };
  /** Hook to throw or otherwise intercept setEditorText. */
  onSetEditorText: { fn?: (text: string) => void };
  notify: ReturnType<typeof vi.fn>;
  pickIndex: ReturnType<
    typeof vi.fn<
      (
        items: string[],
      ) => Promise<{ index: number; action: "pop" | "peek" } | undefined>
    >
  >;
  notifyCalls: () => NotifyCall[];
  invokeShortcut: (key: string) => Promise<void>;
  invokeCommand: (name: string, args?: string) => Promise<void>;
  getCompletions: (prefix: string) => Promise<unknown[]>;
}

function createPiHarness(): PiHarness {
  const commands = new Map<string, RegisteredCommand>();
  const shortcuts = new Map<string, RegisteredShortcut>();
  const editor = { text: "" };
  const notify = vi.fn<(msg: string, level?: NotifyCall["level"]) => void>();
  const pickIndex =
    vi.fn<
      (
        items: string[],
      ) => Promise<{ index: number; action: "pop" | "peek" } | undefined>
    >();

  const onSetEditorText: { fn?: (text: string) => void } = {};
  const ui = {
    getEditorText: () => editor.text,
    setEditorText: (text: string) => {
      if (onSetEditorText.fn) onSetEditorText.fn(text);
      editor.text = text;
    },
    notify: (msg: string, level?: NotifyCall["level"]) =>
      notify(msg, level ?? "info"),
  } as unknown as ExtensionContext["ui"];

  const ctx = { ui } as unknown as ExtensionCommandContext;

  const pi = {
    registerShortcut: (key: string, options: RegisteredShortcut) => {
      shortcuts.set(key, options);
    },
    registerCommand: (name: string, options: RegisteredCommand) => {
      commands.set(name, options);
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    commands,
    shortcuts,
    editor,
    onSetEditorText,
    notify,
    pickIndex,
    notifyCalls: () =>
      notify.mock.calls.map(([message, level]) => ({
        message,
        level: (level ?? "info") as NotifyCall["level"],
      })),
    invokeShortcut: async (key: string) => {
      const shortcut = shortcuts.get(key);
      if (!shortcut) throw new Error(`No shortcut registered for ${key}`);
      await shortcut.handler(ctx);
    },
    invokeCommand: async (name: string, args = "") => {
      const command = commands.get(name);
      if (!command) throw new Error(`No command registered: ${name}`);
      await command.handler(args, ctx);
    },
    getCompletions: async (prefix: string) => {
      const command = commands.get("yanked");
      if (!command?.getArgumentCompletions)
        throw new Error("yanked command has no completions");
      const result = await command.getArgumentCompletions(prefix);
      return result ?? [];
    },
  };
}

interface SetupOptions {
  /** Override the store entirely (used for failure-injection tests). */
  store?: StoreIO;
  /** Override the clipboard copy function. */
  copy?: (text: string) => void;
  /** Pre-seed the on-disk store before the extension reads it. */
  initial?: YankedPrompt[];
  /** Override the reported terminal width used to format list items. */
  terminalWidth?: number;
}

/**
 * Build the extension under test against a real file-backed store rooted at
 * a freshly-created temp directory. The returned object is `using`-disposable
 * so the temp dir is removed automatically at scope exit, even on failure.
 */
function setUpHarness(options: SetupOptions = {}) {
  const harness = createPiHarness();
  const tempDir = mkdtempSync(join(tmpdir(), "yanked-test-"));

  if (options.initial && options.initial.length > 0) {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, "prompts.json"),
      JSON.stringify(options.initial, null, 2),
      "utf-8",
    );
  }

  const copy = options.copy ?? vi.fn();
  // Failure-injection tests pass an explicit StoreIO. Everything else uses
  // a real file-backed store rooted at the temp directory.
  const baseDeps: YankedDeps = options.store
    ? { store: options.store, copyToClipboard: copy }
    : { storePath: tempDir, copyToClipboard: copy };
  const withWidth: YankedDeps =
    options.terminalWidth !== undefined
      ? { ...baseDeps, getTerminalWidth: () => options.terminalWidth! }
      : baseDeps;
  // Tests inject the index picker directly so we never have to render a real
  // TUI selector — they just resolve the mock with a display index.
  const deps: YankedDeps = {
    ...withWidth,
    pickIndex: (items: string[]) => harness.pickIndex(items),
  };
  yankedExtension(harness.pi, deps);

  // Reads from `harness.store` should reflect what the extension is actually
  // using — the injected mock for failure tests, otherwise a fresh reader
  // pointed at the same on-disk directory.
  const store: StoreIO = options.store ?? createFileStore(tempDir);

  return {
    ...harness,
    store,
    copy,
    tempDir,
    [Symbol.dispose]() {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

const yankShortcutKey = Key.ctrlShift("y");

describe("yanked extension registration", () => {
  it("registers the Ctrl+Shift+Y shortcut and the /yanked command", () => {
    using harness = setUpHarness();

    expect(harness.shortcuts.has(yankShortcutKey)).toBe(true);
    expect(harness.shortcuts.get(yankShortcutKey)?.description).toMatch(
      /yank/i,
    );

    expect(harness.commands.has("yanked")).toBe(true);
    expect(harness.commands.get("yanked")?.description).toMatch(/pop|list/i);
  });

  it("offers `pop` and `list` argument completions filtered by prefix", async () => {
    using harness = setUpHarness();

    const all = await harness.getCompletions("");
    expect(all).toEqual([
      { value: "pop", label: "pop" },
      { value: "list", label: "list" },
    ]);

    const filtered = await harness.getCompletions("p");
    expect(filtered).toEqual([{ value: "pop", label: "pop" }]);
  });
});

describe("Ctrl+Shift+Y yank shortcut", () => {
  it("warns and does nothing when the editor is empty", async () => {
    using harness = setUpHarness();
    harness.editor.text = "";

    await harness.invokeShortcut(yankShortcutKey);

    expect(harness.notifyCalls()).toEqual([
      { message: "Nothing to yank — editor is empty", level: "warning" },
    ]);
    expect(harness.editor.text).toBe("");
    expect(harness.copy).not.toHaveBeenCalled();
    expect(harness.store.read()).toHaveLength(0);
  });

  it("warns when the editor contains only whitespace", async () => {
    using harness = setUpHarness();
    harness.editor.text = "   \n  ";

    await harness.invokeShortcut(yankShortcutKey);

    expect(harness.notifyCalls()).toEqual([
      { message: "Nothing to yank — editor is empty", level: "warning" },
    ]);
    expect(harness.store.read()).toHaveLength(0);
  });

  it("saves the prompt, clears the editor, and copies to clipboard", async () => {
    using harness = setUpHarness();
    harness.editor.text = "my prompt text";

    await harness.invokeShortcut(yankShortcutKey);

    expect(harness.editor.text).toBe("");
    expect(harness.copy).toHaveBeenCalledWith("my prompt text");

    const stored = harness.store.read();
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe("my prompt text");
    expect(stored[0].timestamp).toBeGreaterThan(0);

    expect(harness.notifyCalls()).toEqual([
      { message: "Prompt yanked and copied to clipboard", level: "info" },
    ]);
  });

  it("persists the saved prompt to disk so a fresh extension instance can read it", async () => {
    using harness = setUpHarness();
    harness.editor.text = "durable prompt";

    await harness.invokeShortcut(yankShortcutKey);

    // Build a brand-new extension instance pointed at the same temp dir,
    // bypassing the in-memory state. It must see the persisted prompt.
    const freshStore = createFileStore(harness.tempDir);
    expect(freshStore.read().map((p) => p.text)).toEqual(["durable prompt"]);
  });

  it("still saves to the store when clipboard copy fails", async () => {
    const copy = vi.fn(() => {
      throw new Error("pbcopy not found");
    });
    using harness = setUpHarness({ copy });
    harness.editor.text = "my prompt";

    await harness.invokeShortcut(yankShortcutKey);

    expect(harness.store.read()).toHaveLength(1);
    expect(harness.editor.text).toBe("");

    const calls = harness.notifyCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("warning");
    expect(calls[0].message).toContain("clipboard copy failed");
    expect(calls[0].message).toContain("pbcopy not found");
  });

  it("does not clear the editor when the store write fails", async () => {
    const failingStore: StoreIO = {
      read: () => [],
      write: () => {
        throw new Error("disk full");
      },
    };
    using harness = setUpHarness({ store: failingStore });
    harness.editor.text = "important text";

    await harness.invokeShortcut(yankShortcutKey);

    expect(harness.editor.text).toBe("important text");
    expect(harness.copy).not.toHaveBeenCalled();

    const calls = harness.notifyCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("error");
    expect(calls[0].message).toContain("Failed to save prompt");
    expect(calls[0].message).toContain("disk full");
  });

  it("ejects the oldest prompt once the store reaches capacity", async () => {
    // Pre-fill 10 prompts (the storage cap), then yank an 11th.
    const initial: YankedPrompt[] = Array.from({ length: 10 }, (_, i) => ({
      text: `old-${i}`,
      timestamp: i + 1,
    }));
    using harness = setUpHarness({ initial });

    harness.editor.text = "newest";
    await harness.invokeShortcut(yankShortcutKey);

    const stored = harness.store.read();
    expect(stored).toHaveLength(10);
    expect(stored[0].text).toBe("old-1"); // old-0 ejected
    expect(stored[stored.length - 1].text).toBe("newest");
  });

  it("recovers gracefully when the on-disk store contains malformed JSON", async () => {
    using harness = setUpHarness();
    // Corrupt the store file before the extension reads it.
    writeFileSync(
      join(harness.tempDir, "prompts.json"),
      "{ not valid json",
      "utf-8",
    );
    harness.editor.text = "after corruption";

    await harness.invokeShortcut(yankShortcutKey);

    // The corrupt file is treated as empty — the new prompt is the only one.
    expect(harness.store.read().map((p) => p.text)).toEqual([
      "after corruption",
    ]);
    expect(harness.editor.text).toBe("");
  });
});

describe("/yanked usage", () => {
  it("shows a usage message when invoked with no arguments", async () => {
    using harness = setUpHarness();

    await harness.invokeCommand("yanked", "");

    const calls = harness.notifyCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("warning");
    expect(calls[0].message).toContain("Usage:");
    expect(calls[0].message).toContain("pop");
    expect(calls[0].message).toContain("list");
  });

  it("shows a usage message for an unknown subcommand", async () => {
    using harness = setUpHarness();

    await harness.invokeCommand("yanked", "wat");

    const calls = harness.notifyCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("warning");
    expect(calls[0].message).toContain("Usage:");
  });
});

describe("/yanked pop", () => {
  it("warns when no prompts are stored", async () => {
    using harness = setUpHarness();

    await harness.invokeCommand("yanked", "pop");

    expect(harness.notifyCalls()).toEqual([
      { message: "No yanked prompts to pop", level: "warning" },
    ]);
    expect(harness.editor.text).toBe("");
  });

  it("refuses to pop when the editor is not empty", async () => {
    using harness = setUpHarness({
      initial: [{ text: "saved", timestamp: 1 }],
    });
    harness.editor.text = "existing text";

    await harness.invokeCommand("yanked", "pop");

    const calls = harness.notifyCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("error");
    expect(calls[0].message).toContain("editor is not empty");
    expect(harness.editor.text).toBe("existing text");
    expect(harness.store.read()).toHaveLength(1);
  });

  it("pops the most recently yanked prompt back into the editor", async () => {
    using harness = setUpHarness();
    // Use the public yank path to seed two prompts.
    harness.editor.text = "first";
    await harness.invokeShortcut(yankShortcutKey);
    harness.editor.text = "second";
    await harness.invokeShortcut(yankShortcutKey);

    harness.notify.mockClear();
    harness.editor.text = "";

    await harness.invokeCommand("yanked", "pop");

    expect(harness.editor.text).toBe("second");
    expect(harness.notifyCalls()).toEqual([
      { message: "Popped yanked prompt into editor", level: "info" },
    ]);
    const remaining = harness.store.read();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].text).toBe("first");
  });

  it("pops successfully when the editor contains only whitespace", async () => {
    using harness = setUpHarness({
      initial: [{ text: "my prompt", timestamp: 1 }],
    });
    harness.editor.text = "   ";

    await harness.invokeCommand("yanked", "pop");

    expect(harness.editor.text).toBe("my prompt");
    expect(harness.store.read()).toHaveLength(0);
  });

  it("keeps the prompt in the editor when the store write fails", async () => {
    const data: YankedPrompt[] = [{ text: "precious", timestamp: 1 }];
    const store: StoreIO = {
      read: () => [...data],
      write: () => {
        // The popPrompt write fails — the editor was already filled.
        throw new Error("disk error");
      },
    };
    using harness = setUpHarness({ store });

    await harness.invokeCommand("yanked", "pop");

    expect(harness.editor.text).toBe("precious");
    // The store still has the prompt because removal failed.
    expect(harness.store.read()).toHaveLength(1);

    const calls = harness.notifyCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("error");
    expect(calls[0].message).toContain("failed to update store");
    expect(calls[0].message).toContain("disk error");
  });
});

describe("/yanked list", () => {
  it("warns when no prompts are stored", async () => {
    using harness = setUpHarness();

    await harness.invokeCommand("yanked", "list");

    expect(harness.notifyCalls()).toEqual([
      { message: "No yanked prompts stored", level: "warning" },
    ]);
    expect(harness.pickIndex).not.toHaveBeenCalled();
  });

  it("shows the most recently yanked prompt first", async () => {
    using harness = setUpHarness();
    harness.editor.text = "alpha";
    await harness.invokeShortcut(yankShortcutKey);
    harness.editor.text = "beta";
    await harness.invokeShortcut(yankShortcutKey);
    harness.pickIndex.mockResolvedValue(undefined);

    await harness.invokeCommand("yanked", "list");

    expect(harness.pickIndex).toHaveBeenCalledWith(["1. beta", "2. alpha"]);
  });

  it("preserves newlines and indents continuation lines under the number gutter", async () => {
    using harness = setUpHarness({
      initial: [{ text: "line1\nline2\nline3", timestamp: 1 }],
      terminalWidth: 200,
    });
    harness.pickIndex.mockResolvedValue(undefined);

    await harness.invokeCommand("yanked", "list");

    const items = harness.pickIndex.mock.calls[0][0];
    // Continuations are indented by 3 spaces — the visible width of "1. " —
    // so they line up under the prompt text. The view itself prepends a
    // 2-column cursor prefix ("▸ "/"  ") to every rendered line so the
    // first-line gutter and continuation indent stay aligned visually.
    expect(items[0]).toBe("1. line1\n   line2\n   line3");
  });

  it("wraps long single-line prompts with a hanging indent at the number gutter", async () => {
    // Available content width = terminalWidth - 2 (Text paddingX)
    //   - 2 (cursor prefix) - 3 ("1. " gutter) = 8 here.
    using harness = setUpHarness({
      initial: [{ text: "abcdefgh12345678WXYZ", timestamp: 1 }],
      terminalWidth: 15,
    });
    harness.pickIndex.mockResolvedValue(undefined);

    await harness.invokeCommand("yanked", "list");

    const items = harness.pickIndex.mock.calls[0][0];
    const lines = items[0].split("\n");
    // First line has the "N. " prefix, continuations are indented by 3 spaces.
    expect(lines[0]).toBe("1. abcdefgh");
    for (const cont of lines.slice(1)) {
      expect(cont.startsWith("   ")).toBe(true);
    }
    // Reassembling the unindented content should give the original prompt.
    const rejoined =
      lines[0].slice("1. ".length) +
      lines
        .slice(1)
        .map((l) => l.slice(3))
        .join("");
    expect(rejoined).toBe("abcdefgh12345678WXYZ");
  });

  it("truncates the displayed item to 5 lines, replacing the last with [N more lines]", async () => {
    const text = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    using harness = setUpHarness({
      initial: [{ text, timestamp: 1 }],
      terminalWidth: 200,
    });
    harness.pickIndex.mockResolvedValue(undefined);

    await harness.invokeCommand("yanked", "list");

    const items = harness.pickIndex.mock.calls[0][0];
    const lines = items[0].split("\n");
    // Exactly 5 visible lines, last one is the "[N more lines]" indicator.
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("1. a");
    expect(lines[1]).toBe("   b");
    expect(lines[2]).toBe("   c");
    expect(lines[3]).toBe("   d");
    // 8 input lines, 4 shown so far — 4 hidden.
    expect(lines[4]).toBe("   [4 more lines]");
  });

  it("does not truncate or indent the prompt when popping it into the editor", async () => {
    const text = ["line1", "line2", "line3", "line4", "line5", "line6"].join(
      "\n",
    );
    using harness = setUpHarness({
      initial: [{ text, timestamp: 1 }],
      terminalWidth: 15,
    });
    // The displayed item is multi-line; user selects the first one.
    harness.pickIndex.mockResolvedValue({ index: 0, action: "pop" });

    await harness.invokeCommand("yanked", "list");

    // The original prompt is restored verbatim — no indentation, no truncation.
    expect(harness.editor.text).toBe(text);
  });

  it("does nothing when the user cancels the selection", async () => {
    using harness = setUpHarness({
      initial: [{ text: "alpha", timestamp: 1 }],
    });
    harness.pickIndex.mockResolvedValue(undefined);

    await harness.invokeCommand("yanked", "list");

    expect(harness.editor.text).toBe("");
    expect(harness.store.read()).toHaveLength(1);
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("pops the selected prompt into the editor", async () => {
    using harness = setUpHarness({
      initial: [
        { text: "alpha", timestamp: 1 },
        { text: "beta", timestamp: 2 },
        { text: "gamma", timestamp: 3 },
      ],
    });
    // Items shown: ["1. gamma", "2. beta", "3. alpha"] — user picks beta
    // (display index 1).
    harness.pickIndex.mockResolvedValue({ index: 1, action: "pop" });

    await harness.invokeCommand("yanked", "list");

    expect(harness.editor.text).toBe("beta");
    expect(harness.notifyCalls()).toEqual([
      { message: "Popped yanked prompt into editor", level: "info" },
    ]);
    expect(harness.store.read().map((p) => p.text)).toEqual(["alpha", "gamma"]);
  });

  it("re-inserts the prompt into the store when filling the editor fails after removal", async () => {
    using harness = setUpHarness({
      initial: [
        { text: "alpha", timestamp: 1 },
        { text: "beta", timestamp: 2 },
      ],
    });
    // User picks the most-recent prompt (display index 0).
    harness.pickIndex.mockResolvedValue({ index: 0, action: "pop" });
    // Make setEditorText fail — only after the prompt has been removed.
    harness.onSetEditorText.fn = () => {
      throw new Error("editor broke");
    };

    await harness.invokeCommand("yanked", "list");

    // The prompt must be preserved in the store.
    expect(harness.store.read().some((p) => p.text === "beta")).toBe(true);
    const calls = harness.notifyCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("error");
    expect(calls[0].message).toContain("Prompt preserved in store");
  });

  it("reports a critical error when the prompt cannot be re-inserted into the store", async () => {
    let writeCount = 0;
    let data: YankedPrompt[] = [{ text: "alpha", timestamp: 1 }];
    const store: StoreIO = {
      read: () => [...data],
      write: (prompts) => {
        writeCount += 1;
        if (writeCount === 1) {
          // First write: the removePromptAt write — succeed.
          data = [...prompts];
          return;
        }
        // Second write: the re-insert pushPrompt write — fail.
        throw new Error("disk gone");
      },
    };
    using harness = setUpHarness({ store });
    harness.pickIndex.mockResolvedValue({ index: 0, action: "pop" });
    harness.onSetEditorText.fn = () => {
      throw new Error("editor broke");
    };

    await harness.invokeCommand("yanked", "list");

    const calls = harness.notifyCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("error");
    expect(calls[0].message).toContain("CRITICAL");
    expect(calls[0].message).toContain("alpha");
    expect(calls[0].message).toContain("disk gone");
  });

  it("reports an error when the selected display index no longer maps to a stored prompt", async () => {
    using harness = setUpHarness({
      initial: [{ text: "alpha", timestamp: 1 }],
    });
    // The selector returns a display index that's out of range — e.g. the user
    // somehow selects an item that's been removed concurrently.
    harness.pickIndex.mockResolvedValue({ index: 99, action: "pop" });

    await harness.invokeCommand("yanked", "list");

    const calls = harness.notifyCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("error");
    expect(calls[0].message).toContain("no longer exists");
    expect(harness.editor.text).toBe("");
    expect(harness.store.read()).toHaveLength(1);
  });

  it("peeks the selected prompt into the editor without removing it from the store", async () => {
    using harness = setUpHarness({
      initial: [
        { text: "alpha", timestamp: 1 },
        { text: "beta", timestamp: 2 },
        { text: "gamma", timestamp: 3 },
      ],
    });
    // Items shown: ["1. gamma", "2. beta", "3. alpha"] — user peeks at beta.
    harness.pickIndex.mockResolvedValue({ index: 1, action: "peek" });

    await harness.invokeCommand("yanked", "list");

    expect(harness.editor.text).toBe("beta");
    // Store is untouched — all three prompts remain.
    expect(harness.store.read().map((p) => p.text)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(harness.notifyCalls()).toEqual([
      { message: "Peeked yanked prompt into editor", level: "info" },
    ]);
  });

  it("refuses to peek and preserves the prompt when editor was filled while the dialog was open", async () => {
    using harness = setUpHarness({
      initial: [{ text: "alpha", timestamp: 1 }],
    });
    harness.pickIndex.mockImplementation(async () => {
      harness.editor.text = "typed something";
      return { index: 0, action: "peek" };
    });

    await harness.invokeCommand("yanked", "list");

    const calls = harness.notifyCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("error");
    expect(calls[0].message).toContain("editor is not empty");
    expect(harness.editor.text).toBe("typed something");
    expect(harness.store.read()).toHaveLength(1);
  });

  it("refuses to pop and preserves the prompt when editor was filled while the dialog was open", async () => {
    using harness = setUpHarness({
      initial: [{ text: "alpha", timestamp: 1 }],
    });
    harness.pickIndex.mockImplementation(async () => {
      // Simulate the user typing while the dialog is open.
      harness.editor.text = "typed something";
      return { index: 0, action: "pop" };
    });

    await harness.invokeCommand("yanked", "list");

    const calls = harness.notifyCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("error");
    expect(calls[0].message).toContain("editor is not empty");
    expect(harness.editor.text).toBe("typed something");
    expect(harness.store.read()).toHaveLength(1);
  });
});

describe("createYankedListView", () => {
  /** Stub theme — the view never inspects styled output, only state. */
  const theme = {
    fg: (_color: "accent" | "dim" | "text", text: string) => text,
    bold: (text: string) => text,
  };

  function makeView(items: string[]) {
    const requestRender = vi.fn();
    const tui = { requestRender };
    const done =
      vi.fn<
        (value: { index: number; action: "pop" | "peek" } | undefined) => void
      >();
    const view = createYankedListView(tui, theme, items, done);
    return { view, done, requestRender };
  }

  it("resolves with a pop action at the current cursor index when Enter is pressed", () => {
    const { view, done } = makeView(["1. a", "2. b", "3. c"]);

    view.handleInput?.("\r");

    expect(done).toHaveBeenCalledWith({ index: 0, action: "pop" });
  });

  it("resolves with a peek action at the current cursor index when 'p' is pressed", () => {
    const { view, done } = makeView(["1. a", "2. b", "3. c"]);

    view.handleInput?.("\x1b[B"); // move cursor to index 1
    view.handleInput?.("p");

    expect(done).toHaveBeenCalledWith({ index: 1, action: "peek" });
  });

  it("resolves with a peek action when 'p' arrives as a Kitty CSI-u sequence", () => {
    const { view, done } = makeView(["1. a", "2. b"]);

    // Under the Kitty keyboard protocol, plain 'p' is reported as CSI-u
    // (codepoint 112 — "p"). The view must still recognize it.
    view.handleInput?.("\x1b[112u");

    expect(done).toHaveBeenCalledWith({ index: 0, action: "peek" });
  });

  it("includes a 'p peek' hint in the rendered legend", () => {
    const { view } = makeView(["1. a"]);

    const rendered = view.render(80).join("\n");

    expect(rendered).toMatch(/p\s*peek/i);
  });

  it("renders a ▸ cursor next to the selected item and ‘ ’ next to the others", () => {
    const { view } = makeView(["1. a", "2. b\n   wrap", "3. c"]);

    // Move the cursor to item index 1 (the multi-line one).
    view.handleInput?.("\x1b[B");

    const rendered = view.render(80);
    // Text pads each line out to the full width with leading paddingX and
    // trailing right-pad. Strip both so we can assert on item content alone.
    const lines = rendered.map((l) => l.replace(/^ /, "").replace(/ +$/, ""));

    // First two rendered lines are the title + legend (we don’t assert them
    // — they’re static config). After the blank separator, the items begin.
    const firstItemLine = lines.findIndex((l) => l.endsWith("1. a"));
    expect(firstItemLine).toBeGreaterThan(-1);

    expect(lines[firstItemLine]).toBe("  1. a"); // not selected
    expect(lines[firstItemLine + 1]).toBe("▸ 2. b"); // selected first line
    expect(lines[firstItemLine + 2]).toBe("     wrap"); // selected continuation, no ▸
    expect(lines[firstItemLine + 3]).toBe("  3. c"); // not selected
  });

  it("advances the cursor on Down arrow and resolves with the new index", () => {
    const { view, done, requestRender } = makeView(["1. a", "2. b", "3. c"]);

    view.handleInput?.("\x1b[B"); // down
    view.handleInput?.("\x1b[B"); // down again
    expect(requestRender).toHaveBeenCalledTimes(2);

    view.handleInput?.("\r");
    expect(done).toHaveBeenCalledWith({ index: 2, action: "pop" });
  });

  it("wraps the cursor from the top to the bottom on Up arrow", () => {
    const { view, done } = makeView(["1. a", "2. b", "3. c"]);

    view.handleInput?.("\x1b[A"); // up from index 0
    view.handleInput?.("\r");

    expect(done).toHaveBeenCalledWith({ index: 2, action: "pop" });
  });

  it("wraps the cursor from the bottom to the top on Down arrow", () => {
    const { view, done } = makeView(["1. a", "2. b"]);

    view.handleInput?.("\x1b[B"); // down to index 1
    view.handleInput?.("\x1b[B"); // wrap back to index 0
    view.handleInput?.("\r");

    expect(done).toHaveBeenCalledWith({ index: 0, action: "pop" });
  });

  it("resolves with undefined when Escape is pressed", () => {
    const { view, done } = makeView(["1. a", "2. b"]);

    view.handleInput?.("\x1b");

    expect(done).toHaveBeenCalledWith(undefined);
  });
});

describe("yanked extension persistence", () => {
  it("yanks and pops across multiple shortcut/command invocations", async () => {
    using harness = setUpHarness();

    harness.editor.text = "alpha";
    await harness.invokeShortcut(yankShortcutKey);
    harness.editor.text = "beta";
    await harness.invokeShortcut(yankShortcutKey);
    expect(harness.store.read().map((p) => p.text)).toEqual(["alpha", "beta"]);

    harness.editor.text = "";
    await harness.invokeCommand("yanked", "pop");
    expect(harness.editor.text).toBe("beta");
    expect(harness.store.read().map((p) => p.text)).toEqual(["alpha"]);

    harness.editor.text = "";
    await harness.invokeCommand("yanked", "pop");
    expect(harness.editor.text).toBe("alpha");
    expect(harness.store.read()).toHaveLength(0);
  });
});
