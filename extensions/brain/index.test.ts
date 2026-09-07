/**
 * Integration tests for the brain extension.
 *
 * These tests drive the extension end-to-end through a mock pi API,
 * exactly as the real pi runtime would. The mock pi captures registered
 * commands and event listeners; tests fire lifecycle events and invoke
 * the /brain command handler, then assert on the rendered UI text,
 * filesystem side effects (real tmp PI_BRAIN_DIR), captured pub/sub
 * publishes, and editor spawns.
 *
 * Internal modules (BrainComponent, store, service) are NOT imported
 * directly. The only injected test doubles are:
 *   - `ensureService` — replaced with an in-memory fake client so we
 *     don't fork a real pub/sub subprocess.
 *   - `spawnSync` — replaced with a recorder so we don't actually
 *     invoke an editor.
 *
 * The store layer runs against a real temp directory via PI_BRAIN_DIR,
 * so persistence behavior (sessions.jsonl, status, and pruning) is exercised
 * through the real code paths.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import type { spawnSync as RealSpawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createExtension, type BrainPi } from "./index.js";
import type {
  Client as RealClient,
  PubSubMessage,
  ensureService as RealEnsureService,
} from "./service.js";

const ESC = "\x1b";
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const ENTER = "\r";
const ESCAPE = ESC;
const BACKSPACE = "\x7f";

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * The subset of pi the brain extension consumes is declared in
 * `./index.ts` as `BrainPi`. Importing it here means the mock is
 * automatically forced back into sync if brain ever starts using a
 * new pi method.
 */
type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandConfig = Parameters<BrainPi["registerCommand"]>[1];
type CommandHandler = CommandConfig["handler"];

interface RegisteredCommand {
  name: string;
  config: CommandConfig;
}

