import { describe, it, expect, vi } from "vitest";
import { yankPrompt, handlePop, handleList } from "./index.ts";
import { pushPrompt, type StoreIO, type YankedPrompt } from "./store.ts";

// ── Helpers ─────────────────────────────────────────────────────────

function memStore(initial: YankedPrompt[] = []): StoreIO {
  let data = [...initial];
  return {
    read: () => [...data],
    write: (prompts) => {
      data = [...prompts];
    },
  };
}

function makePrompt(text: string, timestamp = Date.now()): YankedPrompt {
  return { text, timestamp };
}

// ── yankPrompt ──────────────────────────────────────────────────────

describe("yankPrompt", () => {
  it("does nothing when the editor is empty", () => {
    const store = memStore();
    const notify = vi.fn();
    const setEditorText = vi.fn();
    const copy = vi.fn();

    yankPrompt(store, () => "", setEditorText, notify, copy);

    expect(notify).toHaveBeenCalledWith(
      "Nothing to yank — editor is empty",
      "warning",
    );
    expect(setEditorText).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    expect(store.read()).toHaveLength(0);
  });

  it("does nothing when the editor is only whitespace", () => {
    const store = memStore();
    const notify = vi.fn();
    const setEditorText = vi.fn();
    const copy = vi.fn();

    yankPrompt(store, () => "   \n  ", setEditorText, notify, copy);

    expect(notify).toHaveBeenCalledWith(
      "Nothing to yank — editor is empty",
      "warning",
    );
    expect(store.read()).toHaveLength(0);
  });

  it("yanks the prompt: saves to store, clears editor, copies to clipboard", () => {
    const store = memStore();
    const notify = vi.fn();
    const setEditorText = vi.fn();
    const copy = vi.fn();

    yankPrompt(store, () => "my prompt text", setEditorText, notify, copy);

    // Saved to store
    const prompts = store.read();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toBe("my prompt text");

    // Editor cleared
    expect(setEditorText).toHaveBeenCalledWith("");

    // Copied to clipboard
    expect(copy).toHaveBeenCalledWith("my prompt text");

    // Success notification
    expect(notify).toHaveBeenCalledWith(
      "Prompt yanked and copied to clipboard",
      "info",
    );
  });

  it("still saves to store when clipboard copy fails", () => {
    const store = memStore();
    const notify = vi.fn();
    const setEditorText = vi.fn();
    const copy = vi.fn().mockImplementation(() => {
      throw new Error("pbcopy not found");
    });

    yankPrompt(store, () => "my prompt", setEditorText, notify, copy);

    // Saved to store
    expect(store.read()).toHaveLength(1);
    // Editor cleared
    expect(setEditorText).toHaveBeenCalledWith("");
    // Warning about clipboard
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("clipboard copy failed"),
      "warning",
    );
  });

  it("does not clear the editor when store write fails", () => {
    const store = memStore();
    // Make the store write throw
    store.write = () => {
      throw new Error("disk full");
    };
    const notify = vi.fn();
    const setEditorText = vi.fn();
    const copy = vi.fn();

    yankPrompt(store, () => "important text", setEditorText, notify, copy);

    // Editor should NOT be cleared
    expect(setEditorText).not.toHaveBeenCalled();
    // Clipboard should NOT be called
    expect(copy).not.toHaveBeenCalled();
    // Error notification
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Failed to save prompt"),
      "error",
    );
  });
});

// ── handlePop ───────────────────────────────────────────────────────

describe("handlePop", () => {
  it("reports an error when the editor is not empty", () => {
    const store = memStore([makePrompt("saved")]);
    const notify = vi.fn();
    const setEditorText = vi.fn();

    handlePop(store, () => "existing text", setEditorText, notify);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("editor is not empty"),
      "error",
    );
    expect(setEditorText).not.toHaveBeenCalled();
    // Prompt should still be in store
    expect(store.read()).toHaveLength(1);
  });

  it("reports a warning when no prompts are stored", () => {
    const store = memStore();
    const notify = vi.fn();
    const setEditorText = vi.fn();

    handlePop(store, () => "", setEditorText, notify);

    expect(notify).toHaveBeenCalledWith("No yanked prompts to pop", "warning");
    expect(setEditorText).not.toHaveBeenCalled();
  });

  it("pops the most recent prompt into the editor", () => {
    const store = memStore();
    pushPrompt(store, "first");
    pushPrompt(store, "second");
    const notify = vi.fn();
    const setEditorText = vi.fn();

    handlePop(store, () => "", setEditorText, notify);

    expect(setEditorText).toHaveBeenCalledWith("second");
    expect(notify).toHaveBeenCalledWith(
      "Popped yanked prompt into editor",
      "info",
    );
    // Only "first" should remain
    expect(store.read()).toHaveLength(1);
    expect(store.read()[0].text).toBe("first");
  });

  it("allows popping when editor has only whitespace", () => {
    const store = memStore();
    pushPrompt(store, "my prompt");
    const setEditorText = vi.fn();

    handlePop(store, () => "   ", setEditorText, vi.fn());

    expect(setEditorText).toHaveBeenCalledWith("my prompt");
  });

  it("keeps prompt in store if store removal fails after editor is set", () => {
    const store = memStore();
    pushPrompt(store, "precious");
    const notify = vi.fn();
    const setEditorText = vi.fn();
    // Make writes fail (simulating disk error on popPrompt's write)
    store.write = () => {
      throw new Error("disk error");
    };

    handlePop(store, () => "", setEditorText, notify);

    // Editor should still have the text (set before removal)
    expect(setEditorText).toHaveBeenCalledWith("precious");
    // Error reported
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("failed to update store"),
      "error",
    );
  });
});

