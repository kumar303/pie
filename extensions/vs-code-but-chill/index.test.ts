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
    setStatus: (key: string, text: string | undefined) => void;
  };
  hasUI: boolean;
  cwd: string;
  notifications: Notification[];
  customFactories: any[];
  /** Most recent status text per key (undefined after clear). */
  statuses: Map<string, string | undefined>;
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

  const statuses = new Map<string, string | undefined>();
  const ctx: MockContext = {
    notifications,
    customFactories,
    statuses,
    hasUI: true,
    cwd: opts?.dataDir ?? "/tmp",
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        statuses.set(key, text);
      },
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
    getCompletions: (name: string, prefix: string) => {
      const cmd = commands.get(name);
      if (!cmd) throw new Error(`command ${name} not registered`);
      return cmd.getArgumentCompletions?.(prefix) ?? null;
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
    // On first start we want a single notification that both confirms
    // the monitor is running and points the user at the help subcommand.
    const startup = pi.ctx.notifications.find((n) =>
      /monitor/i.test(n.message),
    );
    expect(startup).toBeDefined();
    expect(startup!.message).toMatch(/running|monitoring/i);
    expect(startup!.message).toMatch(/\/vs-code-but-chill help/);
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

  it("/vs-code-but-chill start is a no-op when already connected", async () => {
    const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(expectedDir, { recursive: true });
    const awaitable = makeAwaitableServer(expectedDir);
    server = awaitable.server;
    await server.start();

    const pi = await loadExtension();
    await pi.fire("session_start", { type: "session_start" });
    await awaitable.hello;
    const statusBefore = pi.ctx.statuses.get("vs-code-but-chill");
    expect(statusBefore).toBeDefined();
    const notifCountBefore = pi.ctx.notifications.length;

    await pi.runCommand("vs-code-but-chill", "start");

    // No-op: status unchanged, no "could not connect" error, no spurious
    // second "monitor running" notification.
    expect(pi.ctx.statuses.get("vs-code-but-chill")).toBe(statusBefore);
    const newNotifs = pi.ctx.notifications.slice(notifCountBefore);
    expect(newNotifs.filter((n) => n.type === "error")).toHaveLength(0);
    expect(
      newNotifs.filter((n) => /monitor running/i.test(n.message)),
    ).toHaveLength(0);
  });

  it("/vs-code-but-chill start reconnects after a prior stop", async () => {
    const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(expectedDir, { recursive: true });
    const awaitable = makeAwaitableServer(expectedDir);
    server = awaitable.server;
    await server.start();

    const pi = await loadExtension();
    await pi.fire("session_start", { type: "session_start" });
    await awaitable.hello;

    // Stop the server via the command.
    const stopP = pi.runCommand("vs-code-but-chill", "stop");
    await awaitable.stop;
    await server.stop();
    server = null;
    await stopP;
    await new Promise((r) => setTimeout(r, 50));
    expect(pi.ctx.statuses.get("vs-code-but-chill")).toBeUndefined();

    // Bring up a fresh fake server for the reconnect.
    const a2 = makeAwaitableServer(expectedDir);
    server = a2.server;
    await server.start();
    const notifCountBefore = pi.ctx.notifications.length;

    await pi.runCommand("vs-code-but-chill", "start");
    await a2.hello;

    // Status is restored, and no "connection lost" warning snuck in.
    expect(pi.ctx.statuses.get("vs-code-but-chill")).toBeDefined();
    const newNotifs = pi.ctx.notifications.slice(notifCountBefore);
    expect(
      newNotifs.filter(
        (n) =>
          n.type === "warning" &&
          /connection lost|socket closed/i.test(n.message),
      ),
    ).toHaveLength(0);
  });

  it("/vs-code-but-chill stop tears down cleanly (no warning, status cleared)", async () => {
    // Running `/vs-code-but-chill stop` is a user-initiated shutdown.
    // The server will ack and close its socket, which trips the
    // IpcClient's onError. That must not produce a warning, and the
    // status-bar indicator must go away.
    const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(expectedDir, { recursive: true });
    const awaitable = makeAwaitableServer(expectedDir);
    server = awaitable.server;
    await server.start();

    const pi = await loadExtension();
    await pi.fire("session_start", { type: "session_start" });
    await awaitable.hello;
    expect(pi.ctx.statuses.get("vs-code-but-chill")).toBeDefined();

    const stopP = pi.runCommand("vs-code-but-chill", "stop");
    // Simulate the server shutting down in response.
    await awaitable.stop;
    await server.stop();
    server = null;
    await stopP;
    // Drain the event loop so any close-event handlers have run.
    await new Promise((r) => setTimeout(r, 50));

    const lostWarnings = pi.ctx.notifications.filter(
      (n) =>
        n.type === "warning" &&
        /connection lost|socket closed/i.test(n.message),
    );
    expect(lostWarnings).toHaveLength(0);
    expect(pi.ctx.statuses.get("vs-code-but-chill")).toBeUndefined();
  });

  it("suppresses the connection-lost warning during shutdown", async () => {
    // Reproduces the real shutdown sequence: the client sends `bye`
    // (or the extension just disconnects), the server tears down the
    // socket, and IpcClient's close-handler fires onError("socket
    // closed"). That's expected — we initiated it — so the user
    // shouldn't see a scary "server connection lost" warning.
    const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(expectedDir, { recursive: true });
    const awaitable = makeAwaitableServer(expectedDir);
    server = awaitable.server;
    await server.start();

    const pi = await loadExtension();
    await pi.fire("session_start", { type: "session_start" });
    await awaitable.hello;

    // Baseline: no connection-lost warnings yet.
    expect(
      pi.ctx.notifications.filter((n) =>
        /connection lost|socket closed/i.test(n.message),
      ),
    ).toHaveLength(0);

    // Fire shutdown and simultaneously tear down the server so the
    // client's socket close-handler will trip.
    const shutdownP = pi.fire("session_shutdown", {
      type: "session_shutdown",
    });
    await server.stop();
    server = null;
    await shutdownP;
    // Let the event loop drain any pending close events.
    await new Promise((r) => setTimeout(r, 50));

    const lostWarnings = pi.ctx.notifications.filter(
      (n) =>
        n.type === "warning" &&
        /connection lost|socket closed/i.test(n.message),
    );
    expect(lostWarnings).toHaveLength(0);
  });

  it("shows a status indicator while connected and clears it on shutdown", async () => {
    // Behavioral: the extension must surface its active state in the
    // status bar while connected, and must not leave stale status
    // behind after shutdown. We don't assert on the literal text
    // (that's configuration) — only the presence/absence transition.
    const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(expectedDir, { recursive: true });
    const awaitable = makeAwaitableServer(expectedDir);
    server = awaitable.server;
    await server.start();

    const pi = await loadExtension();
    const statusKey = "vs-code-but-chill";

    // Before session_start: no status set.
    expect(pi.ctx.statuses.has(statusKey)).toBe(false);

    await pi.fire("session_start", { type: "session_start" });
    await awaitable.hello;

    // While connected: status is set to some non-empty text.
    const active = pi.ctx.statuses.get(statusKey);
    expect(typeof active).toBe("string");
    expect((active ?? "").length).toBeGreaterThan(0);

    await pi.fire("session_shutdown", { type: "session_shutdown" });

    // After shutdown: status must be cleared (undefined), not stale text.
    expect(pi.ctx.statuses.get(statusKey)).toBeUndefined();
  });

  it("writes a local 'monitor started' line to the log buffer on session_start", async () => {
    const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(expectedDir, { recursive: true });
    const awaitable = makeAwaitableServer(expectedDir);
    server = awaitable.server;
    await server.start();

    const pi = await loadExtension();
    await pi.fire("session_start", { type: "session_start" });
    await awaitable.hello;

    // Open the log viewer and render once — if the client is logging
    // its own lifecycle, we should see a "monitor started" entry even
    // before any server broadcast has been processed.
    const opened = pi.nextCustom();
    void pi.runCommand("vs-code-but-chill", "logs");
    await opened;
    const component = (pi.ctx as any).lastComponent as {
      render: (w: number) => string[];
    };
    const rendered = component.render(120).join("\n");
    expect(rendered).toMatch(/monitor started|monitor connected/i);
  });

  describe("argument completion", () => {
    it("suggests all subcommands when prefix is empty", async () => {
      const pi = await loadExtension();
      const items = pi.getCompletions("vs-code-but-chill", "");
      expect(items).not.toBeNull();
      const values = items!.map((i) => i.value).sort();
      expect(values).toEqual(["help", "logs", "start", "stop"]);
      // Each item should have a description so it shows up usefully.
      for (const item of items!) {
        expect(item.description).toBeTruthy();
      }
    });

    it("filters by prefix case-insensitively", async () => {
      const pi = await loadExtension();
      expect(
        pi.getCompletions("vs-code-but-chill", "l")!.map((i) => i.value),
      ).toEqual(["logs"]);
      expect(
        pi.getCompletions("vs-code-but-chill", "L")!.map((i) => i.value),
      ).toEqual(["logs"]);
      expect(
        pi.getCompletions("vs-code-but-chill", "s")!.map((i) => i.value),
      ).toEqual(["start", "stop"]);
      expect(
        pi.getCompletions("vs-code-but-chill", "sta")!.map((i) => i.value),
      ).toEqual(["start"]);
    });

    it("returns an empty list when no subcommand matches", async () => {
      const pi = await loadExtension();
      const items = pi.getCompletions("vs-code-but-chill", "zzz");
      expect(items).toEqual([]);
    });
  });
});