interface MockPi extends BrainPi {
  events: Map<string, EventHandler[]>;
  commands: Map<string, RegisteredCommand>;
  /**
   * Fire an event to all registered listeners. Tests pass `MockCtx`,
   * which structurally satisfies the subset of `ExtensionContext` brain
   * uses; the loose accept keeps test call sites free of casts.
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
  const pi: MockPi = {
    events,
    commands,
    on: ((name: string, fn: EventHandler) => {
      const list = events.get(name) ?? [];
      list.push(fn);
      events.set(name, list);
    }) as MockPi["on"],
    registerCommand(name, config) {
      commands.set(name, { name, config });
    },
    async fire(name, event, ctx) {
      const list = events.get(name) ?? [];
      for (const fn of list)
        await fn(event, ctx as unknown as ExtensionContext);
    },
    runCommand(name, args, ctx) {
      const cmd = commands.get(name);
      if (!cmd) throw new Error(`Command not registered: ${name}`);
      // Command handlers take `ExtensionCommandContext` (a superset of
      // `ExtensionContext`); brain only reads the subset MockCtx covers.
      return cmd.config.handler(
        args,
        ctx as unknown as Parameters<CommandHandler>[1],
      );
    },
  };
  return pi;
}

/**
 * The subset of `ExtensionContext` brain reads from. Anchoring to the
 * real type means a drift in pi's API surfaces here at compile time.
 */
type CtxSubset = Pick<ExtensionContext, "cwd" | "hasUI" | "sessionManager">;

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
 * Internal slot tracking the component currently mounted via ui.custom.
 * Tests never reach into this directly; they go through the input/render
 * helpers on `MockUiContext` which mirror what the real pi runtime would
 * do (deliver keys, ask for renders, resolve when done is called).
 */
interface ActiveCustom {
  tui: { requestRender: ReturnType<typeof vi.fn> };
  done: (val: unknown) => void;
  component: CustomComponent;
  promise: Promise<unknown>;
}

interface MockUiContext {
  notifications: Array<{ msg: string; level: "info" | "warning" | "error" }>;
  notify: ExtensionUIContext["notify"];
  custom: ExtensionUIContext["custom"];
  /** Whether a custom component is currently mounted. */
  hasActiveCustom(): boolean;
  /** Mock TUI handed to the active component (exposes requestRender spy). */
  activeTui(): { requestRender: ReturnType<typeof vi.fn> };
  /** Deliver a key/input string to the active custom component. */
  fireInput(input: string): void;
  /** Ask the active custom component to render at the given width. */
  renderActive(width?: number): string[];
  /** Tell the active component its state is dirty (forces re-render). */
  invalidateActive(): void;
  /** Resolve the ui.custom promise as if the user closed the panel. */
  exitActive(value?: unknown): void;
}

interface MockCtx extends CtxSubset {
  ui: MockUiContext;
}

function makeMockCtx(opts?: {
  cwd?: string;
  sessionId?: string | null;
  hasUI?: boolean;
}): MockCtx {
  const sessionId =
    opts && "sessionId" in opts ? opts.sessionId : "session-current";
  let active: ActiveCustom | undefined;
  const requireActive = (): ActiveCustom => {
    if (!active) throw new Error("no active ui.custom component");
    return active;
  };
  const ui: MockUiContext = {
    notifications: [],
    notify(msg, level) {
      ui.notifications.push({ msg, level: level ?? "info" });
    },
    custom: (async (factory: CustomFactory) => {
      const tui = { requestRender: vi.fn() };
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
  const ctx: MockCtx = {
    cwd: opts?.cwd ?? "/home/user/current-project",
    hasUI: opts?.hasUI ?? true,
    sessionManager: {
      getSessionId: () => sessionId ?? null,
    } as ExtensionContext["sessionManager"],
    ui,
  };
  return ctx;
}

/**
 * Public surface of the real `Client` that the brain extension uses.
 * Pinning the fake to this Pick guarantees a drift in service.js will
 * fail to compile here.
 */
type ClientSurface = Pick<
  RealClient,
  "publish" | "onMessage" | "onError" | "disconnect"
>;

interface FakeClient extends ClientSurface {
  connected: boolean;
  published: PubSubMessage[];
  msgHandlers: Array<(msg: PubSubMessage) => void>;
  errHandlers: Array<(err: Error) => void>;
  /** Test helper: fire an inbound message to all subscribers. */
  simulateMessage(msg: PubSubMessage): void;
  /** Test helper: fire an error to all subscribers. */
  simulateError(err: Error): void;
}

function makeFakeClient(): FakeClient {
  const client: FakeClient = {
    connected: true,
    published: [],
    msgHandlers: [],
    errHandlers: [],
    publish(msg) {
      client.published.push(msg);
    },
    onMessage(fn) {
      client.msgHandlers.push(fn);
    },
    onError(fn) {
      client.errHandlers.push(fn);
    },
    disconnect() {
      client.connected = false;
    },
    simulateMessage(msg) {
      for (const fn of client.msgHandlers) fn(msg);
    },
    simulateError(err) {
      for (const fn of client.errHandlers) fn(err);
    },
  };
  return client;
}

type SpawnSyncFn = typeof RealSpawnSync;

interface SpawnRecord {
  cmd: Parameters<SpawnSyncFn>[0];
  args: Parameters<SpawnSyncFn>[1];
  options: Parameters<SpawnSyncFn>[2];
}

/**
 * Build a properly-typed `SpawnSyncReturns<Buffer>`. Using real `Buffer`
 * values for stdout/stderr means the result is structurally assignable
 * to the spawnSync return type without an `as unknown as` cast.
 */
function makeSpawnReturn(opts?: {
  status?: number | null;
  error?: Error;
  stdout?: string;
  stderr?: string;
}): ReturnType<SpawnSyncFn> {
  // `Buffer.alloc` returns `NonSharedBuffer`, which is what spawnSync's
  // most general overload promises in its return type.
  const stdoutBytes = opts?.stdout
    ? Buffer.from(opts.stdout, "utf-8")
    : Buffer.alloc(0);
  const stdout = Buffer.alloc(stdoutBytes.length);
  stdoutBytes.copy(stdout);
  const stderrBytes = opts?.stderr
    ? Buffer.from(opts.stderr, "utf-8")
    : Buffer.alloc(0);
  // Re-allocate into a fresh non-shared buffer so the type matches
  // `NonSharedBuffer` exactly even when stderr text is non-empty.
  const stderr = Buffer.alloc(stderrBytes.length);
  stderrBytes.copy(stderr);
  return {
    pid: 1234,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status: opts?.status ?? 0,
    signal: null,
    error: opts?.error,
  };
}

function makeSpawnSyncMock(opts?: {
  status?: number | null;
  error?: Error;
  stderr?: string;
}) {
  const calls: SpawnRecord[] = [];
  // `vi.fn<SpawnSyncFn>()` types the mock against the overloaded
  // `spawnSync` signature, but `Mock<F>` doesn't fully preserve overload
  // resolution — assigning it to a parameter typed as `F` still requires
  // a structural cast. The single `as unknown as SpawnSyncFn` lives only
  // here, hidden from every test site.
  const mock = vi.fn<SpawnSyncFn>();
  mock.mockImplementation(((cmd, args, options) => {
    calls.push({ cmd, args: args ?? [], options });
    return makeSpawnReturn(opts);
  }) as SpawnSyncFn);
  const fn = mock as unknown as SpawnSyncFn;
  return { fn, mock, calls };
}

let tmpDir: string;
let originalBrainDir: string | undefined;
let originalEditor: string | undefined;
let originalBrainEditor: string | undefined;
let originalBrainHerdr: string | undefined;
let originalHerdrEnv: string | undefined;

function setEnv(dir: string) {
  process.env.PI_BRAIN_DIR = dir;
}

function mkBrainDir(): string {
  const d = mkdtempSync(join(tmpdir(), "brain-int-"));
  mkdirSync(join(d, "status"), { recursive: true });
  return d;
}

beforeEach(() => {
  originalBrainDir = process.env.PI_BRAIN_DIR;
  originalEditor = process.env.EDITOR;
  originalBrainEditor = process.env.BRAIN_EDITOR;
  originalBrainHerdr = process.env.BRAIN_HERDR;
  originalHerdrEnv = process.env.HERDR_ENV;
  delete process.env.BRAIN_HERDR;
  delete process.env.HERDR_ENV;
  tmpDir = mkBrainDir();
  setEnv(tmpDir);
});

afterEach(() => {
  if (originalBrainDir === undefined) delete process.env.PI_BRAIN_DIR;
  else process.env.PI_BRAIN_DIR = originalBrainDir;
  if (originalEditor === undefined) delete process.env.EDITOR;
  else process.env.EDITOR = originalEditor;
  if (originalBrainEditor === undefined) delete process.env.BRAIN_EDITOR;
  else process.env.BRAIN_EDITOR = originalBrainEditor;
  if (originalBrainHerdr === undefined) delete process.env.BRAIN_HERDR;
  else process.env.BRAIN_HERDR = originalBrainHerdr;
  if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = originalHerdrEnv;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  vi.restoreAllMocks();
});

interface Harness {
  pi: MockPi;
  client: FakeClient;
  spawn: ReturnType<typeof makeSpawnSyncMock>;
  /**
   * Number of times `ensureService` has been called and either resolved
   * or rejected. Tests use this to wait deterministically for brain's
   * pub/sub bootstrap to settle without depending on a fixed number of
   * microtask hops, and without needing to know whether the success or
   * failure path ran.
   */
  ensureServiceSettled: { count: number };
}

function setupExtension(opts?: { serviceError?: Error }): Harness {
  const pi = makeMockPi();
  const client = makeFakeClient();
  const spawn = makeSpawnSyncMock();
  const ensureServiceSettled = { count: 0 };
  // The fake `ensureService` matches the real signature, so any drift in
  // service.js surfaces here at compile time. We bump
  // `ensureServiceSettled.count` from a `queueMicrotask` callback so
  // the bump runs *after* brain's `.then`/`.catch` chain on this
  // promise (microtasks queued by the resolution drain in FIFO order).
  // That makes "settled" a true post-condition: by the time the count
  // increments, all of brain's bootstrap side effects — onError
  // registration, publish, or pubsubError — have already happened.
  const ensureService: typeof RealEnsureService = async () => {
    try {
      if (opts?.serviceError) throw opts.serviceError;
      return client as unknown as RealClient;
    } finally {
      queueMicrotask(() => {
        ensureServiceSettled.count += 1;
      });
    }
  };
  createExtension(pi, {
    ensureService,
    spawnSync: spawn.fn,
  });
  return { pi, client, spawn, ensureServiceSettled };
}

/**
 * Wait until `predicate()` is truthy, yielding to the event loop between
 * checks. Replaces fragile fixed-tick `setImmediate` awaits with a
 * condition-based wait that stays correct even if the production code
 * adds or removes microtask boundaries.
 */
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

/** Start a session and wait for the pub/sub client to finish connecting. */
async function startSession(
  harness: Harness,
  opts?: { cwd?: string; sessionId?: string | null },
): Promise<MockCtx> {
  const ctx = makeMockCtx({
    cwd: opts?.cwd ?? "/home/user/current-project",
    ...(opts && "sessionId" in opts ? { sessionId: opts.sessionId } : {}),
  });
  const before = harness.ensureServiceSettled.count;
  await harness.pi.fire("session_start", {}, ctx);
  // Sessions without an id skip the pub/sub bootstrap entirely, so
  // there's nothing to wait for. Otherwise wait for `ensureService` to
  // settle (either success or failure) so brain has finished wiring up
  // its connect handlers and the test can deterministically observe
  // post-connect side effects.
  if (ctx.sessionManager.getSessionId()) {
    await waitFor(() => harness.ensureServiceSettled.count > before, {
      what: "ensureService to settle after session_start",
    });
  }
  return ctx;
}

/**
 * Open the /brain UI. Returns a thin facade whose methods all route
 * through `ctx.ui.*` and `harness.pi/client` — nothing reaches into the
 * component instance directly. From the test's perspective:
 *   - `handleInput`/`render`/`invalidate` look like the pi runtime
 *     dispatching to the mounted custom component.
 *   - `inbound` looks like the pub/sub broker delivering a message.
 *   - `exit` looks like the user closing the panel.
 */
async function openBrainUi(
  harness: Harness,
  ctx: MockCtx,
): Promise<{
  render(width?: number): string[];
  renderText(width?: number): string;
  fireInput(input: string): void;
  invalidate(): void;
  tui: { requestRender: ReturnType<typeof vi.fn> };
  cmdPromise: ReturnType<CommandHandler>;
  /** Trigger an inbound pub/sub message via the fake client. */
  simulateMessage(msg: PubSubMessage): Promise<void>;
  /** Resolve the ui.custom promise (simulating user exit). */
  exit(): void;
}> {
  const cmdPromise = harness.pi.runCommand("brain", "", ctx);
  // The /brain handler calls `ctx.ui.custom(factory)`; the mock sets
  // `hasActiveCustom()` once the factory has produced a Component. This
  // is the only condition the returned facade strictly requires to be
  // safe to use — input/render/exit all need a mounted component.
  //
  // Subscribing to pub/sub messages happens in a separate `.then()` on
  // `getClient()` and may or may not run depending on whether a session
  // was registered (sessionId null → no client) or whether the service
  // came up (serviceError → client is null inside the .then). Tests
  // that need that subscription use `ui.simulateMessage`, which waits for
  // handlers per-call — no need to gate `openBrainUi` on it.
  await waitFor(() => ctx.ui.hasActiveCustom(), {
    what: "ui.custom factory to mount the brain component",
  });
  return {
    render: (width = 80) => ctx.ui.renderActive(width),
    renderText: (width = 80) =>
      ctx.ui.renderActive(width).map(stripAnsi).join("\n"),
    fireInput: (input) => ctx.ui.fireInput(input),
    invalidate: () => ctx.ui.invalidateActive(),
    tui: ctx.ui.activeTui(),
    cmdPromise,
    /**
     * Deliver a pub/sub message to the brain UI. Waits for brain to
     * have actually subscribed (the `getClient().then()` chain runs on
     * a microtask after `ui.custom` mounts) before firing, so callers
     * never observe a silent no-op.
     */
    simulateMessage: async (msg) => {
      await waitFor(() => harness.client.msgHandlers.length > 0, {
        what: "brain to subscribe to pub/sub messages",
      });
      harness.client.simulateMessage(msg);
    },
    exit: () => ctx.ui.exitActive(),
  };
}

describe("session_start persists session entry", () => {
  it("appends a session entry to sessions.jsonl on session_start", async () => {
    const h = setupExtension();
    await startSession(h, { cwd: "/tmp/project-a", sessionId: "s1" });
    const raw = readFileSync(join(tmpDir, "sessions.jsonl"), "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.sessionId).toBe("s1");
    expect(entry.dir).toBe("/tmp/project-a");
    expect(entry.lastFocused).toBeTypeOf("number");
  });

  it("creates status storage without log storage", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "brain-fresh-"));
    setEnv(fresh);
    const h = setupExtension();
    await startSession(h, { cwd: "/tmp/x", sessionId: "sx" });
    expect(existsSync(join(fresh, "status"))).toBe(true);
    expect(existsSync(join(fresh, "logs"))).toBe(false);
    rmSync(fresh, { recursive: true, force: true });
  });

  it("does not store tool output", async () => {
    const h = setupExtension();
    const ctx = await startSession(h, { sessionId: "s1" });
    await h.pi.fire(
      "tool_result",
      { toolName: "bash", content: [{ type: "text", text: "secret output" }] },
      ctx,
    );
    expect(existsSync(join(tmpDir, "logs"))).toBe(false);
  });

  it("publishes sessions_changed when service connects", async () => {
    const h = setupExtension();
    await startSession(h, { sessionId: "s1" });
    expect(h.client.published.some((m) => m.type === "sessions_changed")).toBe(
      true,
    );
  });

  it("does not register a session when sessionId is null", async () => {
    const h = setupExtension();
    await startSession(h, { sessionId: null });
    // pruneOldSessions runs at start and may create an empty file, but no
    // session entry should have been appended. Reading the file (if any)
    // must yield empty content.
    const path = join(tmpDir, "sessions.jsonl");
    const content = existsSync(path) ? readFileSync(path, "utf-8") : "";
    expect(content.trim()).toBe("");
  });
});

describe("agent_start / agent_end update status", () => {
  it("writes 'working' status on agent_start", async () => {
    const h = setupExtension();
    const ctx = await startSession(h, { sessionId: "s1" });
    await h.pi.fire("agent_start", {}, ctx);
    const statusRaw = readFileSync(
      join(tmpDir, "status", "s1.status"),
      "utf-8",
    );
    expect(JSON.parse(statusRaw).state).toBe("working");
  });

  it("writes 'idle' status on agent_end", async () => {
    const h = setupExtension();
    const ctx = await startSession(h, { sessionId: "s1" });
    await h.pi.fire("agent_start", {}, ctx);
    await h.pi.fire("agent_end", {}, ctx);
    const statusRaw = readFileSync(
      join(tmpDir, "status", "s1.status"),
      "utf-8",
    );
    expect(JSON.parse(statusRaw).state).toBe("idle");
  });

  it("publishes a status message on agent_start", async () => {
    const h = setupExtension();
    const ctx = await startSession(h, {
      cwd: "/tmp/p",
      sessionId: "s1",
    });
    h.client.published.length = 0;
    await h.pi.fire("agent_start", {}, ctx);
    const msg = h.client.published.find((m) => m.type === "status");
    expect(msg).toBeDefined();
    expect(msg).toMatchObject({
      type: "status",
      sessionId: "s1",
      dir: "/tmp/p",
      state: "working",
    });
  });

  it("publishes a status message on agent_end", async () => {
    const h = setupExtension();
    const ctx = await startSession(h, { cwd: "/tmp/p", sessionId: "s1" });
    h.client.published.length = 0;
    await h.pi.fire("agent_end", {}, ctx);
    const msg = h.client.published.find((m) => m.type === "status");
    expect(msg).toMatchObject({ state: "idle" });
  });
});

describe("session_shutdown", () => {
  it("writes idle status and publishes idle status", async () => {
    const h = setupExtension();
    const ctx = await startSession(h, { sessionId: "s1" });
    await h.pi.fire("agent_start", {}, ctx);
    h.client.published.length = 0;
    await h.pi.fire("session_shutdown", {}, ctx);
    const statusRaw = readFileSync(
      join(tmpDir, "status", "s1.status"),
      "utf-8",
    );
    expect(JSON.parse(statusRaw).state).toBe("idle");
    const idleMsg = h.client.published.find(
      (m) => m.type === "status" && m.state === "idle",
    );
    expect(idleMsg).toBeDefined();
  });

  it("disconnects the pub/sub client", async () => {
    const h = setupExtension();
    const ctx = await startSession(h, { sessionId: "s1" });
    expect(h.client.connected).toBe(true);
    await h.pi.fire("session_shutdown", {}, ctx);
    expect(h.client.connected).toBe(false);
  });
});

describe("startup prunes old sessions", () => {
  it("removes entries older than 180 days from sessions.jsonl", async () => {
    const oldTime = Date.now() - 200 * 24 * 60 * 60 * 1000;
    const file = join(tmpDir, "sessions.jsonl");
    writeFileSync(
      file,
      JSON.stringify({
        sessionId: "old",
        dir: "/tmp/old",
        branch: null,
        timestamp: oldTime,
        lastFocused: oldTime,
      }) + "\n",
    );
    writeFileSync(join(tmpDir, "status", "old.status"), '{"state":"idle"}');

    const h = setupExtension();
    await startSession(h, { sessionId: "new", cwd: "/tmp/new" });

    // After session_start, old entries pruned.
    const raw = readFileSync(file, "utf-8");
    const entries = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(entries.find((e) => e.sessionId === "old")).toBeUndefined();
    expect(entries.find((e) => e.sessionId === "new")).toBeDefined();
    expect(existsSync(join(tmpDir, "status", "old.status"))).toBe(false);
  });
});

describe("pub/sub service failures", () => {
  it("displays an error notification in the UI when service fails to start", async () => {
    const h = setupExtension({ serviceError: new Error("spawn EACCES") });
    const ctx = await startSession(h, { sessionId: "s1" });
    const ui = await openBrainUi(h, ctx);
    expect(ui.renderText()).toContain("spawn EACCES");
  });

  it("displays an error when the service connection is lost mid-session", async () => {
    const h = setupExtension();
    const ctx = await startSession(h, { sessionId: "s1" });
    h.client.simulateError(new Error("socket closed"));
    const ui = await openBrainUi(h, ctx);
    expect(ui.renderText()).toContain("socket closed");
  });
});

describe("/brain command registration", () => {
  it("registers a /brain command", () => {
    const h = setupExtension();
    expect(h.pi.commands.has("brain")).toBe(true);
  });

  it("notifies error and returns when invoked without TUI", async () => {
    const h = setupExtension();
    const ctx = makeMockCtx({ hasUI: false });
    await h.pi.runCommand("brain", "", ctx);
    expect(ctx.ui.notifications.some((n) => /TUI mode/.test(n.msg))).toBe(true);
  });
});

/** Seed the brain data dir with a fixed dataset and return the ctx. */
async function seedAndOpenUi(opts?: {
  cwd?: string;
  sessionId?: string;
  /** If provided, write a custom sessions.jsonl. Otherwise seed defaults. */
  sessions?: Array<{
    sessionId: string;
    dir: string;
    branch: string | null;
    lastFocused?: number;
    timestamp?: number;
  }>;
  statuses?: Record<string, "working" | "idle">;
}) {
  const now = Date.now();
  const sessions = opts?.sessions ?? [
    { sessionId: "s1", dir: "/home/user/alpha", branch: "main" },
    { sessionId: "s2", dir: "/home/user/beta", branch: "feat/login" },
    { sessionId: "s3", dir: "/home/user/gamma", branch: null },
  ];
  // Today vs earlier: default to today by giving them recent timestamps.
  let content = "";
  sessions.forEach((s, i) => {
    content +=
      JSON.stringify({
        sessionId: s.sessionId,
        dir: s.dir,
        branch: s.branch,
        timestamp: s.timestamp ?? now - i,
        lastFocused: s.lastFocused ?? now - i,
      }) + "\n";
  });
  if (opts?.statuses) {
    for (const [sid, state] of Object.entries(opts.statuses)) {
      writeFileSync(
        join(tmpDir, "status", `${sid}.status`),
        JSON.stringify({ state, updatedAt: Date.now() }),
      );
    }
  }

  const h = setupExtension();
  // `startSession` fires session_start (which wires up the pub/sub
  // client and appends a row for the current session) and waits for
  // the bootstrap to settle deterministically.
  const ctx = await startSession(h, {
    cwd: opts?.cwd ?? "/home/user/current-project",
    sessionId: opts?.sessionId ?? "session-current",
  });
  // Overwrite sessions.jsonl with the seed so /brain sees only seeded
  // data (this drops the row session_start just appended).
  writeFileSync(join(tmpDir, "sessions.jsonl"), content);
  const ui = await openBrainUi(h, ctx);
  return { h, ctx, ui };
}

describe("/brain header", () => {
  it("shows the cwd basename and branch in the header", async () => {
    const { ui } = await seedAndOpenUi({ cwd: "/home/user/my-project" });
    const text = ui.renderText();
    expect(text).toContain("my-project");
  });

  it("does not render '[null]' when there is no branch", async () => {
    const { ui } = await seedAndOpenUi({ cwd: "/tmp/no-git-repo" });
    expect(ui.renderText()).not.toContain("[null]");
  });
});

describe("/brain directory list", () => {
  it("renders the Today and Earlier sections without a log panel", async () => {
    const { ui } = await seedAndOpenUi();
    const text = ui.renderText();
    expect(text).toContain("Today");
    expect(text).toContain("Earlier");
    expect(text).not.toContain("Logs");
    expect(text).not.toContain("│");
  });

  it("places a recent session in Today and an old one in Earlier", async () => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const yesterday = todayStart.getTime() - 1000;
    const now = Date.now();
    const { ui } = await seedAndOpenUi({
      sessions: [
        {
          sessionId: "s1",
          dir: "/home/user/today-proj",
          branch: null,
          lastFocused: now,
          timestamp: now,
        },
        {
          sessionId: "s2",
          dir: "/home/user/yesterday-proj",
          branch: null,
          lastFocused: yesterday,
          timestamp: yesterday,
        },
      ],
    });
    const lines = ui.render().map(stripAnsi);
    const todayIdx = lines.findIndex((l) => l.includes("Today"));
    const earlierIdx = lines.findIndex((l) => l.includes("Earlier"));
    expect(todayIdx).toBeGreaterThan(-1);
    expect(earlierIdx).toBeGreaterThan(todayIdx);
    const todayBlock = lines.slice(todayIdx, earlierIdx).join("\n");
    const earlierBlock = lines.slice(earlierIdx).join("\n");
    expect(todayBlock).toContain("today-proj");
    expect(earlierBlock).toContain("yesterday-proj");
  });

  it("shows cursor highlight (>) on the focused entry", async () => {
    const { ui } = await seedAndOpenUi();
    expect(ui.renderText()).toContain("> alpha");
  });

  it("renders branch in [brackets] for entries that have one", async () => {
    const { ui } = await seedAndOpenUi();
    const text = ui.renderText();
    expect(text).toContain("alpha [main]");
    expect(text).toContain("beta [feat/login]");
  });

  it("respects width — no rendered line exceeds the requested width", async () => {
    const { ui } = await seedAndOpenUi();
    const width = 60;
    for (const line of ui.render(width)) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
    }
  });

  it("renders empty state when there are no sessions", async () => {
    // Wipe the seeded file
    writeFileSync(join(tmpDir, "sessions.jsonl"), "");
    const h = setupExtension();
    const ctx = makeMockCtx();
    const ui = await openBrainUi(h, ctx);
    const text = ui.renderText();
    expect(text).toContain("Today");
    expect(text).toContain("Earlier");
    expect(text).not.toContain("Logs");
  });
});

