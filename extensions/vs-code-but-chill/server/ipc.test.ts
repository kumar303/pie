import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IpcServer } from "./ipc.ts";
import { IpcClient } from "./ipc-client.ts";

let dir: string;
let server: IpcServer | null = null;
const clients: IpcClient[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vscbc-ipc-"));
});

afterEach(async () => {
  for (const c of clients) c.disconnect();
  clients.length = 0;
  if (server) {
    await server.stop();
    server = null;
  }
});

function sockPath(): string {
  return join(dir, "server.sock");
}

/** Await the next message on a client that matches the predicate. */
function nextMessage(
  client: IpcClient,
  match: (m: any) => boolean,
  timeoutMs = 2000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("nextMessage: timeout")),
      timeoutMs,
    );
    client.onMessage((m) => {
      if (!match(m)) return;
      clearTimeout(timer);
      resolve(m);
    });
  });
}

/**
 * Build a server-handler stub whose calls can be awaited via the
 * returned promise.  Resolves with the first call's argument.
 */
function deferredHandler<T>(): {
  handler: (arg: T) => void;
  promise: Promise<T>;
} {
  let resolve: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return {
    handler: (arg) => resolve(arg),
    promise,
  };
}

describe("IpcServer/Client", () => {
  it("client sends hello and server tracks it", async () => {
    const hello = deferredHandler<number>();
    server = new IpcServer(sockPath(), {
      onHello: hello.handler,
      onBye: () => {},
      getStatus: () => ({ uptimeSec: 1, killed: 0, watching: [] }),
      getLogs: () => ["line1", "line2"],
    });
    await server.start();

    const client = new IpcClient();
    clients.push(client);
    await client.connect(sockPath());
    client.send({ type: "hello", pid: 9999 });
    await hello.promise;
    expect(server!.clientPids).toContain(9999);
  });

  it("status round-trip", async () => {
    server = new IpcServer(sockPath(), {
      onHello: () => {},
      onBye: () => {},
      getStatus: () => ({
        uptimeSec: 42,
        killed: 3,
        watching: [
          {
            pid: 1,
            rssMb: 100,
            kind: "tsserver",
            mode: "full",
            workspace: "abc",
            etimeSec: 300,
          },
        ],
      }),
      getLogs: () => [],
    });
    await server.start();

    const client = new IpcClient();
    clients.push(client);
    await client.connect(sockPath());
    const received: any[] = [];
    client.onMessage((m) => received.push(m));
    const statusPromise = nextMessage(client, (m) => m.type === "status");
    client.send({ type: "status" });
    const status = await statusPromise;
    expect(status.uptimeSec).toBe(42);
    expect(status.killed).toBe(3);
    expect(status.watching).toHaveLength(1);
  });

  it("ping returns pong", async () => {
    server = new IpcServer(sockPath(), {
      onHello: () => {},
      onBye: () => {},
      getStatus: () => ({ uptimeSec: 0, killed: 0, watching: [] }),
      getLogs: () => [],
    });
    await server.start();
    const client = new IpcClient();
    clients.push(client);
    await client.connect(sockPath());
    const pongPromise = nextMessage(client, (m) => m.type === "pong");
    client.send({ type: "ping" });
    await pongPromise;
  });

  it("events subscribers receive broadcast messages", async () => {
    server = new IpcServer(sockPath(), {
      onHello: () => {},
      onBye: () => {},
      getStatus: () => ({ uptimeSec: 0, killed: 0, watching: [] }),
      getLogs: () => [],
    });
    await server.start();

    const c1 = new IpcClient();
    const c2 = new IpcClient();
    clients.push(c1, c2);
    await c1.connect(sockPath());
    await c2.connect(sockPath());

    const ack1 = nextMessage(c1, (m) => m.type === "ack" && m.of === "events");
    const ack2 = nextMessage(c2, (m) => m.type === "ack" && m.of === "events");
    c1.send({ type: "events" });
    c2.send({ type: "events" });
    await Promise.all([ack1, ack2]);

    const killed1 = nextMessage(c1, (m) => m.type === "killed");
    const killed2 = nextMessage(c2, (m) => m.type === "killed");
    server.broadcastEvent({
      type: "killed",
      pid: 5,
      kind: "tsserver",
      workspace: "abc",
      rssMb: 2600,
      mode: "full",
      reason: "x",
    });
    await Promise.all([killed1, killed2]);
  });

  it("logs request returns tail of log lines", async () => {
    const lines = ["a", "b", "c", "d", "e"];
    server = new IpcServer(sockPath(), {
      onHello: () => {},
      onBye: () => {},
      getStatus: () => ({ uptimeSec: 0, killed: 0, watching: [] }),
      getLogs: (tail) =>
        typeof tail === "number" ? lines.slice(-tail) : lines,
    });
    await server.start();
    const client = new IpcClient();
    clients.push(client);
    await client.connect(sockPath());
    const logs: string[] = [];
    const gotTwo = new Promise<void>((resolve) => {
      client.onMessage((m) => {
        if (m.type !== "log") return;
        logs.push(m.line);
        if (logs.length >= 2) resolve();
      });
    });
    client.send({ type: "logs", tail: 2 });
    await gotTwo;
    expect(logs.slice(-2)).toEqual(["d", "e"]);
  });

  it("bye triggers onBye callback", async () => {
    const bye = deferredHandler<number>();
    server = new IpcServer(sockPath(), {
      onHello: () => {},
      onBye: bye.handler,
      getStatus: () => ({ uptimeSec: 0, killed: 0, watching: [] }),
      getLogs: () => [],
    });
    await server.start();
    const client = new IpcClient();
    clients.push(client);
    await client.connect(sockPath());
    client.send({ type: "bye", pid: 1234 });
    expect(await bye.promise).toBe(1234);
  });

  it(
    "refcount behavior: with two clients, server stays up after the " +
      "first bye and `lastClientLeft` fires only after the second",
    async () => {
      const active = new Set<number>();
      let lastClientLeft = false;
      server = new IpcServer(sockPath(), {
        onHello: (pid) => {
          active.add(pid);
        },
        onBye: (pid) => {
          active.delete(pid);
          if (active.size === 0) lastClientLeft = true;
        },
        getStatus: () => ({ uptimeSec: 0, killed: 0, watching: [] }),
        getLogs: () => [],
      });
      await server.start();

      const c1 = new IpcClient();
      const c2 = new IpcClient();
      clients.push(c1, c2);
      await c1.connect(sockPath());
      await c2.connect(sockPath());

      const ack1 = nextMessage(c1, (m) => m.type === "ack" && m.of === "hello");
      const ack2 = nextMessage(c2, (m) => m.type === "ack" && m.of === "hello");
      c1.send({ type: "hello", pid: 111 });
      c2.send({ type: "hello", pid: 222 });
      await Promise.all([ack1, ack2]);
      expect(active).toEqual(new Set([111, 222]));

      const bye1 = nextMessage(c1, (m) => m.type === "ack" && m.of === "bye");
      c1.send({ type: "bye", pid: 111 });
      await bye1;
      expect(lastClientLeft).toBe(false);
      expect(active).toEqual(new Set([222]));

      const bye2 = nextMessage(c2, (m) => m.type === "ack" && m.of === "bye");
      c2.send({ type: "bye", pid: 222 });
      await bye2;
      expect(lastClientLeft).toBe(true);
      expect(active.size).toBe(0);
    },
  );
});
