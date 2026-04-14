import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseQueueArgs,
  addCriteriaHeaders,
  formatPromptLines,
  ListState,
  QueueRunner,
  type QueueRunnerCtx,
  createFinishEdit,
  buildEditHeader,
  buildEditContextLines,
  validateKeyName,
  startQueue,
  type StartQueueDeps,
} from "./index.js";

// ── Argument parsing ─────────────────────────────────────────────────

describe("parseQueueArgs", () => {
  it("returns usage when no arguments given", () => {
    expect(parseQueueArgs("")).toEqual({ kind: "usage" });
  });

  it("returns usage for whitespace-only input", () => {
    expect(parseQueueArgs("   ")).toEqual({ kind: "usage" });
  });

  it("parses ':abort' as abort", () => {
    expect(parseQueueArgs(":abort")).toEqual({ kind: "abort" });
  });

  it("trims whitespace around :abort", () => {
    expect(parseQueueArgs("  :abort  ")).toEqual({ kind: "abort" });
  });

  it("parses ':delete my-key' as delete", () => {
    expect(parseQueueArgs(":delete my-key")).toEqual({
      kind: "delete",
      key: "my-key",
    });
  });

  it("trims whitespace around :delete args", () => {
    expect(parseQueueArgs("  :delete   my-key  ")).toEqual({
      kind: "delete",
      key: "my-key",
    });
  });

  it("returns invalid for :delete without a key", () => {
    expect(parseQueueArgs(":delete")).toEqual({
      kind: "invalid",
      reason: expect.stringContaining("key"),
    });
  });

  it("returns invalid for :delete with an invalid key", () => {
    expect(parseQueueArgs(":delete bad/key")).toEqual({
      kind: "invalid",
      reason: expect.any(String),
    });
  });

  it("parses a key name", () => {
    expect(parseQueueArgs("review-and-fix")).toEqual({
      kind: "key",
      key: "review-and-fix",
    });
  });

  it("trims whitespace around key names", () => {
    expect(parseQueueArgs("  my-key  ")).toEqual({
      kind: "key",
      key: "my-key",
    });
  });

  it("returns invalid for keys starting with colon (reserved)", () => {
    expect(parseQueueArgs(":other")).toEqual({
      kind: "invalid",
      reason: expect.stringContaining("reserved"),
    });
  });

  it("returns invalid for keys containing spaces", () => {
    expect(parseQueueArgs("my key")).toEqual({
      kind: "invalid",
      reason: expect.stringContaining("spaces"),
    });
  });

  it("parses ':rename old-key new-key' as rename", () => {
    expect(parseQueueArgs(":rename old-key new-key")).toEqual({
      kind: "rename",
      oldKey: "old-key",
      newKey: "new-key",
    });
  });

  it("trims whitespace around :rename args", () => {
    expect(parseQueueArgs("  :rename   old-key   new-key  ")).toEqual({
      kind: "rename",
      oldKey: "old-key",
      newKey: "new-key",
    });
  });

  it("returns invalid for :rename without arguments", () => {
    expect(parseQueueArgs(":rename")).toEqual({
      kind: "invalid",
      reason: expect.stringContaining("existing"),
    });
  });

  it("returns invalid for :rename with only one argument", () => {
    expect(parseQueueArgs(":rename old-key")).toEqual({
      kind: "invalid",
      reason: expect.stringContaining("new"),
    });
  });

  it("returns invalid for :rename with invalid old key", () => {
    expect(parseQueueArgs(":rename bad/key new-key")).toEqual({
      kind: "invalid",
      reason: expect.any(String),
    });
  });

  it("returns invalid for :rename with invalid new key", () => {
    expect(parseQueueArgs(":rename old-key bad/key")).toEqual({
      kind: "invalid",
      reason: expect.any(String),
    });
  });
});

// ── validateKeyName ──────────────────────────────────────────────────