describe("/brain navigation", () => {
  // Default seed has 3 today entries: alpha, beta, gamma (in that order).
  // No earlier entries by default.
  // To exercise wrapping we add Earlier entries via timestamps.

  async function seedTodayEarlier() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const yesterday = todayStart.getTime() - 1000;
    const now = Date.now();
    return seedAndOpenUi({
      sessions: [
        {
          sessionId: "s1",
          dir: "/u/alpha",
          branch: "main",
          lastFocused: now,
          timestamp: now,
        },
        {
          sessionId: "s2",
          dir: "/u/beta",
          branch: "feat/login",
          lastFocused: now - 1,
          timestamp: now - 1,
        },
        {
          sessionId: "s3",
          dir: "/u/gamma",
          branch: null,
          lastFocused: now - 2,
          timestamp: now - 2,
        },
        {
          sessionId: "s4",
          dir: "/u/delta",
          branch: "develop",
          lastFocused: yesterday,
          timestamp: yesterday,
        },
        {
          sessionId: "s5",
          dir: "/u/epsilon",
          branch: null,
          lastFocused: yesterday - 1,
          timestamp: yesterday - 1,
        },
      ],
    });
  }

  it("DOWN moves cursor to the next entry", async () => {
    const { ui } = await seedTodayEarlier();
    ui.fireInput(DOWN);
    expect(ui.renderText()).toContain("> beta");
  });

  it("UP from first entry wraps to the last (earlier) entry", async () => {
    const { ui } = await seedTodayEarlier();
    ui.fireInput(UP);
    expect(ui.renderText()).toContain("> epsilon");
  });

  it("DOWN past last entry wraps back to first today entry", async () => {
    const { ui } = await seedTodayEarlier();
    for (let i = 0; i < 5; i++) ui.fireInput(DOWN);
    expect(ui.renderText()).toContain("> alpha");
  });

  it("DOWN from last today entry crosses into Earlier", async () => {
    const { ui } = await seedTodayEarlier();
    ui.fireInput(DOWN);
    ui.fireInput(DOWN);
    ui.fireInput(DOWN); // delta
    expect(ui.renderText()).toContain("> delta");
  });
});

