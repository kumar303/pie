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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Stub spawnServer so tests that reach ensureServer's spawn
// fallback don't fork real detached children that survive the
// test process as orphans.
vi.mock("./spawn.ts", () => ({
  spawnServer: vi.fn(() => ({ pid: undefined })),
  resolveJitiCli: vi.fn(() => "/dev/null/jiti.mjs"),
}));

import extensionFactory from "./index.ts";
import { IpcServer } from "./server/ipc.ts";
import { pathsFor } from "./server/registry.ts";
import * as spawnModule from "./spawn.ts";

describe("test-suite hygiene", () => {
  it("stubs spawnServer so tests can't leak orphan child processes", () => {
    expect(vi.isMockFunction(spawnModule.spawnServer)).toBe(true);
  });
});

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
  // Use the system temp directory, while keeping Unix socket paths
  // below macOS' ~104 byte limit.
  dataDir = mkdtempSync(join(tmpdir(), "vsc-"));
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
function makeAwaitableServer(
  expectedDir: string,
  opts?: { onReap?: () => Promise<{ killed: number; ok: boolean }> },
) {
  const hello = deferredHandler<number>();
  const bye = deferredHandler<number>();
  let onStopImpl: (() => void) | null = null;
  const stop = new Promise<void>((resolve) => {
    onStopImpl = resolve;
  });
  const reap = deferredHandler<void>();
  const srv = new IpcServer(pathsFor(expectedDir).socketPath, {
    onHello: hello.handler,
    onBye: bye.handler,
    onStop: () => onStopImpl?.(),
    onReap: async () => {
      reap.handler(undefined);
      return opts?.onReap ? await opts.onReap() : { killed: 0, ok: true };
    },
  });
  return {
    server: srv,
    hello: hello.promise,
    bye: bye.promise,
    stop,
    reap: reap.promise,
  };
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

  it("session_shutdown handler returns immediately instead of blocking on teardown", async () => {
    // Same invariant as session_start: pi runs lifecycle handlers
    // serially, and anything we `await` inside session_shutdown
    // delays pi's own exit — which delays the terminal returning
    // control to the user. Teardown writes a `bye` and then sleeps
    // 50ms before closing; we want that to happen in the background.
    const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(expectedDir, { recursive: true });
    const awaitable = makeAwaitableServer(expectedDir);
    server = awaitable.server;
    await server.start();

    const pi = await loadExtension();
    await pi.fire("session_start", { type: "session_start" });
    await awaitable.hello;

    const started = Date.now();
    await pi.fire("session_shutdown", { type: "session_shutdown" });
    const elapsed = Date.now() - started;
    // A blocking teardown pays the full sleep; fire-and-forget is
    // sub-millisecond.
    expect(elapsed).toBeLessThan(25);
  });

  it("does not open a second connection when session_start fires twice", async () => {
    // Symptom seen in production: every `client hello` line in the
    // log showed up twice within 1–2ms — pi was somehow invoking
    // the extension's session_start twice, and each call kicked off
    // its own connect(), producing two live sockets. The second
    // `client` assignment clobbered the first, so subsequent reap
    // requests got dropped by the first (destroyed) socket.
    //
    // This test doesn't assume pi's behavior is wrong — it asserts
    // the extension is robust against it: two session_start events
    // must yield exactly one hello.
    const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(expectedDir, { recursive: true });
    const awaitable = makeAwaitableServer(expectedDir);
    server = awaitable.server;
    let helloCount = 0;
    const serverWithCount = new IpcServer(pathsFor(expectedDir).socketPath, {
      onHello: (pid) => {
        helloCount++;
        // Forward to the awaitable so we can still await `hello`.
        (awaitable.server as any).handlers?.onHello?.(pid);
      },
      onBye: () => {},
    });
    // Replace the awaitable server with our counting version.
    server = serverWithCount;
    await serverWithCount.start();

    const pi = await loadExtension();
    // Fire session_start twice — back to back, and again after a
    // microtask so both execution orders are covered.
    await Promise.all([
      pi.fire("session_start", { type: "session_start" }),
      pi.fire("session_start", { type: "session_start" }),
    ]);
    // Give the background connect a chance to complete.
    await new Promise((r) => setTimeout(r, 200));
    expect(helloCount).toBe(1);
  });

  it("session_start handler returns immediately instead of blocking on connect", async () => {
    // pi runs extension lifecycle handlers serially; anything we
    // `await` inside `session_start` blocks the rest of pi startup,
    // including the prompt. Connect/retry can take seconds (up to
    // ~2s of retries on first launch), so connect must happen in the
    // background — the handler itself has to resolve synchronously
    // from pi's point of view.
    //
    // We verify this by pointing the extension at a data dir with no
    // server running and no spawn stub listening (so `ensureServer`
    // will retry until timeout). The handler must resolve well
    // before the retry budget is exhausted.
    const pi = await loadExtension();
    const started = Date.now();
    await pi.fire("session_start", { type: "session_start" });
    const elapsed = Date.now() - started;
    // Generous upper bound — a blocking handler would take > 1s on
    // the retry path. Anything non-blocking is in the tens of ms.
    expect(elapsed).toBeLessThan(500);
  });

  it("shows stopped notifications with workspacePath when available", async () => {
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
    server.broadcastKilled({
      type: "killed",
      pid: 555,
      kind: "tsserver",
      workspace: "abc",
      workspacePath: "/Users/me/my-project",
      reason: "workspace idle",
    });
    await notified;

    const msg = pi.ctx.notifications.find((n) => /my-project/.test(n.message))!;
    expect(msg.message).toMatch(/stopped idle tsserver/);
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
    server.broadcastKilled({
      type: "killed",
      pid: 42,
      kind: "tsserver",
      workspace: "deadbeef",
      reason: "workspace idle",
    });
    await notified;
  });

  describe("reap subcommand", () => {
    it("requests an immediate reap and reports success when nothing was killed", async () => {
      const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(expectedDir, { recursive: true });
      const awaitable = makeAwaitableServer(expectedDir, {
        onReap: async () => ({ killed: 0, ok: true }),
      });
      server = awaitable.server;
      await server.start();

      const pi = await loadExtension();
      await pi.fire("session_start", { type: "session_start" });
      await awaitable.hello;

      const notifCountBefore = pi.ctx.notifications.length;
      await pi.runCommand("vs-code-but-chill", "reap");
      await awaitable.reap;
      // Let the reap response round-trip back to the client.
      await new Promise((r) => setTimeout(r, 50));

      const newNotifs = pi.ctx.notifications.slice(notifCountBefore);
      // Exactly one success notification; it mentions "nothing" so the
      // user knows it ran and had no work.
      const success = newNotifs.find(
        (n) => n.type === "info" && /nothing/i.test(n.message),
      );
      expect(success).toBeDefined();
      // No error/warning notifications produced by the reap itself.
      expect(newNotifs.filter((n) => n.type !== "info")).toHaveLength(0);
    });

    it("reports a stopped count when the reap stopped processes", async () => {
      const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(expectedDir, { recursive: true });
      const awaitable = makeAwaitableServer(expectedDir, {
        onReap: async () => ({ killed: 2, ok: true }),
      });
      server = awaitable.server;
      await server.start();

      const pi = await loadExtension();
      await pi.fire("session_start", { type: "session_start" });
      await awaitable.hello;

      const notifCountBefore = pi.ctx.notifications.length;
      await pi.runCommand("vs-code-but-chill", "reap");
      await awaitable.reap;
      await new Promise((r) => setTimeout(r, 50));

      const newNotifs = pi.ctx.notifications.slice(notifCountBefore);
      // Success notification references the number of stopped processes. Actual
      // per-process notifications still come from the existing `killed`
      // event path.
      const success = newNotifs.find((n) =>
        /stopped.*2|2.*stopped|stopped 2/i.test(n.message),
      );
      expect(success).toBeDefined();
    });

    it("reports failure as a warning when the server errored", async () => {
      const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(expectedDir, { recursive: true });
      const awaitable = makeAwaitableServer(expectedDir, {
        onReap: async () => ({ killed: 0, ok: false }),
      });
      server = awaitable.server;
      await server.start();

      const pi = await loadExtension();
      await pi.fire("session_start", { type: "session_start" });
      await awaitable.hello;

      const notifCountBefore = pi.ctx.notifications.length;
      await pi.runCommand("vs-code-but-chill", "reap");
      await awaitable.reap;
      await new Promise((r) => setTimeout(r, 50));

      const newNotifs = pi.ctx.notifications.slice(notifCountBefore);
      const failure = newNotifs.find(
        (n) =>
          n.type === "warning" && /reap.*fail|could not reap/i.test(n.message),
      );
      expect(failure).toBeDefined();
    });

    it("waits for the in-flight connect if reap is invoked right after session_start", async () => {
      // Repro: in real pi with `-p "/vs-code-but-chill reap"`, the
      // command handler dispatches concurrently with session_start.
      // session_start now does connect in the background, so when
      // the reap handler runs there is no `client` yet. Without the
      // guard, the handler incorrectly reports "server is not
      // running" and the connect later succeeds silently.
      const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(expectedDir, { recursive: true });
      const awaitable = makeAwaitableServer(expectedDir, {
        onReap: async () => ({ killed: 0, ok: true }),
      });
      server = awaitable.server;
      await server.start();

      const pi = await loadExtension();
      // Kick off session_start and the reap command *without*
      // awaiting hello — mirrors `pi -p` behavior where the prompt
      // dispatches alongside lifecycle hooks.
      void pi.fire("session_start", { type: "session_start" });
      await pi.runCommand("vs-code-but-chill", "reap");
      // Give the reap response time to round-trip.
      await new Promise((r) => setTimeout(r, 200));

      // The handler must have waited for connect; no "server is not
      // running" warning.
      const wrongWarning = pi.ctx.notifications.find(
        (n) => n.type === "warning" && /server is not running/i.test(n.message),
      );
      expect(wrongWarning).toBeUndefined();
      // And the reap success notification should have arrived.
      const success = pi.ctx.notifications.find(
        (n) => n.type === "info" && /nothing to stop/i.test(n.message),
      );
      expect(success).toBeDefined();
    });

    it("warns the user if no response arrives within a reasonable window", async () => {
      // If the socket is dead (server crashed, sandbox hiccup) the
      // `send` call is silently dropped and the pending reap never
      // completes. The user needs a clear failure, not a permanent
      // "reap requested…" state.
      const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(expectedDir, { recursive: true });
      const awaitable = makeAwaitableServer(expectedDir, {
        // Never respond to reap.
        onReap: async () => new Promise(() => {}),
      });
      server = awaitable.server;
      await server.start();

      const pi = await loadExtension();
      await pi.fire("session_start", { type: "session_start" });
      await awaitable.hello;

      const notifCountBefore = pi.ctx.notifications.length;
      // Short timeout so the test runs fast; production default is
      // larger (see VSCBC_REAP_TIMEOUT_MS).
      process.env.VSCBC_REAP_TIMEOUT_MS = "50";
      try {
        await pi.runCommand("vs-code-but-chill", "reap");
        // Wait past the timeout.
        await new Promise((r) => setTimeout(r, 150));
      } finally {
        delete process.env.VSCBC_REAP_TIMEOUT_MS;
      }

      const newNotifs = pi.ctx.notifications.slice(notifCountBefore);
      const timeout = newNotifs.find(
        (n) =>
          n.type === "warning" &&
          /no response|timed out|reap.*fail/i.test(n.message),
      );
      expect(timeout).toBeDefined();
    });

    it("handler returns immediately, even when the server tick is slow", async () => {
      // pi serializes command handlers: awaiting the full reap
      // round-trip blocks the prompt for as long as the server's
      // tick takes (procsnap + per-process kill timeouts run in the
      // seconds range). The command must return promptly; the
      // outcome lands later as a notification.
      const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(expectedDir, { recursive: true });
      const awaitable = makeAwaitableServer(expectedDir, {
        onReap: async () => {
          // Simulate a slow tick.
          await new Promise((r) => setTimeout(r, 500));
          return { killed: 0, ok: true };
        },
      });
      server = awaitable.server;
      await server.start();

      const pi = await loadExtension();
      await pi.fire("session_start", { type: "session_start" });
      await awaitable.hello;

      const started = Date.now();
      await pi.runCommand("vs-code-but-chill", "reap");
      const elapsed = Date.now() - started;
      // A blocking handler would wait 500ms+; fire-and-forget is
      // near-instant.
      expect(elapsed).toBeLessThan(100);

      // The outcome still arrives — just not inside the handler.
      await awaitable.reap;
      await new Promise((r) => setTimeout(r, 600));
      const info = pi.ctx.notifications.find(
        (n) => n.type === "info" && /nothing/i.test(n.message),
      );
      expect(info).toBeDefined();
    });

    it("warns if the server is not running", async () => {
      const pi = await loadExtension();
      // No session_start, so there's no client.
      await pi.runCommand("vs-code-but-chill", "reap");
      expect(
        pi.ctx.notifications.some(
          (n) =>
            n.type === "warning" && /server is not running/i.test(n.message),
        ),
      ).toBe(true);
    });
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
    // Give the post-connect notification a chance to fire.
    await new Promise((r) => setTimeout(r, 20));

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
    // The user ran `start` explicitly, so give feedback that it worked
    // (parallels the `stop` command's "stop sent" notification).
    const startMsg = newNotifs.find(
      (n) => n.type === "info" && /start|running/i.test(n.message),
    );
    expect(startMsg).toBeDefined();
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

  it("logs subcommand renders whatever is in server.log on disk", async () => {
    // The extension no longer buffers log lines in memory — the
    // server's on-disk log is the single source of truth, and the
    // viewer reads it directly. So any JSON entries present in
    // `server.log` (written by the server, or seeded before the
    // session even starts) must show up when the user runs `logs`.
    const expectedDir = join(dataDir, ".cache", "vs-code-but-chill_pi");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(expectedDir, { recursive: true });
    const logPath = join(expectedDir, "server.log");
    writeFileSync(
      logPath,
      [
        JSON.stringify({
          ts: "2026-04-23T10:00:00.000Z",
          msg: "vs-code-but-chill server started pid=1234",
        }),
        JSON.stringify({
          ts: "2026-04-23T10:00:01.000Z",
          msg: "tick error: spawn EPERM",
        }),
      ].join("\n") + "\n",
    );

    const awaitable = makeAwaitableServer(expectedDir);
    server = awaitable.server;
    await server.start();

    const pi = await loadExtension();
    await pi.fire("session_start", { type: "session_start" });
    await awaitable.hello;

    const opened = pi.nextCustom();
    void pi.runCommand("vs-code-but-chill", "logs");
    await opened;
    const component = (pi.ctx as any).lastComponent as {
      render: (w: number) => string[];
    };
    const rendered = component.render(200).join("\n");
    expect(rendered).toMatch(/server started pid=1234/);
    expect(rendered).toMatch(/tick error: spawn EPERM/);
  });

  describe("argument completion", () => {
    it("suggests all subcommands when prefix is empty", async () => {
      const pi = await loadExtension();
      const items = pi.getCompletions("vs-code-but-chill", "");
      expect(items).not.toBeNull();
      const values = items!.map((i) => i.value).sort();
      expect(values).toEqual(["help", "logs", "reap", "start", "stop"]);
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
      expect(
        pi.getCompletions("vs-code-but-chill", "r")!.map((i) => i.value),
      ).toEqual(["reap"]);
    });

    it("returns an empty list when no subcommand matches", async () => {
      const pi = await loadExtension();
      const items = pi.getCompletions("vs-code-but-chill", "zzz");
      expect(items).toEqual([]);
    });
  });
});
