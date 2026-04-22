/**
 * Integration-style tests: drive the extension through a mock `pi`
 * object. We plug in our own in-process IpcServer as the "server" so
 * we can push events and assert on client behavior without spawning
 * anything.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extensionFactory from "./index.ts";
import { IpcServer } from "./server/ipc.ts";
import { pathsFor } from "./server/registry.ts";

// ── mockPi ─────────────────────────────────────────────────────────

interface Notification {
  message: string;
  type: "info" | "warning" | "error";
}

interface MockContext {
  ui: {
    notify: (m: string, t?: "info" | "warning" | "error") => void;
    custom: <T>(factory: any) => Promise<T>;
  };
  hasUI: boolean;
  cwd: string;
  notifications: Notification[];
  customFactories: any[];
}

function createMockPi(opts?: { dataDir?: string }) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands = new Map<string, any>();
  const notifications: Notification[] = [];
  const customFactories: any[] = [];
  let customDoneStub: ((v: any) => void) | null = null;
  /** Resolves on each `ui.custom` call. Re-created after each await. */
  let nextCustomResolve: (() => void) | null = null;
  let nextCustomPromise: Promise<void> = new Promise((r) => {
    nextCustomResolve = r;
  });
  /** Resolves on each `ui.notify` call that matches the pending predicate. */
  const notifyWatchers: Array<{
    match: (m: string) => boolean;
    resolve: () => void;
  }> = [];

  const ctx: MockContext = {
    notifications,
    customFactories,
    hasUI: true,
    cwd: opts?.dataDir ?? "/tmp",
    ui: {
      notify: (message, type = "info") => {
        notifications.push({ message, type });
        for (let i = notifyWatchers.length - 1; i >= 0; i--) {
          if (notifyWatchers[i].match(message)) {
            notifyWatchers[i].resolve();
            notifyWatchers.splice(i, 1);
          }
        }
      },
      custom: async (factory) => {
        customFactories.push(factory);
        // Simulate tui/theme/kb infrastructure
        const tui = { requestRender: vi.fn() };
        const theme = {
          fg: (_c: string, t?: string) => t ?? "",
          bold: (t: string) => t,
        };
        const kb = {};
        const resolver = nextCustomResolve;
        // Reset before firing so a watcher set up during `custom` sees a fresh promise.
        nextCustomPromise = new Promise((r) => {
          nextCustomResolve = r;
        });
        resolver?.();
        return new Promise((resolve) => {
          customDoneStub = resolve;
          const component = factory(tui, theme, kb, resolve);
          (ctx as any).lastComponent = component;
        });
      },
    },
  };

  const pi: ExtensionAPI = {
    on: (event: string, handler: any) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    registerCommand: (name: string, options: any) => {
      commands.set(name, options);
    },
  } as any;

  return {
    pi,
    ctx,
    dismissCustom: () => {
      if (customDoneStub) {
        customDoneStub(undefined);
        customDoneStub = null;
      }
    },
    /** Promise that resolves the next time `ui.custom` is called. */
    nextCustom: () => nextCustomPromise,
    /** Promise that resolves when a notification matching the predicate arrives. */
    nextNotification: (match: (msg: string) => boolean) =>
      new Promise<void>((resolve) => {
        const existing = notifications.find((n) => match(n.message));
        if (existing) return resolve();
        notifyWatchers.push({ match, resolve });
      }),
    async fire(event: string, payload: any = { type: event }) {
      for (const h of handlers.get(event) ?? []) {
        await h(payload, ctx);
      }
    },
    runCommand: async (name: string, args = "") => {
      const cmd = commands.get(name);
      if (!cmd) throw new Error(`command ${name} not registered`);
      return cmd.handler(args, ctx);
    },
    handlers,
  };
}

// ── Fake server plumbing ────────────────────────────────────────────

let server: IpcServer | null = null;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vscbc-ext-"));
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
});

// Force the extension to use our temp dataDir by stubbing HOME so
// defaultDataDir() points at a writable directory. (The extension
// reads HOME via os.homedir().)
async function loadExtension() {
  process.env.HOME = dataDir;
  const pi = createMockPi();
  await extensionFactory(pi.pi);
  return pi;
}

/** Build a server-handler stub whose next call can be awaited. */
function deferredHandler<T>(): {
  handler: (arg: T) => void;
  promise: Promise<T>;
} {
  let resolve: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { handler: (arg) => resolve(arg), promise };
}

/**
 * Build an `IpcServer` whose `onHello` and `events`-subscription
 * callbacks resolve promises the test can await instead of polling.
 *
 * IpcServer doesn't expose an onEvents hook, so we instead wrap
 * `onHello` — every real client sends `hello` immediately after
 * `events`, so `onHello` being called is a proxy for "the client
 * connected and completed the hello/events handshake".
 */
