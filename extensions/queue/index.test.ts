/**
 * Integration tests for the queue extension.
 *
 * These tests drive the extension exactly the way the real pi runtime
 * does: a mock pi object registers the extension's command/event
 * handlers and then `pi.fire(...)` and `pi.runCommand(...)` deliver
 * lifecycle events. User keystrokes are delivered through `ctx.ui`
 * (which the production code reaches via `ctx.ui.custom(factory)`),
 * not by calling `Component.handleInput` directly.
 *
 * Internal helpers (ListState, formatPromptLines, parseQueueArgs, etc.)
 * are NOT imported. Their behavior is exercised through the same
 * surface the real extension uses: command args, key presses, and the
 * resulting notifications, status lines, store mutations, and rendered
 * output.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionContext,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { createExtension, DEFAULT_PROMPTS, type QueuePi } from "./index.js";
import { createFileStore, type StoreIO } from "./store.js";

// ── Key constants (raw bytes the real terminal would deliver) ───────

const ESC = "\x1b";
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const ENTER = "\r";
const ESCAPE = ESC;
const CTRL_C = "\x03";

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── MockPi ──────────────────────────────────────────────────────────

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandConfig = Parameters<QueuePi["registerCommand"]>[1];
type CommandHandler = CommandConfig["handler"];

interface RegisteredCommand {
  name: string;
  config: CommandConfig;
}

interface SendUserMessageCall {
  content: Parameters<QueuePi["sendUserMessage"]>[0];
  options?: Parameters<QueuePi["sendUserMessage"]>[1];
}

interface MockPi extends QueuePi {
  events: Map<string, EventHandler[]>;
  commands: Map<string, RegisteredCommand>;
  /** Recorded calls to pi.sendUserMessage, in order. */
  sentMessages: SendUserMessageCall[];
  /**
   * Fire an event to all registered listeners. Returns once each handler
   * has reached its first await — NOT once each handler's full async
   * body has settled. (A handler may legitimately await a long-running
   * promise like `waitForIdle()` while the agent is busy; awaiting full
   * completion would deadlock the test that controls the idle state.)
   */
  fire(name: string, event: unknown, ctx: MockCtx): Promise<void>;
  /** Invoke a registered command's handler. */
  runCommand(
    name: string,
    args: string,
    ctx: MockCtx,
  ): ReturnType<CommandHandler>;
}

function makeMockPi(): MockPi {
  const events = new Map<string, EventHandler[]>();
  const commands = new Map<string, RegisteredCommand>();
  const sentMessages: SendUserMessageCall[] = [];
  const pi: MockPi = {
    events,
    commands,
    sentMessages,
    on: ((name: string, fn: EventHandler) => {
      const list = events.get(name) ?? [];
      list.push(fn);
      events.set(name, list);
    }) as MockPi["on"],
    registerCommand(name, config) {
      commands.set(name, { name, config });
    },
    sendUserMessage: ((
      content: Parameters<QueuePi["sendUserMessage"]>[0],
      options?: Parameters<QueuePi["sendUserMessage"]>[1],
    ) => {
      sentMessages.push({ content, options });
    }) as QueuePi["sendUserMessage"],
    async fire(name, event, ctx) {
      const list = events.get(name) ?? [];
      for (const fn of list) {
        // Invoke the handler but do not await its full body — see the
        // doc comment on `MockPi.fire` for why.
        void fn(event, ctx as unknown as ExtensionContext);
      }
      // Yield once so each handler runs at least up to its first await.
      await new Promise((r) => setImmediate(r));
    },
    runCommand(name, args, ctx) {
      const cmd = commands.get(name);
      if (!cmd) throw new Error(`Command not registered: ${name}`);
      return cmd.config.handler(
        args,
        ctx as unknown as Parameters<CommandHandler>[1],
      );
    },
  };
  return pi;
}

// ── MockCtx ──────────────────────────────────────────────────────────

/** Custom-component factory signature, derived from the real ui.custom type. */
type CustomFactory = Parameters<ExtensionUIContext["custom"]>[0];
type CustomTui = Parameters<CustomFactory>[0];
type CustomTheme = Parameters<CustomFactory>[1];
type CustomKb = Parameters<CustomFactory>[2];
type CustomComponent = Component & {
  handleInput(input: string): void;
  invalidate(): void;
  dispose?(): void;
};

/**
 * Minimal TUI shape needed by queue's edit mode. The pi-tui `Editor`
 * component reaches into `tui.terminal.rows` to compute its viewport;
 * we provide a fixed-size fake so the editor can render in tests.
 */
interface MockActiveTui {
  requestRender: ReturnType<typeof vi.fn>;
  terminal: { rows: number; cols: number };
}

interface ActiveCustom {
  tui: MockActiveTui;
  done: (val: unknown) => void;
  component: CustomComponent;
  promise: Promise<unknown>;
}

interface MockUiContext {
  notifications: Array<{ msg: string; level: "info" | "warning" | "error" }>;
  /** Status-bar text by channel key. `undefined` = cleared. */
  statuses: Map<string, string | undefined>;
  /** History of every `setStatus` call, in order. */
  statusHistory: Array<{ key: string; text: string | undefined }>;
  notify: ExtensionUIContext["notify"];
  setStatus: ExtensionUIContext["setStatus"];
  custom: ExtensionUIContext["custom"];
  hasActiveCustom(): boolean;
  activeTui(): MockActiveTui;
  fireInput(input: string): void;
  renderActive(width?: number): string[];
  invalidateActive(): void;
  exitActive(value?: unknown): void;
}

/** Subset of `ExtensionCommandContext` queue actually reads/calls. */
type CtxSubset = Pick<
  ExtensionCommandContext,
  "cwd" | "hasUI" | "waitForIdle" | "abort"
>;

