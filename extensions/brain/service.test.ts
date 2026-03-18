import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BrainService,
  Client,
  getSocketPath,
  getLockDir,
  tryAcquireLock,
  releaseLock,
  ensureService,
  type StatusMessage,
  type SessionsChangedMessage,
  type ErrorMessage,
  type PubSubMessage,
} from "./service.js";

let tmpDir: string;
let service: BrainService | null = null;
const cleanupClients: Client[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "brain-svc-test-"));
  mkdirSync(join(tmpDir, "status"), { recursive: true });
  mkdirSync(join(tmpDir, "logs"), { recursive: true });
});

afterEach(async () => {
  // Disconnect all tracked clients (triggers auto-stop on spawned services)
  for (const c of cleanupClients) {
    c.disconnect();
  }
  cleanupClients.length = 0;

  if (service) {
    await service.stop();
    service = null;
  }

  // Clean up any leftover socket file
  const sp = getSocketPath(tmpDir);
  try { if (existsSync(sp)) unlinkSync(sp); } catch {}
});

function socketPath(): string {
  return join(tmpDir, "test.sock");
}

/** Wait for a condition with timeout. */
async function waitFor(
  fn: () => boolean,
  timeout = 2000,
  interval = 10,
): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

// ── BrainService ────────────────────────────────────────────────────

describe("BrainService", () => {
  it("starts and accepts client connections", async () => {
    service = new BrainService(socketPath());
    await service.start();

    const client = new Client();
    await client.connect(socketPath());
    expect(client.connected).toBe(true);
    expect(service.clientCount).toBe(1);
    client.disconnect();
  });

  it("broadcasts messages to other clients (not sender)", async () => {
    service = new BrainService(socketPath());
    await service.start();

    const client1 = new Client();
    const client2 = new Client();
    await client1.connect(socketPath());
    await client2.connect(socketPath());

    const received: PubSubMessage[] = [];
    client2.onMessage((msg) => received.push(msg));

    const senderReceived: PubSubMessage[] = [];
    client1.onMessage((msg) => senderReceived.push(msg));

    const statusMsg: StatusMessage = {
      type: "status",
      sessionId: "s1",
      dir: "/tmp/project",
      branch: "main",
      state: "working",
    };
    client1.publish(statusMsg);

    await waitFor(() => received.length > 0);
    expect(received[0]).toEqual(statusMsg);
    // Sender should NOT receive their own message
    expect(senderReceived).toHaveLength(0);

    client1.disconnect();
    client2.disconnect();
  });

  it("broadcasts to multiple clients", async () => {
    service = new BrainService(socketPath());
    await service.start();

    const sender = new Client();
    const receiver1 = new Client();
    const receiver2 = new Client();
    await sender.connect(socketPath());
    await receiver1.connect(socketPath());
    await receiver2.connect(socketPath());

    const received1: PubSubMessage[] = [];
    const received2: PubSubMessage[] = [];
    receiver1.onMessage((msg) => received1.push(msg));
    receiver2.onMessage((msg) => received2.push(msg));

    const msg: SessionsChangedMessage = { type: "sessions_changed" };
    sender.publish(msg);

    await waitFor(() => received1.length > 0 && received2.length > 0);
    expect(received1[0]).toEqual(msg);
    expect(received2[0]).toEqual(msg);

    sender.disconnect();
    receiver1.disconnect();
    receiver2.disconnect();
  });

  it("stops when last client disconnects", async () => {
    service = new BrainService(socketPath());
    await service.start();

    const client = new Client();
    await client.connect(socketPath());
    expect(service.clientCount).toBe(1);

    client.disconnect();
    // Wait for the service to detect disconnection and stop
    await waitFor(() => service!.clientCount === 0);
    // Socket file should be cleaned up
    await waitFor(() => !existsSync(socketPath()));
    service = null; // Already stopped
  });

  it("handles error messages", async () => {
    service = new BrainService(socketPath());
    await service.start();

    const client1 = new Client();
    const client2 = new Client();
    await client1.connect(socketPath());
    await client2.connect(socketPath());

    const received: PubSubMessage[] = [];
    client2.onMessage((msg) => received.push(msg));

    const errMsg: ErrorMessage = {
      type: "error",
      sessionId: "s1",
      message: "Something went wrong",
    };
    client1.publish(errMsg);

    await waitFor(() => received.length > 0);
    expect(received[0]).toEqual(errMsg);

    client1.disconnect();
    client2.disconnect();
  });

  it("handles multiple messages in sequence", async () => {
    service = new BrainService(socketPath());
    await service.start();

    const client1 = new Client();
    const client2 = new Client();
    await client1.connect(socketPath());
    await client2.connect(socketPath());

    const received: PubSubMessage[] = [];
    client2.onMessage((msg) => received.push(msg));

    client1.publish({ type: "status", sessionId: "s1", dir: "/a", branch: null, state: "working" });
    client1.publish({ type: "status", sessionId: "s1", dir: "/a", branch: null, state: "idle" });

    await waitFor(() => received.length >= 2);
    expect(received[0]).toMatchObject({ state: "working" });
    expect(received[1]).toMatchObject({ state: "idle" });

    client1.disconnect();
    client2.disconnect();
  });
});