function makeAwaitableServer(expectedDir: string) {
  const hello = deferredHandler<number>();
  const bye = deferredHandler<number>();
  let onStopImpl: (() => void) | null = null;
  const stop = new Promise<void>((resolve) => {
    onStopImpl = resolve;
  });
  const srv = new IpcServer(pathsFor(expectedDir).socketPath, {
    onHello: hello.handler,
    onBye: bye.handler,
    onStop: () => onStopImpl?.(),
    getStatus: () => ({ uptimeSec: 0, killed: 0, watching: [] }),
    getLogs: () => [],
  });
  return { server: srv, hello: hello.promise, bye: bye.promise, stop };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("vs-code-but-chill extension", () => {
  it("help subcommand opens an overlay", async () => {
    const pi = await loadExtension();
    const opened = pi.nextCustom();
    const promise = pi.runCommand("vs-code-but-chill", "help");
    await opened;
    pi.dismissCustom();
    await promise;
    expect(pi.ctx.customFactories.length).toBeGreaterThan(0);
  });

  it("bare /vs-code-but-chill invocation shows help", async () => {
    const pi = await loadExtension();
    const opened = pi.nextCustom();
    const promise = pi.runCommand("vs-code-but-chill", "");
    await opened;
    pi.dismissCustom();
    await promise;
    expect(pi.ctx.customFactories.length).toBeGreaterThan(0);
  });

  it("unknown subcommand shows a warning notification", async () => {
    const pi = await loadExtension();
    await pi.runCommand("vs-code-but-chill", "nope");
    const warn = pi.ctx.notifications.find((n) => n.type === "warning");
    expect(warn?.message).toMatch(/unknown subcommand/i);
  });

  it("connects, prints startup line, sends hello", async () => {
    // Pre-start an in-process "server" at the expected socket path.
    // The extension will connect instead of spawning.
    const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(expectedDir, { recursive: true });

    const awaitable = makeAwaitableServer(expectedDir);
    server = awaitable.server;
    await server.start();

    const pi = await loadExtension();
    await pi.fire("session_start", { type: "session_start" });

    const helloPid = await awaitable.hello;
    expect(helloPid).toBe(process.pid);
    expect(
      pi.ctx.notifications.some((n) =>
        /monitoring TS servers/i.test(n.message),
      ),
    ).toBe(true);
  });

  it("shows killed-event notifications with workspacePath when available", async () => {
    const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(expectedDir, { recursive: true });

    const awaitable = makeAwaitableServer(expectedDir);
    server = awaitable.server;
    await server.start();

    const pi = await loadExtension();
    await pi.fire("session_start", { type: "session_start" });
    await awaitable.hello;

    const notified = pi.nextNotification((m) => /my-project/.test(m));
    server.broadcastEvent({
      type: "killed",
      pid: 555,
      kind: "tsserver",
      workspace: "abc",
      workspacePath: "/Users/me/my-project",
      rssMb: 2714,
      mode: "full",
      reason: "rss over threshold",
    });
    await notified;

    const msg = pi.ctx.notifications.find((n) => /my-project/.test(n.message))!;
    expect(msg.message).toMatch(/killed tsserver/);
    expect(msg.message).toMatch(/2714 MB/);
  });

  it("falls back to workspace hash when workspacePath is unknown", async () => {
    const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(expectedDir, { recursive: true });
    const awaitable = makeAwaitableServer(expectedDir);
    server = awaitable.server;
    await server.start();

    const pi = await loadExtension();
    await pi.fire("session_start", { type: "session_start" });
    await awaitable.hello;

    const notified = pi.nextNotification((m) => /deadbeef/.test(m));
    server.broadcastEvent({
      type: "killed",
      pid: 42,
      kind: "tsserver",
      workspace: "deadbeef",
      rssMb: 2600,
      mode: "full",
      reason: "x",
    });
    await notified;
  });

  it("stop subcommand forwards a stop message to the server", async () => {
    const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(expectedDir, { recursive: true });

    const awaitable = makeAwaitableServer(expectedDir);
    server = awaitable.server;
    await server.start();

    const pi = await loadExtension();
    await pi.fire("session_start", { type: "session_start" });
    await awaitable.hello;

    await pi.runCommand("vs-code-but-chill", "stop");
    await awaitable.stop;
    expect(pi.ctx.notifications.some((n) => /stop sent/i.test(n.message))).toBe(
      true,
    );
  });

  it("sends bye on session_shutdown", async () => {
    const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(expectedDir, { recursive: true });

    const awaitable = makeAwaitableServer(expectedDir);
    server = awaitable.server;
    await server.start();

    const pi = await loadExtension();
    await pi.fire("session_start", { type: "session_start" });
    await awaitable.hello;

    await pi.fire("session_shutdown", { type: "session_shutdown" });
    expect(await awaitable.bye).toBe(process.pid);
  });
});