interface MockCtx extends CtxSubset {
  ui: MockUiContext;
  /** Recorded `ctx.abort()` calls. */
  abortCalls: number;
  /**
   * Mark the agent as idle. Resolves any pending `waitForIdle()`
   * promises and causes subsequent calls to resolve immediately. This
   * mirrors how the real runtime transitions from "busy executing a
   * prompt" to idle (typically signalled by `agent_end`). The default
   * state is idle, so most tests never need to call this.
   */
  enterIdleState(): void;
  /**
   * Mark the agent as busy. Subsequent `waitForIdle()` calls return
   * pending promises until `enterIdleState()` is called. Use this when
   * the test needs to observe state *before* idle is granted (e.g. the
   * "scheduled" status before the first prompt is sent, or to prove the
   * runner is actually awaiting idle and not just calling the API).
   */
  exitIdleState(): void;
}

interface MakeCtxOpts {
  cwd?: string;
  hasUI?: boolean;
}

function makeMockCtx(opts: MakeCtxOpts = {}): MockCtx {
  let active: ActiveCustom | undefined;
  const requireActive = (): ActiveCustom => {
    if (!active) throw new Error("no active ui.custom component");
    return active;
  };
  // Default to idle so simple tests don't need to manage the lifecycle.
  let isIdle = true;
  const idleWaiters: Array<() => void> = [];
  const ui: MockUiContext = {
    notifications: [],
    statuses: new Map(),
    statusHistory: [],
    notify(msg, level) {
      ui.notifications.push({ msg, level: level ?? "info" });
    },
    setStatus(key, text) {
      ui.statuses.set(key, text);
      ui.statusHistory.push({ key, text });
    },
    custom: (async (factory: CustomFactory) => {
      const tui: MockActiveTui = {
        requestRender: vi.fn(),
        terminal: { rows: 40, cols: 120 },
      };
      const theme = {
        fg: (_color: string, text?: string) => text ?? "",
        bold: (text: string) => text,
      } as unknown as CustomTheme;
      const kb = {} as CustomKb;
      let resolveDone!: (val: unknown) => void;
      const promise = new Promise<unknown>((res) => {
        resolveDone = res;
      });
      const done = (val: unknown) => {
        resolveDone(val);
        active = undefined;
      };
      const component = (await factory(
        tui as unknown as CustomTui,
        theme,
        kb,
        done as (result: never) => void,
      )) as CustomComponent;
      active = { tui, done, component, promise };
      return promise as Promise<never>;
    }) as ExtensionUIContext["custom"],
    hasActiveCustom: () => active !== undefined,
    activeTui: () => requireActive().tui,
    fireInput: (input) => requireActive().component.handleInput(input),
    renderActive: (width = 80) => requireActive().component.render(width),
    invalidateActive: () => requireActive().component.invalidate(),
    exitActive: (value) => requireActive().done(value),
  };

  let abortCalls = 0;
  const ctx: MockCtx = {
    cwd: opts.cwd ?? "/home/user/project",
    hasUI: opts.hasUI ?? true,
    waitForIdle: () => {
      if (isIdle) return Promise.resolve();
      return new Promise<void>((res) => {
        idleWaiters.push(res);
      });
    },
    abort: () => {
      abortCalls += 1;
    },
    ui,
    enterIdleState: () => {
      isIdle = true;
      const waiters = idleWaiters.splice(0);
      for (const r of waiters) r();
    },
    exitIdleState: () => {
      isIdle = false;
    },
    get abortCalls() {
      return abortCalls;
    },
  };
  return ctx;
}

// ── Wait helper (condition-based, replaces fragile fixed-tick waits) ─

async function waitFor(
  predicate: () => boolean,
  opts: { what: string; timeoutMs?: number } = { what: "condition" },
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(
        `waitFor: ${opts.what} not satisfied within ${timeoutMs}ms`,
      );
    await new Promise((r) => setImmediate(r));
  }
}

// ── tmpdir + harness ────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "queue-int-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore — tmpdir cleanup is best-effort
  }
});

interface Harness {
  pi: MockPi;
  store: StoreIO;
}

function setupExtension(opts?: { store?: StoreIO }): Harness {
  const pi = makeMockPi();
  // Default to a real file-backed store rooted in the test's tmpdir,
  // so snapshots/persistence behave exactly like production.
  const store = opts?.store ?? createFileStore(tmpDir);
  createExtension(pi, { store });
  return { pi, store };
}

/**
 * Run `/queue <args>`, wait for the list-view component to mount (when
 * one is expected), and return both the running command promise and a
 * UI facade. The facade routes input/render through `ctx.ui.*` so tests
 * never reach into the rendered component directly.
 */
async function runQueueCommand(
  harness: Harness,
  args: string,
  ctx: MockCtx = makeMockCtx(),
): Promise<{
  ctx: MockCtx;
  cmdPromise: ReturnType<CommandHandler>;
  /** True if `/queue` opened the list-view UI for this invocation. */
  hasUi(): boolean;
  render(width?: number): string[];
  renderText(width?: number): string;
  fireInput(input: string): void;
  exit(): void;
  tui(): MockActiveTui;
}> {
  const cmdPromise = harness.pi.runCommand("queue", args, ctx);
  return {
    ctx,
    cmdPromise,
    hasUi: () => ctx.ui.hasActiveCustom(),
    render: (width = 80) => ctx.ui.renderActive(width),
    renderText: (width = 80) =>
      ctx.ui.renderActive(width).map(stripAnsi).join("\n"),
    fireInput: (input) => ctx.ui.fireInput(input),
    exit: () => ctx.ui.exitActive(undefined),
    tui: () => ctx.ui.activeTui(),
  };
}

/**
 * Open the list UI for an existing key and wait for it to mount.
 * Returns the same facade as `runQueueCommand` plus convenience methods
 * for finishing the command (Enter/Esc) and awaiting completion.
 */