describe("/brain search", () => {
  it("filters the lists when typing after '/'", async () => {
    const { ui } = await seedAndOpenUi();
    ui.fireInput("/");
    for (const c of "alph") ui.fireInput(c); // matches only alpha
    const text = ui.renderText();
    expect(text).toContain("alpha");
    expect(text).not.toMatch(/\bbeta\b/);
  });

  it("accepts kitty-protocol-encoded keystrokes", async () => {
    const { ui } = await seedAndOpenUi();
    ui.fireInput("/");
    ui.fireInput("\x1b[97u"); // 'a' via kitty
    ui.fireInput("\x1b[98u"); // 'b'
    expect(ui.renderText()).toContain("/ ab_");
  });

  it("ESC clears the filter and exits search mode", async () => {
    const { ui } = await seedAndOpenUi();
    ui.fireInput("/");
    ui.fireInput("z");
    ui.fireInput(ESCAPE);
    const text = ui.renderText();
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).not.toContain("/ _");
  });

  it("ENTER keeps the active filter", async () => {
    const { ui } = await seedAndOpenUi();
    ui.fireInput("/");
    for (const c of "alph") ui.fireInput(c);
    ui.fireInput(ENTER);
    const text = ui.renderText();
    expect(text).toContain("alpha");
    expect(text).not.toContain("beta [feat/login]");
  });

  it("BACKSPACE to empty exits search", async () => {
    const { ui } = await seedAndOpenUi();
    ui.fireInput("/");
    ui.fireInput("a");
    ui.fireInput(BACKSPACE);
    const text = ui.renderText();
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).not.toContain("/ _");
  });

  it("arrow keys still navigate while search is open", async () => {
    const { ui } = await seedAndOpenUi();
    ui.fireInput("/");
    ui.fireInput("a");
    ui.fireInput(DOWN);
    expect(ui.renderText()).toContain("/ a_");
  });
});