describe("validateKeyName", () => {
  it("accepts a simple key name", () => {
    expect(validateKeyName("review-and-fix")).toBeUndefined();
  });

  it("rejects empty string", () => {
    expect(validateKeyName("")).toBeDefined();
  });

  it("rejects keys starting with colon", () => {
    expect(validateKeyName(":bad")).toBeDefined();
  });

  it("rejects keys with spaces", () => {
    expect(validateKeyName("bad key")).toBeDefined();
  });

  it("rejects keys with dots", () => {
    expect(validateKeyName("bad.key")).toBeDefined();
  });

  it("rejects keys with slashes", () => {
    expect(validateKeyName("bad/key")).toBeDefined();
  });
});

// ── addCriteriaHeaders ───────────────────────────────────────────────

describe("addCriteriaHeaders", () => {
  it("adds [X of Y] headers to all prompts after the first", () => {
    const prompts = [
      "mode prompt",
      "criterion A",
      "criterion B",
      "criterion C",
    ];
    const result = addCriteriaHeaders(prompts);
    expect(result[0]).toBe("mode prompt");
    expect(result[1]).toContain("[1 of 3 queued prompts]");
    expect(result[1]).toContain("criterion A");
    expect(result[2]).toContain("[2 of 3 queued prompts]");
    expect(result[3]).toContain("[3 of 3 queued prompts]");
  });

  it("adjusts total when prompts are deleted", () => {
    const prompts = ["mode prompt", "criterion A", "criterion B"];
    const result = addCriteriaHeaders(prompts);
    expect(result[1]).toContain("[1 of 2 queued prompts]");
    expect(result[2]).toContain("[2 of 2 queued prompts]");
  });

  it("adjusts total when prompts are added", () => {
    const prompts = ["mode", "A", "B", "C", "D"];
    const result = addCriteriaHeaders(prompts);
    expect(result[1]).toContain("[1 of 4 queued prompts]");
    expect(result[4]).toContain("[4 of 4 queued prompts]");
  });

  it("preserves the original prompt length", () => {
    const prompts = ["mode", "A", "B"];
    const result = addCriteriaHeaders(prompts);
    expect(result.length).toBe(3);
  });
});

// ── ListState ────────────────────────────────────────────────────────

describe("ListState", () => {
  let state: ListState;

  beforeEach(() => {
    state = new ListState(["prompt A", "prompt B", "prompt C"]);
  });

  it("starts with cursor at 0 in list phase", () => {
    expect(state.cursor).toBe(0);
    expect(state.phase).toBe("list");
  });

  it("navigates to next prompt with next()", () => {
    state.next();
    expect(state.cursor).toBe(1);
  });

  it("does not go past the last prompt", () => {
    state.next();
    state.next();
    state.next();
    state.next();
    expect(state.cursor).toBe(2);
  });

  it("navigates to previous prompt with prev()", () => {
    state.next();
    state.prev();
    expect(state.cursor).toBe(0);
  });

  it("does not go before the first prompt", () => {
    state.prev();
    expect(state.cursor).toBe(0);
  });

  it("deletes the current prompt", () => {
    state.next(); // cursor = 1
    state.delete();
    expect(state.prompts).toEqual(["prompt A", "prompt C"]);
    expect(state.cursor).toBe(1);
  });

  it("does not delete the last remaining prompt", () => {
    state = new ListState(["only"]);
    state.delete();
    expect(state.prompts).toEqual(["only"]);
  });

  it("adjusts cursor when deleting the last item", () => {
    state.next();
    state.next(); // cursor = 2 (last)
    state.delete();
    expect(state.cursor).toBe(1);
    expect(state.prompts).toEqual(["prompt A", "prompt B"]);
  });

  it("enters edit phase", () => {
    state.edit();
    expect(state.phase).toBe("edit");
    expect(state.editingIndex).toBe(0);
  });

  it("saves edited text and returns to list", () => {
    state.edit();
    state.saveEdit("changed");
    expect(state.phase).toBe("list");
    expect(state.prompts[0]).toBe("changed");
  });

  it("discards empty edits and returns to list", () => {
    state.edit();
    state.saveEdit("");
    expect(state.phase).toBe("list");
    expect(state.prompts[0]).toBe("prompt A");
  });

  it("enters add mode (inserts after cursor)", () => {
    state.add();
    expect(state.phase).toBe("edit");
    expect(state.editingIndex).toBe(1);
    expect(state.prompts.length).toBe(4);
  });

  it("transposes current line with the one above it", () => {
    state.next(); // cursor = 1
    state.transpose();
    expect(state.prompts).toEqual(["prompt B", "prompt A", "prompt C"]);
  });

  it("moves cursor up after transpose", () => {
    state.next(); // cursor = 1
    state.transpose();
    expect(state.cursor).toBe(0);
  });

  it("does nothing when transposing on first line", () => {
    state.transpose();
    expect(state.prompts).toEqual(["prompt A", "prompt B", "prompt C"]);
    expect(state.cursor).toBe(0);
  });

  it("transposes from the last line", () => {
    state.next();
    state.next(); // cursor = 2
    state.transpose();
    expect(state.prompts).toEqual(["prompt A", "prompt C", "prompt B"]);
    expect(state.cursor).toBe(1);
  });

  it("removes placeholder on empty add save", () => {
    state.add();
    state.saveEdit("");
    expect(state.prompts).toEqual(["prompt A", "prompt B", "prompt C"]);
  });

  it("keeps new prompt on non-empty add save", () => {
    state.add();
    state.saveEdit("new");
    expect(state.prompts).toEqual(["prompt A", "new", "prompt B", "prompt C"]);
    expect(state.cursor).toBe(1);
  });

  it("returns current prompts on submit", () => {
    const result = state.submit();
    expect(result).toEqual(["prompt A", "prompt B", "prompt C"]);
  });
});