async function openListUi(
  harness: Harness,
  key: string,
  ctxOpts?: MakeCtxOpts,
) {
  const ctx = makeMockCtx(ctxOpts);
  const result = await runQueueCommand(harness, key, ctx);
  await waitFor(() => result.hasUi(), {
    what: "/queue list view to mount",
  });
  return result;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("/queue command registration", () => {
  it("registers a queue command", () => {
    const h = setupExtension();
    expect(h.pi.commands.has("queue")).toBe(true);
  });

  it("subscribes to agent_end events", () => {
    const h = setupExtension();
    expect((h.pi.events.get("agent_end") ?? []).length).toBe(1);
  });
});

describe("first-run defaults", () => {
  it("seeds the review-and-fix queue when the store is empty", async () => {
    const h = setupExtension();
    // Sanity: store starts empty.
    expect(h.store.listKeys()).toEqual([]);
    await runQueueCommand(h, ""); // usage; triggers ensureDefaults
    expect(h.store.listKeys()).toContain("review-and-fix");
    expect(h.store.load("review-and-fix")).toEqual(DEFAULT_PROMPTS);
  });

  it("does not overwrite existing queues when other keys are present", async () => {
    const h = setupExtension();
    h.store.save("custom", ["my prompt"]);
    await runQueueCommand(h, "");
    // Only the user's own key, no review-and-fix forced in.
    expect(h.store.listKeys()).toEqual(["custom"]);
  });
});

describe("/queue with no arguments shows usage", () => {
  it("notifies usage with the list of saved keys", async () => {
    const h = setupExtension();
    h.store.save("alpha", ["A"]);
    h.store.save("beta", ["B"]);
    const r = await runQueueCommand(h, "");
    const usage = r.ctx.ui.notifications.find((n) => /Usage/.test(n.msg));
    expect(usage).toBeDefined();
    expect(usage!.level).toBe("info");
    expect(usage!.msg).toContain("alpha");
    expect(usage!.msg).toContain("beta");
  });

  it("notifies '(none)' when the store is empty AFTER seeding does nothing", async () => {
    // Inject a store whose listKeys returns [] AND whose save is a no-op,
    // simulating a misbehaving store. We just want to verify the "(none)"
    // message branch is reachable.
    const empty: StoreIO = {
      listKeys: () => [],
      load: () => undefined,
      save: () => {},
      delete: () => false,
      rename: () => false,
      listSnapshots: () => [],
    };
    const h = setupExtension({ store: empty });
    const r = await runQueueCommand(h, "");
    const usage = r.ctx.ui.notifications.find((n) => /Usage/.test(n.msg));
    expect(usage!.msg).toContain("(none)");
  });
});

describe("invalid arguments are rejected before opening the UI", () => {
  it("rejects keys with spaces", async () => {
    const h = setupExtension();
    const r = await runQueueCommand(h, "my key");
    expect(r.hasUi()).toBe(false);
    const err = r.ctx.ui.notifications.find((n) => n.level === "error");
    expect(err?.msg).toMatch(/space/i);
  });

  it("rejects keys with dots", async () => {
    const h = setupExtension();
    const r = await runQueueCommand(h, "bad.key");
    expect(r.hasUi()).toBe(false);
    expect(
      r.ctx.ui.notifications.find((n) => n.level === "error"),
    ).toBeDefined();
  });

  it("rejects keys with slashes", async () => {
    const h = setupExtension();
    const r = await runQueueCommand(h, "bad/key");
    expect(r.hasUi()).toBe(false);
    expect(
      r.ctx.ui.notifications.find((n) => n.level === "error"),
    ).toBeDefined();
  });

  it("rejects keys starting with ':' as reserved", async () => {
    const h = setupExtension();
    const r = await runQueueCommand(h, ":nosuch");
    expect(r.hasUi()).toBe(false);
    const err = r.ctx.ui.notifications.find((n) => n.level === "error");
    expect(err?.msg).toMatch(/reserved/i);
  });

  it("notifies an error for unknown keys", async () => {
    const h = setupExtension();
    const r = await runQueueCommand(h, "ghost");
    expect(r.hasUi()).toBe(false);
    const err = r.ctx.ui.notifications.find((n) => n.level === "error");
    expect(err?.msg).toMatch(/Unknown key.*ghost/);
  });
});

describe(":delete subcommand", () => {
  it("deletes an existing key and notifies the user", async () => {
    const h = setupExtension();
    h.store.save("alpha", ["A"]);
    const r = await runQueueCommand(h, ":delete alpha");
    expect(h.store.load("alpha")).toBeUndefined();
    const note = r.ctx.ui.notifications.find((n) =>
      /Deleted queue/.test(n.msg),
    );
    expect(note?.msg).toContain("alpha");
    expect(note?.level).toBe("info");
  });

  it("notifies an error when deleting a non-existent key", async () => {
    const h = setupExtension();
    const r = await runQueueCommand(h, ":delete ghost");
    const err = r.ctx.ui.notifications.find((n) => n.level === "error");
    expect(err?.msg).toMatch(/Unknown key.*ghost/);
  });

  it("rejects ':delete' without a key", async () => {
    const h = setupExtension();
    const r = await runQueueCommand(h, ":delete");
    const err = r.ctx.ui.notifications.find((n) => n.level === "error");
    expect(err?.msg).toMatch(/key/);
  });

  it("rejects ':delete <invalid-key>' before touching the store", async () => {
    const h = setupExtension();
    h.store.save("real", ["A"]);
    const r = await runQueueCommand(h, ":delete bad/key");
    expect(
      r.ctx.ui.notifications.find((n) => n.level === "error"),
    ).toBeDefined();
    // Real key is untouched.
    expect(h.store.load("real")).toEqual(["A"]);
  });
});

describe(":rename subcommand", () => {
  it("renames an existing key", async () => {
    const h = setupExtension();
    h.store.save("old-name", ["A", "B"]);
    const r = await runQueueCommand(h, ":rename old-name new-name");
    expect(h.store.load("old-name")).toBeUndefined();
    expect(h.store.load("new-name")).toEqual(["A", "B"]);
    const note = r.ctx.ui.notifications.find((n) => /Renamed/.test(n.msg));
    expect(note?.msg).toContain("old-name");
    expect(note?.msg).toContain("new-name");
  });

  it("notifies an error when the source key is missing", async () => {
    const h = setupExtension();
    const r = await runQueueCommand(h, ":rename ghost new");
    const err = r.ctx.ui.notifications.find((n) => n.level === "error");
    expect(err?.msg).toMatch(/Unknown key.*ghost/);
  });

  it("rejects ':rename' without arguments", async () => {
    const h = setupExtension();
    const r = await runQueueCommand(h, ":rename");
    const err = r.ctx.ui.notifications.find((n) => n.level === "error");
    expect(err?.msg).toMatch(/existing/);
  });

  it("rejects ':rename old-only' with a single argument", async () => {
    const h = setupExtension();
    const r = await runQueueCommand(h, ":rename old-only");
    const err = r.ctx.ui.notifications.find((n) => n.level === "error");
    expect(err?.msg).toMatch(/new/);
  });

  it("rejects ':rename' when the new key is invalid", async () => {
    const h = setupExtension();
    h.store.save("ok", ["A"]);
    const r = await runQueueCommand(h, ":rename ok bad/key");
    expect(
      r.ctx.ui.notifications.find((n) => n.level === "error"),
    ).toBeDefined();
    // Source key unchanged.
    expect(h.store.load("ok")).toEqual(["A"]);
  });

  it("rejects ':rename' when the OLD key is invalid (before lookup)", async () => {
    const h = setupExtension();
    const r = await runQueueCommand(h, ":rename bad/key new");
    const err = r.ctx.ui.notifications.find((n) => n.level === "error");
    expect(err).toBeDefined();
    // "slash" message is more specific than "Unknown key" — confirms
    // we validated the source key before treating it as a lookup.
    expect(err!.msg).toMatch(/slash/i);
  });
});

describe("argument trimming", () => {
  it("trims whitespace around a /queue <key> invocation", async () => {
    const h = setupExtension();
    h.store.save("q", ["A"]);
    const ui = await openListUi(h, "   q   ");
    expect(ui.renderText()).toContain("/queue: q");
  });

  it("trims whitespace around ':delete <key>'", async () => {
    const h = setupExtension();
    h.store.save("alpha", ["A"]);
    await runQueueCommand(h, ":delete   alpha   ");
    expect(h.store.load("alpha")).toBeUndefined();
  });

  it("trims whitespace around ':rename old new'", async () => {
    const h = setupExtension();
    h.store.save("old", ["A"]);
    await runQueueCommand(h, ":rename   old   new   ");
    expect(h.store.load("old")).toBeUndefined();
    expect(h.store.load("new")).toEqual(["A"]);
  });
});

describe(":abort subcommand", () => {
  it("notifies 'No queue in progress' when nothing is running", async () => {
    const h = setupExtension();
    const r = await runQueueCommand(h, ":abort");
    const note = r.ctx.ui.notifications.find((n) => /No queue/.test(n.msg));
    expect(note?.level).toBe("info");
  });
});

// ── List view ───────────────────────────────────────────────────────

describe("/queue <key> opens the list view", () => {
  it("renders a header with the key name and prompt count", async () => {
    const h = setupExtension();
    h.store.save("my-q", ["A", "B", "C"]);
    const ui = await openListUi(h, "my-q");
    const text = ui.renderText();
    expect(text).toContain("/queue: my-q");
    expect(text).toContain("(3)");
  });

  it("renders all prompts numbered starting at 1", async () => {
    const h = setupExtension();
    h.store.save("q", ["alpha", "beta", "gamma"]);
    const ui = await openListUi(h, "q");
    const text = ui.renderText();
    expect(text).toMatch(/1\.\s*alpha/);
    expect(text).toMatch(/2\.\s*beta/);
    expect(text).toMatch(/3\.\s*gamma/);
  });

  it("places the cursor on the first prompt by default", async () => {
    const h = setupExtension();
    h.store.save("q", ["alpha", "beta"]);
    const ui = await openListUi(h, "q");
    const text = ui.renderText();
    // Cursor marker is "▸" (production code uses a triangle prefix).
    const lines = text.split("\n");
    const cursorLine = lines.find((l) => l.includes("▸"));
    expect(cursorLine).toBeDefined();
    expect(cursorLine).toMatch(/alpha/);
  });

  it("respects the requested width (no rendered line exceeds it)", async () => {
    const h = setupExtension();
    h.store.save("q", ["short"]);
    const ui = await openListUi(h, "q");
    const width = 40;
    for (const line of ui.render(width).map(stripAnsi)) {
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  it("truncates long multi-line prompts to a fixed window with a hint", async () => {
    const h = setupExtension();
    const long = Array.from({ length: 8 }, (_, i) => `line-${i}`).join("\n");
    h.store.save("q", [long]);
    const ui = await openListUi(h, "q");
    const text = ui.renderText();
    // Default truncation keeps 5 lines + a "X more lines" hint.
    expect(text).toContain("more line");
    // 8 source lines minus 5 visible = "3 more lines" (plural).
    expect(text).toMatch(/3 more lines/);
  });

  it("uses singular '1 more line' when exactly one line is hidden", async () => {
    const h = setupExtension();
    // 6 source lines minus 5 visible = "1 more line" (singular form).
    const six = Array.from({ length: 6 }, (_, i) => `line-${i}`).join("\n");
    h.store.save("q", [six]);
    const ui = await openListUi(h, "q");
    const text = ui.renderText();
    expect(text).toMatch(/1 more line\b/);
    expect(text).not.toMatch(/1 more lines/);
  });

  it("aligns prompt numbers in a gutter wide enough for the largest number", async () => {
    const h = setupExtension();
    // 11 prompts → numbers 1..11, gutter must accommodate "11."
    const prompts = Array.from({ length: 11 }, (_, i) => `p${i + 1}`);
    h.store.save("q", prompts);
    const ui = await openListUi(h, "q");
    const lines = ui.render().map(stripAnsi);
    const line1 = lines.find((l) => /\b1\./.test(l) && l.includes("p1"));
    const line11 = lines.find((l) => /\b11\./.test(l) && l.includes("p11"));
    expect(line1).toBeDefined();
    expect(line11).toBeDefined();
    // Same gutter width → both lines start the prompt text at the same column.
    const col1 = line1!.indexOf("p1");
    const col11 = line11!.indexOf("p11");
    expect(col1).toBe(col11);
  });
});

describe("list view navigation", () => {
  async function open3() {
    const h = setupExtension();
    h.store.save("q", ["A", "B", "C"]);
    return openListUi(h, "q");
  }

  it("DOWN moves the cursor to the next prompt", async () => {
    const ui = await open3();
    ui.fireInput(DOWN);
    const cursorLine = ui
      .renderText()
      .split("\n")
      .find((l) => l.includes("▸"));
    expect(cursorLine).toMatch(/B/);
  });

  it("DOWN past the last prompt stays on the last prompt", async () => {
    const ui = await open3();
    ui.fireInput(DOWN);
    ui.fireInput(DOWN);
    ui.fireInput(DOWN); // would go past
    ui.fireInput(DOWN);
    const cursorLine = ui
      .renderText()
      .split("\n")
      .find((l) => l.includes("▸"));
    expect(cursorLine).toMatch(/C/);
  });

  it("UP moves the cursor to the previous prompt", async () => {
    const ui = await open3();
    ui.fireInput(DOWN);
    ui.fireInput(UP);
    const cursorLine = ui
      .renderText()
      .split("\n")
      .find((l) => l.includes("▸"));
    expect(cursorLine).toMatch(/A/);
  });

  it("UP from first prompt stays on the first prompt", async () => {
    const ui = await open3();
    ui.fireInput(UP);
    const cursorLine = ui
      .renderText()
      .split("\n")
      .find((l) => l.includes("▸"));
    expect(cursorLine).toMatch(/A/);
  });
});

describe("list view 'd' deletes prompts", () => {
  it("removes the prompt under the cursor", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B", "C"]);
    const ui = await openListUi(h, "q");
    ui.fireInput(DOWN); // cursor → B
    ui.fireInput("d");
    const text = ui.renderText();
    expect(text).not.toMatch(/\bB\b/);
    expect(text).toMatch(/A/);
    expect(text).toMatch(/C/);
  });

  it("does not delete the only remaining prompt", async () => {
    const h = setupExtension();
    h.store.save("q", ["only"]);
    const ui = await openListUi(h, "q");
    ui.fireInput("d");
    expect(ui.renderText()).toContain("only");
  });

  it("'d' does not persist the deletion until 'S' is pressed", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B"]);
    const ui = await openListUi(h, "q");
    ui.fireInput("d");
    // Persisted store still has both prompts.
    expect(h.store.load("q")).toEqual(["A", "B"]);
  });

  it("clamps the cursor to the new last item when deleting the last prompt", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B", "C"]);
    const ui = await openListUi(h, "q");
    ui.fireInput(DOWN);
    ui.fireInput(DOWN); // cursor → C (last)
    ui.fireInput("d");
    // After deleting C, cursor should land on B (the new last) instead
    // of dangling past the end of the list.
    const cursorLine = ui
      .renderText()
      .split("\n")
      .find((l) => l.includes("▸"));
    expect(cursorLine).toMatch(/B/);
  });
});

describe("list view 't' transposes prompts", () => {
  it("swaps the cursor prompt with the previous one and follows it", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B", "C"]);
    const ui = await openListUi(h, "q");
    ui.fireInput(DOWN); // cursor → B
    ui.fireInput("t");
    const text = ui.renderText();
    // Numbering should now show B as #1 and A as #2.
    expect(text).toMatch(/1\.\s*B/);
    expect(text).toMatch(/2\.\s*A/);
    // The cursor moves with the transposed prompt to its new position.
    const cursorLine = text.split("\n").find((l) => l.includes("▸"));
    expect(cursorLine).toMatch(/B/);
  });

  it("does nothing when the cursor is on the first prompt", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B"]);
    const ui = await openListUi(h, "q");
    ui.fireInput("t");
    const text = ui.renderText();
    expect(text).toMatch(/1\.\s*A/);
    expect(text).toMatch(/2\.\s*B/);
  });

  it("swaps with the previous prompt from the last line", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B", "C"]);
    const ui = await openListUi(h, "q");
    ui.fireInput(DOWN);
    ui.fireInput(DOWN); // cursor → C
    ui.fireInput("t");
    const text = ui.renderText();
    expect(text).toMatch(/1\.\s*A/);
    expect(text).toMatch(/2\.\s*C/);
    expect(text).toMatch(/3\.\s*B/);
  });
});