// ── handleList ──────────────────────────────────────────────────────

describe("handleList", () => {
  it("reports a warning when no prompts are stored", async () => {
    const store = memStore();
    const notify = vi.fn();
    const select = vi.fn();

    await handleList(store, () => "", vi.fn(), notify, select);

    expect(notify).toHaveBeenCalledWith("No yanked prompts stored", "warning");
    expect(select).not.toHaveBeenCalled();
  });

  it("shows a select dialog with most recent prompt first", async () => {
    const store = memStore();
    pushPrompt(store, "alpha");
    pushPrompt(store, "beta");
    const select = vi.fn().mockResolvedValue(null);

    await handleList(store, () => "", vi.fn(), vi.fn(), select);

    expect(select).toHaveBeenCalledWith("Yanked prompts (Enter to pop)", [
      "1. beta",
      "2. alpha",
    ]);
  });

  it("truncates long prompts in the list", async () => {
    const store = memStore();
    const longText = "a".repeat(100);
    pushPrompt(store, longText);
    const select = vi.fn().mockResolvedValue(null);

    await handleList(store, () => "", vi.fn(), vi.fn(), select);

    const items = select.mock.calls[0][1] as string[];
    expect(items[0].length).toBeLessThan(70);
    expect(items[0]).toContain("...");
  });

  it("replaces newlines with ↵ in the list", async () => {
    const store = memStore();
    pushPrompt(store, "line1\nline2");
    const select = vi.fn().mockResolvedValue(null);

    await handleList(store, () => "", vi.fn(), vi.fn(), select);

    const items = select.mock.calls[0][1] as string[];
    expect(items[0]).toContain("↵");
    expect(items[0]).not.toContain("\n");
  });

  it("does nothing when user cancels the selection", async () => {
    const store = memStore();
    pushPrompt(store, "alpha");
    const setEditorText = vi.fn();
    const select = vi.fn().mockResolvedValue(null);

    await handleList(store, () => "", setEditorText, vi.fn(), select);

    expect(setEditorText).not.toHaveBeenCalled();
    // Prompt should still be in store
    expect(store.read()).toHaveLength(1);
  });

  it("pops the selected prompt into the editor", async () => {
    const store = memStore();
    pushPrompt(store, "alpha");
    pushPrompt(store, "beta");
    pushPrompt(store, "gamma");
    const setEditorText = vi.fn();
    const notify = vi.fn();
    // User selects "2. beta" — shown as item 2 (second newest)
    const select = vi.fn().mockResolvedValue("2. beta");

    await handleList(store, () => "", setEditorText, notify, select);

    expect(setEditorText).toHaveBeenCalledWith("beta");
    expect(notify).toHaveBeenCalledWith(
      "Popped yanked prompt into editor",
      "info",
    );
    // "beta" removed, "alpha" and "gamma" remain
    const remaining = store.read();
    expect(remaining).toHaveLength(2);
    expect(remaining.map((p) => p.text)).toEqual(["alpha", "gamma"]);
  });

  it("re-inserts prompt into store if setEditorText fails after removal", async () => {
    const store = memStore();
    pushPrompt(store, "alpha");
    pushPrompt(store, "beta");
    const notify = vi.fn();
    // setEditorText will throw
    const setEditorText = vi.fn().mockImplementation(() => {
      throw new Error("editor broke");
    });
    // User selects "1. beta" (most recent, shown first)
    const select = vi.fn().mockResolvedValue("1. beta");

    await handleList(store, () => "", setEditorText, notify, select);

    // Prompt should be preserved in store (re-inserted)
    const remaining = store.read();
    expect(remaining.some((p) => p.text === "beta")).toBe(true);
    // Error reported
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Prompt preserved in store"),
      "error",
    );
  });

  it("reports an error when editor is not empty at selection time", async () => {
    const store = memStore();
    pushPrompt(store, "alpha");
    const notify = vi.fn();
    const setEditorText = vi.fn();
    let editorText = "";

    const select = vi.fn().mockImplementation(async () => {
      // Simulate user typing while the dialog is open
      editorText = "typed something";
      return "1. alpha";
    });

    await handleList(store, () => editorText, setEditorText, notify, select);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("editor is not empty"),
      "error",
    );
    expect(setEditorText).not.toHaveBeenCalled();
    // Prompt should still be in store
    expect(store.read()).toHaveLength(1);
  });
});