// ── formatPromptLines ────────────────────────────────────────────────

describe("formatPromptLines", () => {
  it("formats a single-line prompt", () => {
    const lines = formatPromptLines("▸ ", "1.", "hello world", 80);
    expect(lines).toEqual(["▸ 1. hello world"]);
  });

  it("wraps long text to multiple lines", () => {
    const lines = formatPromptLines(
      "▸ ",
      "1.",
      "aaa bbb ccc ddd eee fff ggg hhh",
      30,
    );
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toMatch(/^▸ 1\. /);
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]).toMatch(/^ {5}/);
    }
  });

  it("handles multi-line prompts (newlines in text)", () => {
    const lines = formatPromptLines("  ", "2.", "line one\nline two", 80);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toMatch(/^ {2}2\. line one/);
    expect(lines[1]).toMatch(/^ {5}line two/);
  });

  it("handles empty text", () => {
    const lines = formatPromptLines("  ", "1.", "", 80);
    expect(lines).toEqual(["  1. "]);
  });

  it("truncates prompts longer than maxLines", () => {
    const text = "line1\nline2\nline3\nline4\nline5\nline6\nline7";
    const lines = formatPromptLines("  ", "1.", text, 80, 3);
    expect(lines.length).toBe(4); // 3 content + 1 truncation hint
    expect(lines[0]).toMatch(/line1/);
    expect(lines[2]).toMatch(/line3/);
    expect(lines[3]).toMatch(/4 more lines/);
  });

  it("does not truncate when lines fit within maxLines", () => {
    const text = "line1\nline2\nline3";
    const lines = formatPromptLines("  ", "1.", text, 80, 5);
    expect(lines.length).toBe(3);
    expect(lines.every((l) => !l.includes("more lines"))).toBe(true);
  });

  it("does not truncate when lines equal maxLines", () => {
    const text = "line1\nline2\nline3\nline4\nline5";
    const lines = formatPromptLines("  ", "1.", text, 80, 5);
    expect(lines.length).toBe(5);
    expect(lines.every((l) => !l.includes("more lines"))).toBe(true);
  });

  it("uses default maxLines of 5", () => {
    const text = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8";
    const lines = formatPromptLines("  ", "1.", text, 80);
    expect(lines.length).toBe(6); // 5 content + 1 truncation hint
    expect(lines[5]).toMatch(/3 more lines/);
  });

  it("says '1 more line' for singular", () => {
    const text = "l1\nl2\nl3\nl4\nl5\nl6";
    const lines = formatPromptLines("  ", "1.", text, 80, 5);
    expect(lines.length).toBe(6); // 5 content + 1 hint
    expect(lines[5]).toMatch(/1 more line(?!s)/);
  });
});