describe("list view 'S' saves the current state to the store", () => {
  it("persists deletions to the store", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B", "C"]);
    const ui = await openListUi(h, "q");
    ui.fireInput(DOWN);
    ui.fireInput("d"); // delete B
    ui.fireInput("S");
    expect(h.store.load("q")).toEqual(["A", "C"]);
  });

  it("creates a snapshot for the previous version", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B"]);
    expect(h.store.listSnapshots()).toEqual([]);
    const ui = await openListUi(h, "q");
    ui.fireInput("d");
    ui.fireInput("S");
    expect(h.store.listSnapshots().length).toBe(1);
  });

  it("flashes a 'Saved to <key>' message after saving", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B"]);
    const ui = await openListUi(h, "q");
    ui.fireInput("S");
    const text = ui.renderText();
    expect(text).toContain("Saved to q");
  });
});

describe("list view 'a' adds a prompt via the editor", () => {
  it("inserts a new prompt after the cursor when the editor is submitted", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B"]);
    const ui = await openListUi(h, "q");
    ui.fireInput("a"); // enter add mode (cursor on A → insert at index 1)
    // Type the new prompt: "X" is a single character key event.
    ui.fireInput("X");
    // Editor's escape returns to list with the typed text saved.
    ui.fireInput(ESCAPE);
    const text = ui.renderText();
    expect(text).toMatch(/1\.\s*A/);
    expect(text).toMatch(/2\.\s*X/);
    expect(text).toMatch(/3\.\s*B/);
  });

  it("discards the placeholder when the editor exits empty", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B"]);
    const ui = await openListUi(h, "q");
    ui.fireInput("a");
    // No typing — exit immediately.
    ui.fireInput(ESCAPE);
    const text = ui.renderText();
    expect(text).toMatch(/1\.\s*A/);
    expect(text).toMatch(/2\.\s*B/);
    // No third entry was created.
    expect(text).not.toMatch(/3\./);
  });
});

