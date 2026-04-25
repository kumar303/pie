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
    });
    await server.start();

    const client = new IpcClient();
    clients.push(client);
    await client.connect(sockPath());
    client.send({ type: "hello", pid: 9999 });

    await hello.promise;
    expect(server!.clientPids).toContain(9999);
  });

  it("reap invokes the handler and returns its result to the caller", async () => {
    // `reap` lets a client request an immediate monitoring tick. The
    // server must run its handler and return a `reap` response so the
    // client can report success + kill count back to the UI.
    let invocations = 0;
    server = new IpcServer(sockPath(), {
      onHello: () => {},
      onBye: () => {},
      onReap: async () => {
        invocations++;
        return { killed: 0, ok: true };
      },
    });
    await server.start();

    const client = new IpcClient();
    clients.push(client);
    await client.connect(sockPath());
    const reapP = nextMessage(client, (m) => m.type === "reap");
    client.send({ type: "reap" });
    const msg = await reapP;

    expect(invocations).toBe(1);
    expect(msg.ok).toBe(true);
    expect(msg.killed).toBe(0);
  });

  it("reap surfaces handler errors as { ok:false, error } whether thrown or returned", async () => {
    // Two failure shapes we want to surface identically:
    //   1. handler resolves with `{ ok: false, error }` (the shape
    //      `safeTick()` uses so reap and the interval tick share
    //      exactly one error path).
    //   2. handler throws (legacy contract; still must be handled).
    for (const shape of ["returned", "thrown"] as const) {
      if (server) {
        await server.stop();
        server = null;
      }
      server = new IpcServer(sockPath(), {
        onHello: () => {},
        onBye: () => {},
        onReap: async () => {
          if (shape === "thrown") throw new Error("boom");
          return { ok: false, killed: 0, error: "boom" };
        },
      });
      await server.start();
      const client = new IpcClient();
      clients.push(client);
      await client.connect(sockPath());
      const reapP = nextMessage(client, (m) => m.type === "reap");
      client.send({ type: "reap" });
      const msg = await reapP;
      expect(msg.ok).toBe(false);
      expect(msg.error).toMatch(/boom/);
    }
  });

  it("ping returns pong", async () => {
    server = new IpcServer(sockPath(), {
      onHello: () => {},
      onBye: () => {},
    });
    await server.start();
    const client = new IpcClient();
    clients.push(client);
    await client.connect(sockPath());
    const pongPromise = nextMessage(client, (m) => m.type === "pong");
    client.send({ type: "ping" });
    await pongPromise;
  });

  it("every connected client receives broadcast killed events", async () => {
    // Killed events are implicit — no opt-in subscription. The
    // extension is the only consumer and wants to toast every kill.
    server = new IpcServer(sockPath(), {
      onHello: () => {},
      onBye: () => {},
    });
    await server.start();

    const c1 = new IpcClient();
    const c2 = new IpcClient();
    clients.push(c1, c2);
    await c1.connect(sockPath());
    await c2.connect(sockPath());

    const killed1 = nextMessage(c1, (m) => m.type === "killed");
    const killed2 = nextMessage(c2, (m) => m.type === "killed");
    server.broadcastKilled({
      type: "killed",
      pid: 5,
      kind: "tsserver",
      workspace: "abc",
      reason: "x",
    });
    await Promise.all([killed1, killed2]);
  });

  it("bye triggers onBye callback", async () => {
    const bye = deferredHandler<number>();
    server = new IpcServer(sockPath(), {
      onHello: () => {},
      onBye: bye.handler,
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
      });
      await server.start();

      const c1 = new IpcClient();
      const c2 = new IpcClient();
      clients.push(c1, c2);
      await c1.connect(sockPath());
      await c2.connect(sockPath());

      c1.send({ type: "hello", pid: 111 });
      c2.send({ type: "hello", pid: 222 });
      // No more `ack` messages; wait briefly for server to process.
      await new Promise((r) => setTimeout(r, 20));
      expect(active).toEqual(new Set([111, 222]));

      c1.send({ type: "bye", pid: 111 });
      await new Promise((r) => setTimeout(r, 20));
      expect(lastClientLeft).toBe(false);
      expect(active).toEqual(new Set([222]));

      c2.send({ type: "bye", pid: 222 });
      await new Promise((r) => setTimeout(r, 20));
      expect(lastClientLeft).toBe(true);
      expect(active.size).toBe(0);
    },
  );

  it("stop invokes onStop handler", async () => {
    const stopped = deferredHandler<void>();
    server = new IpcServer(sockPath(), {
      onHello: () => {},
      onBye: () => {},
      onStop: () => stopped.handler(undefined),
    });
    await server.start();
    const client = new IpcClient();
    clients.push(client);
    await client.connect(sockPath());
    client.send({ type: "stop" });
    await stopped.promise;
  });
});

describe("IpcServer client liveness", () => {
  it("calls onBye when a connected client's socket closes without a graceful bye", async () => {
    // Reproduces a hard-killed pi: the IpcClient closes its socket
    // without ever sending {type:"bye"}. Without this signal, the
    // server keeps registry.clientCount stuck above zero forever and
    // can't auto-shut-down, leaking memory until the host reboots.
    //
    // Contract: IpcServer treats connection close as an implicit bye
    // for whichever pid that connection had registered via hello.
    const hello = deferredHandler<number>();
    const bye = deferredHandler<number>();
    server = new IpcServer(sockPath(), {
      onHello: hello.handler,
      onBye: bye.handler,
    });
    await server.start();

    const client = new IpcClient();
    clients.push(client);
    await client.connect(sockPath());
    client.send({ type: "hello", pid: 4242 });
    expect(await hello.promise).toBe(4242);

    client.disconnect();
    expect(await bye.promise).toBe(4242);
  });

  it("does not call onBye when a connection closes before hello", async () => {
    // A peer that never identifies itself has no pid to bye. We
    // shouldn't synthesise a fake one — the registry only tracks
    // clients that handshook.
    let byes = 0;
    server = new IpcServer(sockPath(), {
      onHello: () => {},
      onBye: () => {
        byes++;
      },
    });
    await server.start();

    const client = new IpcClient();
    clients.push(client);
    await client.connect(sockPath());
    client.disconnect();
    // Give the server's close handler a moment to run.
    await new Promise((r) => setTimeout(r, 20));
    expect(byes).toBe(0);
  });

  it("only calls onBye once even if both close and error fire", async () => {
    // node's Socket emits 'close' after 'error' in some failure
    // modes. We must be idempotent so the registry refcount doesn't
    // go negative.
    const byes: number[] = [];
    server = new IpcServer(sockPath(), {
      onHello: () => {},
      onBye: (pid) => {
        byes.push(pid);
      },
    });
    await server.start();

    const client = new IpcClient();
    clients.push(client);
    await client.connect(sockPath());
    client.send({ type: "hello", pid: 9999 });
    // Wait for hello to register before closing.
    await new Promise((r) => setTimeout(r, 30));
    client.disconnect();
    await new Promise((r) => setTimeout(r, 30));
    expect(byes).toEqual([9999]);
  });
});