// ── buildEditHeader ──────────────────────────────────────────────────

describe("buildEditHeader", () => {
  it("formats the header with current and total", () => {
    const header = buildEditHeader(3, 10);
    expect(header).toContain("3");
    expect(header).toContain("10");
  });
});

// ── createFinishEdit ─────────────────────────────────────────────────

describe("createFinishEdit", () => {
  it("saves text from the parameter when provided", () => {
    const state = new ListState(["A", "B"]);
    state.edit();
    const finish = createFinishEdit(state, () => "fallback");
    finish("edited");
    expect(state.prompts[0]).toBe("edited");
    expect(state.phase).toBe("list");
  });

  it("uses getText fallback when no parameter provided", () => {
    const state = new ListState(["A", "B"]);
    state.edit();
    const finish = createFinishEdit(state, () => "fallback");
    finish();
    expect(state.prompts[0]).toBe("fallback");
  });
});

// ── buildEditContextLines ────────────────────────────────────────────

describe("buildEditContextLines", () => {
  it("returns prompts before and after the editing index", () => {
    const prompts = ["A", "B", "C", "D", "E"];
    const { before, after } = buildEditContextLines(prompts, 2, 80);
    // Before should have prompts 0 and 1
    expect(before.some((l) => l.includes("1."))).toBe(true);
    expect(before.some((l) => l.includes("A"))).toBe(true);
    expect(before.some((l) => l.includes("2."))).toBe(true);
    expect(before.some((l) => l.includes("B"))).toBe(true);
    // After should have prompts 3 and 4
    expect(after.some((l) => l.includes("4."))).toBe(true);
    expect(after.some((l) => l.includes("D"))).toBe(true);
    expect(after.some((l) => l.includes("5."))).toBe(true);
    expect(after.some((l) => l.includes("E"))).toBe(true);
  });

  it("returns empty before when editing the first prompt", () => {
    const prompts = ["A", "B", "C"];
    const { before, after } = buildEditContextLines(prompts, 0, 80);
    expect(before).toEqual([]);
    expect(after.some((l) => l.includes("2."))).toBe(true);
    expect(after.some((l) => l.includes("3."))).toBe(true);
  });

  it("returns empty after when editing the last prompt", () => {
    const prompts = ["A", "B", "C"];
    const { before, after } = buildEditContextLines(prompts, 2, 80);
    expect(before.some((l) => l.includes("1."))).toBe(true);
    expect(before.some((l) => l.includes("2."))).toBe(true);
    expect(after).toEqual([]);
  });

  it("excludes the editing index from both before and after", () => {
    const prompts = ["A", "B", "C"];
    const { before, after } = buildEditContextLines(prompts, 1, 80);
    const all = [...before, ...after].join("\n");
    // Should not contain the prompt at index 1 ("B")
    // but should contain prompts 0 and 2
    expect(before.some((l) => l.includes("A"))).toBe(true);
    expect(after.some((l) => l.includes("C"))).toBe(true);
    // The editing prompt "B" should not appear
    expect(all).not.toContain("B");
  });

  it("uses consistent numbering with the full list", () => {
    const prompts = ["X", "Y", "Z"];
    const { before, after } = buildEditContextLines(prompts, 1, 80);
    // Prompt 0 should be numbered "1."
    expect(before.some((l) => l.includes("1."))).toBe(true);
    // Prompt 2 should be numbered "3."
    expect(after.some((l) => l.includes("3."))).toBe(true);
  });

  it("uses indented prefix (not cursor) for context prompts", () => {
    const prompts = ["A", "B", "C"];
    const { before, after } = buildEditContextLines(prompts, 1, 80);
    // Should use "  " prefix (no cursor indicator)
    expect(before[0]).toMatch(/^ {2}\d+\./);
    expect(after[0]).toMatch(/^ {2}\d+\./);
  });
});