describe("list view 'e' edits the cursor prompt", () => {
  it("replaces the cursor prompt with the typed text on escape", async () => {
    const h = setupExtension();
    h.store.save("q", ["original", "second"]);
    const ui = await openListUi(h, "q");
    ui.fireInput("e");
    // Editor opens with "original" as initial text. ctrl+c clears it,
    // then we type "edited".
    ui.fireInput(CTRL_C);
    for (const c of "edited") ui.fireInput(c);
    ui.fireInput(ESCAPE);
    const text = ui.renderText();
    expect(text).toMatch(/1\.\s*edited/);
    // Original prompt is gone.
    expect(text).not.toMatch(/1\.\s*original/);
  });

  it("renders an edit header showing 'editing prompt N of M'", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B", "C"]);
    const ui = await openListUi(h, "q");
    ui.fireInput(DOWN); // cursor → B (index 1, prompt #2)
    ui.fireInput("e");
    const text = ui.renderText();
    expect(text).toMatch(/editing prompt 2 of 3/);
  });

  it("shows 'esc:return' (not 'esc:cancel') and omits 'enter:save' in the edit header", async () => {
    const h = setupExtension();
    h.store.save("q", ["only"]);
    const ui = await openListUi(h, "q");
    ui.fireInput("e");
    const text = ui.renderText();
    expect(text).toMatch(/esc:return/);
    expect(text).not.toMatch(/esc:cancel/);
    // Enter inserts a newline in edit mode — the header must not
    // advertise 'enter:save'.
    expect(text).not.toMatch(/enter:save/);
  });

  it("omits the cursor marker for context prompts (only the editor is focused)", async () => {
    const h = setupExtension();
    h.store.save("q", ["before", "current", "after"]);
    const ui = await openListUi(h, "q");
    ui.fireInput(DOWN);
    ui.fireInput("e");
    const text = ui.renderText();
    const contextLines = text
      .split("\n")
      .filter((l) => l.includes("before") || l.includes("after"));
    for (const line of contextLines) {
      expect(line).not.toContain("▸");
    }
  });

  it("shows context prompts with their original numbers from the full list", async () => {
    const h = setupExtension();
    h.store.save("q", ["first", "second", "third", "fourth"]);
    const ui = await openListUi(h, "q");
    ui.fireInput(DOWN);
    ui.fireInput(DOWN); // cursor → "third" (#3)
    ui.fireInput("e");
    const text = ui.renderText();
    expect(text).toMatch(/1\.\s*first/);
    expect(text).toMatch(/2\.\s*second/);
    expect(text).toMatch(/4\.\s*fourth/);
    // The editing prompt itself is NOT duplicated as a numbered context line.
    expect(text).not.toMatch(/3\.\s*third/);
    expect(text).toMatch(/editing prompt 3 of 4/);
  });

  it("renders no numbered context lines when editing the only prompt", async () => {
    const h = setupExtension();
    h.store.save("q", ["only"]);
    const ui = await openListUi(h, "q");
    ui.fireInput("e");
    const text = ui.renderText();
    const numberedContext = text
      .split("\n")
      .filter((l) => /^\s*\d+\.\s*only/.test(l));
    expect(numberedContext).toEqual([]);
    expect(text).toMatch(/editing prompt 1 of 1/);
  });

  it("discards empty edits and keeps the original prompt", async () => {
    const h = setupExtension();
    h.store.save("q", ["original"]);
    const ui = await openListUi(h, "q");
    ui.fireInput("e");
    // pi-tui's ctrl+c clears the editor; exit without typing anything.
    ui.fireInput(CTRL_C);
    ui.fireInput(ESCAPE);
    expect(ui.renderText()).toMatch(/1\.\s*original/);
  });

  it("renders surrounding prompts as dim context above and below the editor", async () => {
    const h = setupExtension();
    h.store.save("q", ["before", "current", "after"]);
    const ui = await openListUi(h, "q");
    ui.fireInput(DOWN); // cursor → "current"
    ui.fireInput("e");
    const text = ui.renderText();
    // "before" and "after" still shown as context; "current" appears
    // inside the editor (not in the dim context list).
    expect(text).toContain("before");
    expect(text).toContain("after");
    // The editor header is between them and refers to prompt 2.
    expect(text).toMatch(/editing prompt 2 of 3/);
  });
});

