import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureServer } from "./client.ts";
import { IpcServer } from "./server/ipc.ts";
import { pathsFor } from "./server/registry.ts";

let dir: string;
let server: IpcServer | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vscbc-client-"));
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
});

function makeServer(dataDir: string) {
  return new IpcServer(pathsFor(dataDir).socketPath, {
    onHello: () => {},
    onBye: () => {},
  });
}

describe("ensureServer", () => {
  it("connects to an already-running server without spawning", async () => {
    server = makeServer(dir);
    await server.start();

    let spawnCalls = 0;
    const result = await ensureServer({
      dataDir: dir,
      spawnServer: () => {
        spawnCalls++;
        return { pid: 123 };
      },
      retryDelayMs: 5,
      retryCount: 5,
    });

    expect(result.client.connected).toBe(true);
    expect(result.respawned).toBe(false);
    expect(spawnCalls).toBe(0);
    result.client.disconnect();
  });

  it("spawns server when none is running, then connects", async () => {
    let spawnCalls = 0;
    // The "spawn" just brings up a fake IpcServer.
    const result = await ensureServer({
      dataDir: dir,
      spawnServer: (d) => {
        spawnCalls++;
        server = makeServer(d);
        // Start async; connection retries will succeed once it's listening.
        void server.start();
        return { pid: 999 };
      },
      retryDelayMs: 10,
      retryCount: 20,
    });

    expect(result.client.connected).toBe(true);
    expect(result.respawned).toBe(true);
    expect(spawnCalls).toBe(1);
    result.client.disconnect();
  });

  it("cleans up stale socket file and respawns", async () => {
    // Write a garbage "socket" file — real one will be unlinked before spawn
    writeFileSync(pathsFor(dir).socketPath, "stale");
    expect(existsSync(pathsFor(dir).socketPath)).toBe(true);

    const result = await ensureServer({
      dataDir: dir,
      spawnServer: (d) => {
        server = makeServer(d);
        void server.start();
        return { pid: 111 };
      },
      retryDelayMs: 10,
      retryCount: 20,
    });

    expect(result.client.connected).toBe(true);
    result.client.disconnect();
  });

  it("throws when spawn never produces a listening socket", async () => {
    await expect(
      ensureServer({
        dataDir: dir,
        spawnServer: () => ({ pid: 42 }),
        retryDelayMs: 5,
        retryCount: 3,
      }),
    ).rejects.toThrow(/failed to connect/);
  });
});