// ── startQueue ─────────────────────────────────────────────────────

describe("startQueue", () => {
  function makeDeps(overrides?: Partial<StartQueueDeps>): StartQueueDeps {
    return {
      notify: vi.fn(),
      runnerCtx: {
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        sendUserMessage: vi.fn(),
        setStatus: vi.fn(),
        abort: vi.fn(),
      },
      ...overrides,
    };
  }

  it("notifies the user that the queue has been started", async () => {
    const deps = makeDeps();
    const { runner } = await startQueue(["A", "B"], null, deps);
    expect(deps.notify).toHaveBeenCalledWith(
      expect.stringContaining("2"),
      "info",
    );
    // Clean up
    runner.abort();
  });

  it("returns a new runner", async () => {
    const deps = makeDeps();
    const { runner } = await startQueue(["A", "B"], null, deps);
    expect(runner.isRunning()).toBe(true);
    runner.abort();
  });

  it("returns an error when a queue is already running", async () => {
    const deps = makeDeps();
    const { runner: first } = await startQueue(["A", "B"], null, deps);
    const result = await startQueue(["C", "D"], first, deps);
    expect(result.error).toBeDefined();
    expect(deps.notify).toHaveBeenCalledWith(
      expect.stringContaining("abort"),
      "error",
    );
    first.abort();
  });

  it("does not create a new runner when one is already running", async () => {
    const deps = makeDeps();
    const { runner: first } = await startQueue(["A", "B"], null, deps);
    const result = await startQueue(["C", "D"], first, deps);
    expect(result.runner).toBeUndefined();
    first.abort();
  });

  it("allows starting a new queue when previous runner has finished", async () => {
    const deps = makeDeps();
    const { runner: first } = await startQueue(["A"], null, deps);
    await first.onAgentEnd(); // finishes
    await first.onAgentEnd(); // fully done
    expect(first.isRunning()).toBe(false);
    const result = await startQueue(["B", "C"], first, deps);
    expect(result.runner).toBeDefined();
    expect(result.error).toBeUndefined();
    result.runner!.abort();
  });
});

// ── QueueRunner ──────────────────────────────────────────────────────