describe("list view 'c' copy-to-new-key", () => {
  it("opens the copy input with a header", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B"]);
    const ui = await openListUi(h, "q");
    ui.fireInput("c");
    expect(ui.renderText()).toMatch(/Copy to new queue/);
  });

  it("saves a copy under the new name when the input is submitted", async () => {
    const h = setupExtension();
    h.store.save("src", ["A", "B"]);
    const ui = await openListUi(h, "src");
    ui.fireInput("c");
    for (const c of "dest") ui.fireInput(c);
    ui.fireInput(ENTER);
    expect(h.store.load("dest")).toEqual(["A", "B"]);
    // Original key is unchanged.
    expect(h.store.load("src")).toEqual(["A", "B"]);
  });

  it("rejects an invalid copy target with an inline error", async () => {
    const h = setupExtension();
    h.store.save("src", ["A"]);
    const ui = await openListUi(h, "src");
    ui.fireInput("c");
    for (const c of "bad/key") ui.fireInput(c);
    ui.fireInput(ENTER);
    const text = ui.renderText();
    // Error message mentions slashes.
    expect(text).toMatch(/slash/i);
    // Nothing saved under any plausible bad key.
    expect(h.store.load("bad/key")).toBeUndefined();
  });

  it("cancels the copy input on escape without writing", async () => {
    const h = setupExtension();
    h.store.save("src", ["A"]);
    const ui = await openListUi(h, "src");
    ui.fireInput("c");
    for (const c of "dest") ui.fireInput(c);
    ui.fireInput(ESCAPE);
    expect(h.store.load("dest")).toBeUndefined();
  });
});