describe("/brain ESC exits", () => {
  it("ESC from dirs panel calls done() (resolves the ui.custom)", async () => {
    const h = setupExtension();
    const ctx = makeMockCtx();
    const ui = await openBrainUi(h, ctx);
    ui.fireInput(ESCAPE);
    // The ui.custom promise should now resolve.
    await ui.cmdPromise; // does not throw / hang
  });
});

describe("/brain ENTER opens directory", () => {
  it("invokes the editor for the cursor's directory", async () => {
    const { h, ui } = await seedAndOpenUi();
    ui.fireInput(ENTER);
    expect(h.spawn.calls.length).toBe(1);
    // Either via `/usr/bin/open -a` (mac GUI editor) or directly via $EDITOR.
    // The absolute path of /home/user/alpha must appear in args.
    expect(h.spawn.calls[0].args.join(" ")).toContain("/home/user/alpha");
  });

  it("reports an error when Herdr mode runs outside Herdr", async () => {
    process.env.BRAIN_HERDR = "1";
    const { h, ctx, ui } = await seedAndOpenUi();

    ui.fireInput(ENTER);

    expect(h.spawn.mock).not.toHaveBeenCalled();
    expect(ctx.ui.notifications).toContainEqual({
      msg: "Failed to open /home/user/alpha: Herdr mode requires HERDR_ENV=1",
      level: "error",
    });
  });

  it("focuses an existing Herdr workspace for the directory", async () => {
    process.env.BRAIN_HERDR = "1";
    process.env.HERDR_ENV = "1";
    const { h, ui } = await seedAndOpenUi();
    h.spawn.mock
      .mockImplementationOnce(() =>
        makeSpawnReturn({
          stdout: JSON.stringify({
            result: {
              snapshot: {
                panes: [
                  { cwd: "/home/user/alpha", workspace_id: "workspace-7" },
                ],
              },
            },
          }),
        }),
      )
      .mockImplementationOnce(() => makeSpawnReturn());

    ui.fireInput(ENTER);

    expect(h.spawn.mock).toHaveBeenNthCalledWith(
      1,
      "herdr",
      ["api", "snapshot"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
    expect(h.spawn.mock).toHaveBeenNthCalledWith(
      2,
      "herdr",
      ["workspace", "focus", "workspace-7"],
      expect.any(Object),
    );
  });

  it("creates a focused Herdr workspace for a new directory", async () => {
    process.env.BRAIN_HERDR = "1";
    process.env.HERDR_ENV = "1";
    const { h, ui } = await seedAndOpenUi();
    h.spawn.mock
      .mockImplementationOnce(() =>
        makeSpawnReturn({
          stdout: JSON.stringify({
            result: { snapshot: { panes: [] } },
          }),
        }),
      )
      .mockImplementationOnce(() => makeSpawnReturn());

    ui.fireInput(ENTER);

    expect(h.spawn.mock).toHaveBeenNthCalledWith(
      2,
      "herdr",
      ["workspace", "create", "--cwd", "/home/user/alpha", "--focus"],
      expect.any(Object),
    );
  });

  it("uses BRAIN_EDITOR instead of EDITOR when it is set", async () => {
    process.env.BRAIN_EDITOR = "brain-editor";
    process.env.EDITOR = "regular-editor";
    const { h, ui } = await seedAndOpenUi();

    ui.fireInput(ENTER);

    expect(h.spawn.calls).toHaveLength(1);
    expect(h.spawn.calls[0].cmd).toBe("brain-editor");
    expect(h.spawn.calls[0].args).toEqual(["/home/user/alpha"]);
  });

  it("falls back to EDITOR when BRAIN_EDITOR is not set", async () => {
    delete process.env.BRAIN_EDITOR;
    process.env.EDITOR = "regular-editor";
    const { h, ui } = await seedAndOpenUi();

    ui.fireInput(ENTER);

    expect(h.spawn.calls).toHaveLength(1);
    expect(h.spawn.calls[0].cmd).toBe("regular-editor");
    expect(h.spawn.calls[0].args).toEqual(["/home/user/alpha"]);
  });

  it("publishes sessions_changed and writes a recordFocus entry", async () => {
    const { h, ui } = await seedAndOpenUi();
    h.client.published.length = 0;
    ui.fireInput(ENTER);
    // `publishMessage` awaits `getClient()` before publishing, so the
    // call is microtask-deferred. Wait for the published-messages
    // array to grow rather than guessing how many ticks that takes.
    await waitFor(() => h.client.published.length > 0, {
      what: "sessions_changed to be published after open-dir",
    });
    expect(h.client.published.some((m) => m.type === "sessions_changed")).toBe(
      true,
    );
    // sessions.jsonl now has an extra row for s1 with newer lastFocused
    const lines = readFileSync(join(tmpDir, "sessions.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const s1Entries = lines.filter((l) => l.sessionId === "s1");
    expect(s1Entries.length).toBeGreaterThan(1);
  });

  it("notifies on editor failure (non-zero exit)", async () => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const now = Date.now();
    const h = setupExtension();
    h.spawn.mock.mockImplementation(() =>
      makeSpawnReturn({ status: 1, stderr: "boom" }),
    );
    writeFileSync(
      join(tmpDir, "sessions.jsonl"),
      JSON.stringify({
        sessionId: "s1",
        dir: "/home/user/alpha",
        branch: null,
        timestamp: now,
        lastFocused: now,
      }) + "\n",
    );
    const ctx = makeMockCtx();
    const ui = await openBrainUi(h, ctx);
    ui.fireInput(ENTER);
    expect(
      ctx.ui.notifications.some((n) => /Failed to open .*alpha/.test(n.msg)),
    ).toBe(true);
  });

  it("exits instead of opening when selecting our own session in our own cwd", async () => {
    const h = setupExtension();
    // `startSession` populates the closure sessionId in the extension
    // (the BrainComponent only enters its "exit instead of open"
    // branch when it knows the current sessionId) and waits for the
    // pub/sub bootstrap to settle deterministically.
    const ctx = await startSession(h, {
      cwd: "/home/user/alpha",
      sessionId: "session-current",
    });
    const now = Date.now();
    writeFileSync(
      join(tmpDir, "sessions.jsonl"),
      JSON.stringify({
        sessionId: "session-current",
        dir: "/home/user/alpha",
        branch: null,
        timestamp: now,
        lastFocused: now,
      }) + "\n",
    );
    const ui = await openBrainUi(h, ctx);
    ui.fireInput(ENTER);
    await ui.cmdPromise; // exited via done()
    expect(h.spawn.calls.length).toBe(0);
  });

  it("opens a sibling session in the same directory rather than exiting", async () => {
    const now = Date.now();
    writeFileSync(
      join(tmpDir, "sessions.jsonl"),
      JSON.stringify({
        sessionId: "s1", // different session id
        dir: "/home/user/alpha",
        branch: null,
        timestamp: now,
        lastFocused: now,
      }) + "\n",
    );
    const h = setupExtension();
    const ctx = makeMockCtx({
      cwd: "/home/user/alpha",
      sessionId: "session-current",
    });
    const ui = await openBrainUi(h, ctx);
    ui.fireInput(ENTER);
    expect(h.spawn.calls.length).toBe(1);
  });
});

describe("inbound status messages", () => {
  it("updates the active flag (spinner) when a working status is received", async () => {
    const { ui } = await seedAndOpenUi();
    await ui.simulateMessage({
      type: "status",
      sessionId: "s1",
      dir: "/home/user/alpha",
      branch: "main",
      state: "working",
    });
    const text = ui.renderText();
    const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    expect(spinnerFrames.some((f) => text.includes(f))).toBe(true);
  });

  it("updates the branch label when the status message has a new branch", async () => {
    const { ui } = await seedAndOpenUi();
    expect(ui.renderText()).toContain("alpha [main]");
    await ui.simulateMessage({
      type: "status",
      sessionId: "s1",
      dir: "/home/user/alpha",
      branch: "feat/new",
      state: "working",
    });
    const text = ui.renderText();
    expect(text).toContain("alpha [feat/new]");
    expect(text).not.toContain("alpha [main]");
  });

  it("clears the branch label when the status message has a null branch", async () => {
    const { ui } = await seedAndOpenUi();
    expect(ui.renderText()).toContain("alpha [main]");
    await ui.simulateMessage({
      type: "status",
      sessionId: "s1",
      dir: "/home/user/alpha",
      branch: null,
      state: "idle",
    });
    const lines = ui.render(80).map(stripAnsi);
    const alphaLine = lines.find((l) => l.includes("alpha"));
    expect(alphaLine).toBeDefined();
    expect(alphaLine).not.toContain("[main]");
  });

  it("re-requests a render on every status message", async () => {
    const { ui } = await seedAndOpenUi();
    ui.tui.requestRender.mockClear();
    await ui.simulateMessage({
      type: "status",
      sessionId: "s1",
      dir: "/home/user/alpha",
      branch: "main",
      state: "working",
    });
    expect(ui.tui.requestRender).toHaveBeenCalled();
  });
});

describe("inbound sessions_changed messages", () => {
  it("re-reads sessions and refreshes the list", async () => {
    const { ui } = await seedAndOpenUi();
    expect(ui.renderText()).toContain("alpha");
    // Replace the sessions on disk with a different set
    const now = Date.now();
    writeFileSync(
      join(tmpDir, "sessions.jsonl"),
      JSON.stringify({
        sessionId: "s9",
        dir: "/home/user/new-project",
        branch: "feat",
        timestamp: now,
        lastFocused: now,
      }) + "\n",
    );
    await ui.simulateMessage({ type: "sessions_changed" });
    const text = ui.renderText();
    expect(text).toContain("new-project");
    expect(text).not.toContain("alpha");
  });

  it("preserves the search filter across sessions_changed", async () => {
    const { ui } = await seedAndOpenUi();
    ui.fireInput("/");
    for (const c of "alp") ui.fireInput(c);
    ui.fireInput(ENTER);
    // Simulate disk change with new entry that wouldn't match the filter
    const now = Date.now();
    writeFileSync(
      join(tmpDir, "sessions.jsonl"),
      JSON.stringify({
        sessionId: "s1",
        dir: "/home/user/alpha",
        branch: "main",
        timestamp: now,
        lastFocused: now,
      }) +
        "\n" +
        JSON.stringify({
          sessionId: "s9",
          dir: "/home/user/zeta",
          branch: null,
          timestamp: now - 1,
          lastFocused: now - 1,
        }) +
        "\n",
    );
    await ui.simulateMessage({ type: "sessions_changed" });
    const text = ui.renderText();
    expect(text).toContain("alpha");
    expect(text).not.toContain("zeta");
  });
});

describe("inbound error messages", () => {
  it("shows the error notification on the UI", async () => {
    const { ui } = await seedAndOpenUi();
    await ui.simulateMessage({
      type: "error",
      sessionId: "s1",
      message: "Service crashed!",
    });
    expect(ui.renderText()).toContain("Service crashed!");
  });

  it("triggers a re-render", async () => {
    const { ui } = await seedAndOpenUi();
    ui.tui.requestRender.mockClear();
    await ui.simulateMessage({
      type: "error",
      sessionId: "s1",
      message: "oops",
    });
    expect(ui.tui.requestRender).toHaveBeenCalled();
  });
});

describe("/brain earlier list scrolling", () => {
  function manyEarlier(count: number) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const yesterday = todayStart.getTime() - 1000;
    const now = Date.now();
    const sessions: Array<{
      sessionId: string;
      dir: string;
      branch: string | null;
      lastFocused: number;
      timestamp: number;
    }> = [
      // Two today entries
      {
        sessionId: "t1",
        dir: "/u/t1",
        branch: null,
        lastFocused: now,
        timestamp: now,
      },
      {
        sessionId: "t2",
        dir: "/u/t2",
        branch: null,
        lastFocused: now - 1,
        timestamp: now - 1,
      },
    ];
    for (let i = 1; i <= count; i++) {
      sessions.push({
        sessionId: `e${i}`,
        dir: `/u/e${i}`,
        branch: null,
        lastFocused: yesterday - i,
        timestamp: yesterday - i,
      });
    }
    return sessions;
  }

  function getVisibleEarlierItems(lines: string[]): string[] {
    const items: string[] = [];
    let inEarlier = false;
    for (const line of lines) {
      const left = line.split("│")[0] ?? "";
      if (left.includes("Earlier")) {
        inEarlier = true;
        continue;
      }
      if (inEarlier) {
        const trimmed = left.trim();
        if (/^─+$/.test(trimmed)) break;
        if (trimmed.length > 0) items.push(trimmed);
      }
    }
    return items;
  }

  it("shows all earlier items if they fit", async () => {
    const { ui } = await seedAndOpenUi({ sessions: manyEarlier(3) });
    const items = getVisibleEarlierItems(ui.render().map(stripAnsi));
    expect(items.length).toBe(3);
  });

  it("windows the earlier items when there are too many to fit", async () => {
    const { ui } = await seedAndOpenUi({ sessions: manyEarlier(30) });
    const items = getVisibleEarlierItems(ui.render().map(stripAnsi));
    expect(items.length).toBeLessThan(30);
    expect(items.length).toBeGreaterThan(0);
  });

  it("d pages cursor down through earlier items", async () => {
    const { ui } = await seedAndOpenUi({ sessions: manyEarlier(30) });
    ui.fireInput(DOWN); // t2
    ui.fireInput(DOWN); // e1
    expect(ui.renderText()).toContain("> e1");
    ui.fireInput("d");
    expect(ui.renderText()).not.toContain("> e1");
    expect(ui.renderText()).toContain(">");
  });

  it("u pages cursor up through earlier items", async () => {
    const { ui } = await seedAndOpenUi({ sessions: manyEarlier(30) });
    ui.fireInput(DOWN);
    ui.fireInput(DOWN);
    ui.fireInput("G");
    ui.fireInput("u");
    const text = ui.renderText();
    expect(text).not.toContain("> e30");
    expect(text).toContain(">");
  });

  it("g jumps to first earlier and G jumps to last earlier", async () => {
    const { ui } = await seedAndOpenUi({ sessions: manyEarlier(30) });
    ui.fireInput(DOWN);
    ui.fireInput(DOWN); // e1
    ui.fireInput("G");
    expect(ui.renderText()).toContain("> e30");
    ui.fireInput("g");
    expect(ui.renderText()).toContain("> e1");
  });

  it("today entries remain fully visible regardless of earlier scroll", async () => {
    const { ui } = await seedAndOpenUi({ sessions: manyEarlier(30) });
    ui.fireInput(DOWN);
    ui.fireInput(DOWN);
    ui.fireInput(DOWN);
    ui.fireInput("G");
    const text = ui.renderText();
    expect(text).toContain("t1");
    expect(text).toContain("t2");
  });

  it("d/u/g/G are no-ops when cursor is on a today entry", async () => {
    const { ui } = await seedAndOpenUi({ sessions: manyEarlier(30) });
    const before = getVisibleEarlierItems(ui.render().map(stripAnsi));
    ui.fireInput("d");
    const after = getVisibleEarlierItems(ui.render().map(stripAnsi));
    expect(after).toEqual(before);
  });
});

describe("filterDirs (via search input)", () => {
  it("filters by basename (case-insensitive)", async () => {
    const { ui } = await seedAndOpenUi();
    ui.fireInput("/");
    for (const c of "Alph") ui.fireInput(c);
    const text = ui.renderText();
    expect(text).toContain("alpha");
    expect(text).not.toContain("> beta");
  });

  it("filters by branch name", async () => {
    const { ui } = await seedAndOpenUi();
    ui.fireInput("/");
    for (const c of "login") ui.fireInput(c);
    const text = ui.renderText();
    expect(text).toContain("beta");
    expect(text).not.toContain("> alpha");
  });

  it("returns no items for non-matching query", async () => {
    const { ui } = await seedAndOpenUi();
    ui.fireInput("/");
    ui.fireInput("z");
    const text = ui.renderText();
    expect(text).not.toContain("alpha");
    expect(text).not.toContain("beta");
    expect(text).not.toContain("gamma");
  });
});

describe("readSessions semantics (asserted via /brain UI)", () => {
  it("deduplicates by directory, keeping the latest entry's branch", async () => {
    const now = Date.now();
    const file = join(tmpDir, "sessions.jsonl");
    writeFileSync(
      file,
      JSON.stringify({
        sessionId: "s1",
        dir: "/tmp/a",
        branch: null,
        timestamp: now - 1000,
        lastFocused: now - 1000,
      }) +
        "\n" +
        JSON.stringify({
          sessionId: "s1",
          dir: "/tmp/a",
          branch: "main",
          timestamp: now,
          lastFocused: now,
        }) +
        "\n",
    );
    const h = setupExtension();
    const ctx = makeMockCtx();
    const ui = await openBrainUi(h, ctx);
    const text = ui.renderText();
    expect(text).toContain("a [main]"); // latest branch wins
  });

  it("sorts by most recently focused first", async () => {
    const now = Date.now();
    writeFileSync(
      join(tmpDir, "sessions.jsonl"),
      JSON.stringify({
        sessionId: "s1",
        dir: "/tmp/a",
        branch: null,
        timestamp: now - 2000,
        lastFocused: now - 2000,
      }) +
        "\n" +
        JSON.stringify({
          sessionId: "s2",
          dir: "/tmp/b",
          branch: null,
          timestamp: now - 1000,
          lastFocused: now,
        }) +
        "\n",
    );
    const h = setupExtension();
    const ui = await openBrainUi(h, makeMockCtx());
    const text = ui.renderText();
    const idxB = text.indexOf("b");
    const idxA = text.indexOf("\na", idxB);
    expect(idxB).toBeGreaterThan(-1);
    // 'b' (most recent) should appear before the 'a' line
    expect(idxA === -1 || idxA > idxB).toBe(true);
  });

  it("populates the active flag from the status file on disk", async () => {
    const now = Date.now();
    writeFileSync(
      join(tmpDir, "sessions.jsonl"),
      JSON.stringify({
        sessionId: "s1",
        dir: "/tmp/active",
        branch: null,
        timestamp: now,
        lastFocused: now,
      }) + "\n",
    );
    writeFileSync(
      join(tmpDir, "status", "s1.status"),
      JSON.stringify({ state: "working", updatedAt: Date.now() }),
    );
    const h = setupExtension();
    const ui = await openBrainUi(h, makeMockCtx());
    const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    expect(spinnerFrames.some((f) => ui.renderText().includes(f))).toBe(true);
  });

  it("prunes entries older than 180 days when reading", async () => {
    const now = Date.now();
    const oldTime = now - 181 * 24 * 60 * 60 * 1000;
    writeFileSync(
      join(tmpDir, "sessions.jsonl"),
      JSON.stringify({
        sessionId: "s1",
        dir: "/tmp/very-old",
        branch: null,
        timestamp: oldTime,
        lastFocused: oldTime,
      }) +
        "\n" +
        JSON.stringify({
          sessionId: "s2",
          dir: "/tmp/fresh",
          branch: null,
          timestamp: now,
          lastFocused: now,
        }) +
        "\n",
    );
    const h = setupExtension();
    const ui = await openBrainUi(h, makeMockCtx());
    const text = ui.renderText();
    expect(text).toContain("fresh");
    expect(text).not.toContain("very-old");
  });
});

describe("inbound idle status clears the spinner", () => {
  // From deleted brain.test.ts → "clears active flag when status is idle".
  it("removes the spinner after a working session goes idle", async () => {
    const { ui } = await seedAndOpenUi();
    const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    await ui.simulateMessage({
      type: "status",
      sessionId: "s1",
      dir: "/home/user/alpha",
      branch: "main",
      state: "working",
    });
    expect(spinnerFrames.some((f) => ui.renderText().includes(f))).toBe(true);
    await ui.simulateMessage({
      type: "status",
      sessionId: "s1",
      dir: "/home/user/alpha",
      branch: "main",
      state: "idle",
    });
    expect(spinnerFrames.some((f) => ui.renderText().includes(f))).toBe(false);
  });
});

describe("stale working status does not show spinner", () => {
  // From deleted store.test.ts → "isSessionActive returns false for stale
  // working status (> 5 min)". Asserted through the UI: a working status
  // older than 5 minutes is treated as inactive on startup.
  it("a working status updated > 5 minutes ago is treated as idle", async () => {
    const now = Date.now();
    const stale = now - 6 * 60 * 1000;
    writeFileSync(
      join(tmpDir, "sessions.jsonl"),
      JSON.stringify({
        sessionId: "s1",
        dir: "/home/user/alpha",
        branch: "main",
        timestamp: now,
        lastFocused: now,
      }) + "\n",
    );
    writeFileSync(
      join(tmpDir, "status", "s1.status"),
      JSON.stringify({ state: "working", updatedAt: stale }),
    );
    const h = setupExtension();
    const ctx = await startSession(h, { sessionId: "session-current" });
    const ui = await openBrainUi(h, ctx);
    const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    expect(spinnerFrames.some((f) => ui.renderText().includes(f))).toBe(false);
  });
});

describe("search filters by full path", () => {
  // From deleted store.test.ts → "filterDirs filters by full path".
  it("matches against the full directory path, not just the basename", async () => {
    const { ui } = await seedAndOpenUi({
      sessions: [
        { sessionId: "s1", dir: "/home/user/project-alpha", branch: "main" },
        { sessionId: "s2", dir: "/var/work/project-beta", branch: null },
      ],
    });
    ui.fireInput("/");
    for (const c of "/var/work") ui.fireInput(c);
    const text = ui.renderText();
    expect(text).toContain("project-beta");
    expect(text).not.toContain("project-alpha");
  });
});

describe("sessions_changed clamps the cursor when the list shrinks", () => {
  // From deleted brain.test.ts → "clamps cursor when list shrinks".
  it("keeps the cursor on a valid entry when entries are removed", async () => {
    const { ui } = await seedAndOpenUi();
    // Move cursor to the third entry.
    ui.fireInput(DOWN);
    ui.fireInput(DOWN);
    expect(ui.renderText()).toContain("> gamma");
    // Replace the file with a single entry, then notify.
    const now = Date.now();
    writeFileSync(
      join(tmpDir, "sessions.jsonl"),
      JSON.stringify({
        sessionId: "sX",
        dir: "/home/user/only",
        branch: null,
        timestamp: now,
        lastFocused: now,
      }) + "\n",
    );
    await ui.simulateMessage({ type: "sessions_changed" });
    const text = ui.renderText();
    expect(text).toContain("> only");
    expect(text).not.toContain("> gamma");
  });
});

describe("ENTER from search", () => {
  // From deleted brain.test.ts → "enter opens the selected directory"
  // (search variant) and "exits instead of opening current session via
  // search".
  it("opens the matched directory when ENTER is pressed inside search", async () => {
    const { h, ui } = await seedAndOpenUi();
    h.spawn.calls.length = 0;
    ui.fireInput("/");
    for (const c of "alph") ui.fireInput(c);
    ui.fireInput(ENTER);
    expect(h.spawn.calls.length).toBe(1);
  });

  it("exits instead of opening when the matched dir is the current session", async () => {
    // Seed alpha as the only session, with sessionId matching ours.
    const { h, ui } = await seedAndOpenUi({
      cwd: "/home/user/alpha",
      sessionId: "s1",
      sessions: [{ sessionId: "s1", dir: "/home/user/alpha", branch: "main" }],
    });
    h.spawn.calls.length = 0;
    ui.fireInput("/");
    for (const c of "alph") ui.fireInput(c);
    ui.fireInput(ENTER);
    expect(h.spawn.calls.length).toBe(0);
  });
});

describe("pruneOldSessions cleans up status files", () => {
  // From deleted store.test.ts → "does not remove files for sessions
  // still referenced". The companion case ("removes entries and files")
  // is already covered by "removes entries older than 180 days from
  // sessions.jsonl" above. Pruning is triggered on session_start.
  it("does not delete files for sessions still referenced after pruning", async () => {
    const now = Date.now();
    const veryOld = now - 200 * 24 * 60 * 60 * 1000;
    // `keepMe` has both an old entry (would prune) and a recent entry
    // (keeps it referenced) — the status file must survive.
    writeFileSync(
      join(tmpDir, "sessions.jsonl"),
      JSON.stringify({
        sessionId: "keepMe",
        dir: "/tmp/old-dir",
        branch: null,
        timestamp: veryOld,
        lastFocused: veryOld,
      }) +
        "\n" +
        JSON.stringify({
          sessionId: "keepMe",
          dir: "/tmp/new-dir",
          branch: null,
          timestamp: now,
          lastFocused: now,
        }) +
        "\n",
    );
    writeFileSync(
      join(tmpDir, "status", "keepMe.status"),
      JSON.stringify({ state: "idle", updatedAt: now }),
    );
    const h = setupExtension();
    await startSession(h, { sessionId: "current" });
    expect(existsSync(join(tmpDir, "status", "keepMe.status"))).toBe(true);
  });
});