describe("QueueRunner", () => {
  function makeCtx(overrides?: Partial<QueueRunnerCtx>): QueueRunnerCtx {
    return {
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      sendUserMessage: vi.fn(),
      setStatus: vi.fn(),
      abort: vi.fn(),
      ...overrides,
    };
  }

  it("sets scheduled status immediately before waiting for idle", async () => {
    const statusBeforeIdle: (string | undefined)[] = [];
    let resolveIdle: () => void;
    const idlePromise = new Promise<void>((r) => (resolveIdle = r));
    const ctx = makeCtx({
      waitForIdle: vi.fn().mockImplementation(() => idlePromise),
      setStatus: vi.fn().mockImplementation((text) => {
        statusBeforeIdle.push(text);
      }),
    });
    const runner = new QueueRunner(ctx);
    const startPromise = runner.start(["A", "B", "C"]);
    expect(ctx.setStatus).toHaveBeenCalledTimes(1);
    expect(statusBeforeIdle[0]).toBe(
      "Queue: scheduled (3 prompts) — /queue :abort to cancel",
    );
    resolveIdle!();
    await startPromise;
  });

  it("waits for idle then sends the first prompt on start", async () => {
    const ctx = makeCtx();
    const runner = new QueueRunner(ctx);
    await runner.start(["A", "B", "C"]);
    expect(ctx.waitForIdle).toHaveBeenCalledTimes(1);
    expect(ctx.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(ctx.sendUserMessage).toHaveBeenCalledWith("A");
  });

  it("waits for idle before each subsequent prompt", async () => {
    const sent: string[] = [];
    const ctx = makeCtx({
      sendUserMessage: vi.fn().mockImplementation((t) => sent.push(t)),
    });
    const runner = new QueueRunner(ctx);
    await runner.start(["A", "B", "C"]);
    expect(sent).toEqual(["A"]);
    await runner.onAgentEnd();
    expect(sent).toEqual(["A", "B"]);
    await runner.onAgentEnd();
    expect(sent).toEqual(["A", "B", "C"]);
  });

  it("sets initial status on start", async () => {
    const ctx = makeCtx();
    const runner = new QueueRunner(ctx);
    await runner.start(["A", "B"]);
    expect(ctx.setStatus).toHaveBeenCalledWith("Queue: 1/2 prompts");
  });

  it("updates status on each onAgentEnd", async () => {
    const ctx = makeCtx();
    const runner = new QueueRunner(ctx);
    await runner.start(["A", "B", "C"]);
    await runner.onAgentEnd();
    expect(ctx.setStatus).toHaveBeenCalledWith("Queue: 2/3 prompts");
    await runner.onAgentEnd();
    expect(ctx.setStatus).toHaveBeenCalledWith("Queue: 3/3 prompts");
  });

  it("clears status after all prompts complete", async () => {
    const ctx = makeCtx();
    const runner = new QueueRunner(ctx);
    await runner.start(["A", "B"]);
    await runner.onAgentEnd();
    await runner.onAgentEnd();
    expect(ctx.setStatus).toHaveBeenLastCalledWith(undefined);
  });

  it("does not send extra prompts after all are delivered", async () => {
    const ctx = makeCtx();
    const runner = new QueueRunner(ctx);
    await runner.start(["A"]);
    await runner.onAgentEnd();
    await runner.onAgentEnd();
    expect(ctx.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("reports running while prompts remain", async () => {
    const ctx = makeCtx();
    const runner = new QueueRunner(ctx);
    expect(runner.isRunning()).toBe(false);
    await runner.start(["A", "B"]);
    expect(runner.isRunning()).toBe(true);
    await runner.onAgentEnd();
    expect(runner.isRunning()).toBe(true);
    await runner.onAgentEnd();
    expect(runner.isRunning()).toBe(false);
  });

  it("stops tracking when aborted", async () => {
    const ctx = makeCtx();
    const runner = new QueueRunner(ctx);
    await runner.start(["A", "B", "C"]);
    runner.abort();
    expect(runner.isRunning()).toBe(false);
    expect(ctx.abort).toHaveBeenCalled();
  });

  it("does not send more prompts after abort", async () => {
    const ctx = makeCtx();
    const runner = new QueueRunner(ctx);
    await runner.start(["A", "B", "C"]);
    runner.abort();
    await runner.onAgentEnd();
    expect(ctx.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("clears status when aborted", async () => {
    const ctx = makeCtx();
    const runner = new QueueRunner(ctx);
    await runner.start(["A", "B"]);
    runner.abort();
    expect(ctx.setStatus).toHaveBeenLastCalledWith(undefined);
  });

  it("clears scheduled status when aborted before idle resolves", async () => {
    let resolveIdle: () => void;
    const idlePromise = new Promise<void>((r) => (resolveIdle = r));
    const ctx = makeCtx({
      waitForIdle: vi.fn().mockImplementation(() => idlePromise),
    });
    const runner = new QueueRunner(ctx);
    const startPromise = runner.start(["A", "B"]);
    expect(ctx.setStatus).toHaveBeenCalledWith(
      "Queue: scheduled (2 prompts) — /queue :abort to cancel",
    );
    runner.abort();
    expect(ctx.setStatus).toHaveBeenLastCalledWith(undefined);
    expect(runner.isRunning()).toBe(false);
    resolveIdle!();
    await startPromise;
    expect(ctx.sendUserMessage).not.toHaveBeenCalled();
  });
});