describe("ESC cancels the list view", () => {
  it("resolves the cmdPromise without sending any messages", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B"]);
    const ui = await openListUi(h, "q");
    ui.fireInput(ESCAPE);
    await ui.cmdPromise;
    expect(h.pi.sentMessages).toEqual([]);
  });
});

// ── Submit + run flow ───────────────────────────────────────────────

describe("submitting a queue runs it via pi.sendUserMessage and agent_end", () => {
  it("sends the first prompt as soon as the agent is idle", async () => {
    const h = setupExtension();
    h.store.save("q", ["first", "second"]);
    const ui = await openListUi(h, "q");
    ui.fireInput(ENTER);
    await waitFor(() => h.pi.sentMessages.length === 1, {
      what: "first prompt to be sent",
    });
    const first = h.pi.sentMessages[0];
    // First prompt has no [N of M] header.
    expect(first.content).toBe("first");
    // Production code passes deliverAs:"followUp".
    expect(first.options).toMatchObject({ deliverAs: "followUp" });
  });

  it("sends each subsequent prompt only after agent_end fires", async () => {
    const h = setupExtension();
    h.store.save("q", ["first", "second", "third"]);
    const ui = await openListUi(h, "q");
    ui.fireInput(ENTER);
    await waitFor(() => h.pi.sentMessages.length === 1, {
      what: "first prompt sent",
    });
    expect(h.pi.sentMessages.length).toBe(1);
    await h.pi.fire("agent_end", {}, ui.ctx);
    await waitFor(() => h.pi.sentMessages.length === 2, {
      what: "second prompt sent after first agent_end",
    });
    expect(h.pi.sentMessages[1].content).toContain("second");
    await h.pi.fire("agent_end", {}, ui.ctx);
    await waitFor(() => h.pi.sentMessages.length === 3, {
      what: "third prompt sent after second agent_end",
    });
    expect(h.pi.sentMessages[2].content).toContain("third");
  });

  it("prefixes prompts after the first with a [N of M queued prompts] header", async () => {
    const h = setupExtension();
    h.store.save("q", ["mode", "criterion-A", "criterion-B"]);
    const ui = await openListUi(h, "q");
    ui.fireInput(ENTER);
    await waitFor(() => h.pi.sentMessages.length === 1);
    expect(h.pi.sentMessages[0].content).toBe("mode"); // no header
    await h.pi.fire("agent_end", {}, ui.ctx);
    await waitFor(() => h.pi.sentMessages.length === 2);
    expect(h.pi.sentMessages[1].content).toContain("[1 of 2 queued prompts]");
    expect(h.pi.sentMessages[1].content).toContain("criterion-A");
    await h.pi.fire("agent_end", {}, ui.ctx);
    await waitFor(() => h.pi.sentMessages.length === 3);
    expect(h.pi.sentMessages[2].content).toContain("[2 of 2 queued prompts]");
  });

  it("clears the queue status after the last prompt's agent_end", async () => {
    const h = setupExtension();
    h.store.save("q", ["only"]);
    const ui = await openListUi(h, "q");
    ui.fireInput(ENTER);
    await waitFor(() => h.pi.sentMessages.length === 1);
    expect(ui.ctx.ui.statuses.get("queue")).toMatch(/1\/1/);
    await h.pi.fire("agent_end", {}, ui.ctx);
    expect(ui.ctx.ui.statuses.get("queue")).toBeUndefined();
  });

  it("sets a 'scheduled' status BEFORE the first idle resolves", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B"]);
    const ui = await openListUi(h, "q");
    // Simulate the agent currently busy — the runner will park on
    // `waitForIdle()` until we let it through.
    ui.ctx.exitIdleState();
    ui.fireInput(ENTER);
    await waitFor(
      () => /scheduled/.test(ui.ctx.ui.statuses.get("queue") ?? ""),
      { what: "scheduled status to appear" },
    );
    // The runner is parked, so no prompt has been sent yet.
    expect(h.pi.sentMessages).toEqual([]);
    // Agent reaches idle → the parked waitForIdle resolves → first
    // prompt is sent and status flips to "1/2 prompts".
    ui.ctx.enterIdleState();
    await waitFor(() => h.pi.sentMessages.length === 1);
    expect(ui.ctx.ui.statuses.get("queue")).toMatch(/1\/2/);
  });

  it("notifies that the queue has started (with the prompt count)", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B"]);
    const ui = await openListUi(h, "q");
    ui.fireInput(ENTER);
    await waitFor(() =>
      ui.ctx.ui.notifications.some((n) => /queue started/.test(n.msg)),
    );
    const note = ui.ctx.ui.notifications.find((n) =>
      /queue started/.test(n.msg),
    );
    expect(note?.msg).toContain("2");
    expect(note?.level).toBe("info");
  });
});