// ── Client ──────────────────────────────────────────────────────────

describe("Client", () => {
  it("rejects connection to non-existent socket", async () => {
    const client = new Client();
    await expect(client.connect("/tmp/nonexistent.sock")).rejects.toThrow();
  });

  it("publish is a no-op when disconnected", () => {
    const client = new Client();
    // Should not throw
    client.publish({ type: "sessions_changed" });
  });

  it("reports post-connection errors via onError", async () => {
    service = new BrainService(socketPath());
    await service.start();

    const client = new Client();
    await client.connect(socketPath());

    const errors: Error[] = [];
    client.onError((err) => errors.push(err));

    // Kill the service — client should get an error
    await service.stop();
    service = null;

    await waitFor(() => errors.length > 0 || !client.connected);
    // Socket should be broken
    expect(client.connected).toBe(false);
  });

  it("reports connected status", async () => {
    service = new BrainService(socketPath());
    await service.start();

    const client = new Client();
    expect(client.connected).toBe(false);
    await client.connect(socketPath());
    expect(client.connected).toBe(true);
    client.disconnect();
    expect(client.connected).toBe(false);
  });
});

// ── Lock helpers ────────────────────────────────────────────────────

describe("lock helpers", () => {
  it("acquires and releases lock", () => {
    expect(tryAcquireLock(tmpDir)).toBe(true);
    expect(existsSync(getLockDir(tmpDir))).toBe(true);
    releaseLock(tmpDir);
    expect(existsSync(getLockDir(tmpDir))).toBe(false);
  });

  it("fails to acquire when already locked", () => {
    expect(tryAcquireLock(tmpDir)).toBe(true);
    expect(tryAcquireLock(tmpDir)).toBe(false);
    releaseLock(tmpDir);
  });

  it("release is idempotent", () => {
    releaseLock(tmpDir); // Should not throw even if not locked
  });
});

// ── ensureService ───────────────────────────────────────────────────

describe("ensureService", () => {
  it("spawns service and returns connected client", async () => {
    const client = await ensureService({ dataDir: tmpDir });
    cleanupClients.push(client);

    expect(client.connected).toBe(true);
    // Service socket should exist
    expect(existsSync(getSocketPath(tmpDir))).toBe(true);
  });

  it("connects to existing service without spawning a new one", async () => {
    const sp = getSocketPath(tmpDir);
    service = new BrainService(sp);
    await service.start();

    const client = await ensureService({ dataDir: tmpDir });
    cleanupClients.push(client);

    expect(client.connected).toBe(true);
  });

  it("cleans up stale socket file and starts fresh", async () => {
    const sp = getSocketPath(tmpDir);
    // Create a stale socket file (just a regular file, no listener)
    const { writeFileSync } = await import("node:fs");
    writeFileSync(sp, "stale");

    const client = await ensureService({ dataDir: tmpDir });
    cleanupClients.push(client);

    expect(client.connected).toBe(true);
  });

  it("two callers share the same service", async () => {
    const client1 = await ensureService({ dataDir: tmpDir });
    const client2 = await ensureService({ dataDir: tmpDir });
    cleanupClients.push(client1, client2);

    expect(client1.connected).toBe(true);
    expect(client2.connected).toBe(true);

    // Messages flow between them
    const received: PubSubMessage[] = [];
    client2.onMessage((msg) => received.push(msg));
    client1.publish({ type: "sessions_changed" });

    await waitFor(() => received.length > 0);
    expect(received[0]).toEqual({ type: "sessions_changed" });
  });
});