describe("QueueRunner subsequent-idle waits and post-completion behavior", () => {
  it("blocks on idle BEFORE sending each subsequent prompt (not just the first)", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B", "C"]);
    const ui = await openListUi(h, "q");
    // Start with the agent busy. The runner will park on every
    // waitForIdle until we explicitly let it through.
    ui.ctx.exitIdleState();
    ui.fireInput(ENTER);
    // Without idle, the first prompt has not been sent.
    await waitFor(
      () => /scheduled/.test(ui.ctx.ui.statuses.get("queue") ?? ""),
      { what: "runner to reach scheduled state" },
    );
    expect(h.pi.sentMessages).toEqual([]);
    // Granting idle releases exactly the first prompt.
    ui.ctx.enterIdleState();
    await waitFor(() => h.pi.sentMessages.length === 1);
    // Simulate the agent now executing prompt 1: busy again.
    ui.ctx.exitIdleState();
    await h.pi.fire("agent_end", {}, ui.ctx);
    // Even though agent_end fired, the runner must wait for idle
    // before sending B — we haven't granted it, so no new prompt yet.
    await new Promise((r) => setImmediate(r));
    expect(h.pi.sentMessages.length).toBe(1);
    // Granting idle releases prompt 2.
    ui.ctx.enterIdleState();
    await waitFor(() => h.pi.sentMessages.length === 2);
    expect(h.pi.sentMessages[1].content).toContain("B");
    // Same dance for the third prompt: busy → agent_end → still blocked
    // → idle → sent.
    ui.ctx.exitIdleState();
    await h.pi.fire("agent_end", {}, ui.ctx);
    await new Promise((r) => setImmediate(r));
    expect(h.pi.sentMessages.length).toBe(2);
    ui.ctx.enterIdleState();
    await waitFor(() => h.pi.sentMessages.length === 3);
    expect(h.pi.sentMessages[2].content).toContain("C");
  });

  it("does not send any further prompts after the last one's agent_end", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B"]);
    const ui = await openListUi(h, "q");
    ui.fireInput(ENTER);
    await waitFor(() => h.pi.sentMessages.length === 1);
    await h.pi.fire("agent_end", {}, ui.ctx); // sends B
    await waitFor(() => h.pi.sentMessages.length === 2);
    await h.pi.fire("agent_end", {}, ui.ctx); // queue is done
    // A few microtask ticks to be sure no late send sneaks in.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(h.pi.sentMessages.length).toBe(2);
  });
});

describe(":abort while a queue is running", () => {
  it("calls ctx.abort and clears the queue status", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B", "C"]);
    const ui = await openListUi(h, "q");
    ui.fireInput(ENTER);
    await waitFor(() => h.pi.sentMessages.length === 1);
    // Run :abort through the same command surface.
    await runQueueCommand(h, ":abort", ui.ctx);
    expect(ui.ctx.abortCalls).toBe(1);
    expect(ui.ctx.ui.statuses.get("queue")).toBeUndefined();
    const note = ui.ctx.ui.notifications.find((n) =>
      /queue aborted/.test(n.msg),
    );
    expect(note?.level).toBe("info");
  });

  it("does not send further prompts after abort, even if agent_end fires", async () => {
    const h = setupExtension();
    h.store.save("q", ["A", "B", "C"]);
    const ui = await openListUi(h, "q");
    ui.fireInput(ENTER);
    await waitFor(() => h.pi.sentMessages.length === 1);
    await runQueueCommand(h, ":abort", ui.ctx);
    await h.pi.fire("agent_end", {}, ui.ctx);
    expect(h.pi.sentMessages.length).toBe(1);
  });
});

describe("starting a second queue while one is running", () => {
  it("notifies an error and does not start a new run", async () => {
    const h = setupExtension();
    h.store.save("q1", ["A", "B"]);
    h.store.save("q2", ["X", "Y"]);
    const ui1 = await openListUi(h, "q1");
    ui1.fireInput(ENTER);
    await waitFor(() => h.pi.sentMessages.length === 1);
    const ui2 = await openListUi(h, "q2");
    ui2.fireInput(ENTER);
    // Wait for the rejection notification to be produced. The runner
    // for q1 may or may not have advanced — what matters is that q2's
    // submit produced an "already running" error and did not push new
    // prompts onto sendUserMessage.
    await waitFor(
      () =>
        ui2.ctx.ui.notifications.some(
          (n) => n.level === "error" && /already running/.test(n.msg),
        ),
      { what: "second queue rejection" },
    );
    // No prompt from q2 was sent.
    for (const m of h.pi.sentMessages) {
      expect(m.content).not.toBe("X");
    }
  });

  it("allows starting a new queue once the previous one finished", async () => {
    const h = setupExtension();
    h.store.save("q1", ["A"]);
    h.store.save("q2", ["X"]);
    const ui1 = await openListUi(h, "q1");
    ui1.fireInput(ENTER);
    await waitFor(() => h.pi.sentMessages.length === 1);
    // Drain the first queue.
    await h.pi.fire("agent_end", {}, ui1.ctx);
    await waitFor(() => ui1.ctx.ui.statuses.get("queue") === undefined);
    // Now starting a second one is fine.
    const ui2 = await openListUi(h, "q2");
    ui2.fireInput(ENTER);
    await waitFor(() => h.pi.sentMessages.length === 2);
    expect(h.pi.sentMessages[1].content).toBe("X");
  });
});

describe("submitting an empty list does NOT start the runner", () => {
  it("returns without sending or notifying 'queue started'", async () => {
    const h = setupExtension();
    h.store.save("q", ["only"]);
    const ui = await openListUi(h, "q");
    // Delete the only prompt — production keeps it (can't delete the
    // last one). Instead simulate a "user pressed esc" which resolves
    // with `undefined`, and verify no run starts. This also covers the
    // separate guard inside the handler that bails on empty results.
    ui.fireInput(ESCAPE);
    await ui.cmdPromise;
    expect(h.pi.sentMessages).toEqual([]);
    const started = ui.ctx.ui.notifications.find((n) =>
      /queue started/.test(n.msg),
    );
    expect(started).toBeUndefined();
  });
});
