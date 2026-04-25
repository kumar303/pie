import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Registry,
  pathsFor,
  isProcessAlive,
  detectInvalidState,
} from "./registry.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vscbc-reg-"));
});

describe("isProcessAlive", () => {
  it("returns true for current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
  it("returns false for obviously dead pid", () => {
    expect(isProcessAlive(999_999_999)).toBe(false);
  });
});

describe("Registry clients.json refcount", () => {
  it("adds and removes clients", () => {
    const reg = new Registry(dir);
    reg.addClient(1111);
    reg.addClient(2222);
    expect(reg.listClients()).toEqual(expect.arrayContaining([1111, 2222]));
    reg.removeClient(1111);
    expect(reg.listClients()).toEqual([2222]);
  });

  it("persists to clients.json", () => {
    const reg = new Registry(dir);
    reg.addClient(1234);
    const raw = JSON.parse(readFileSync(pathsFor(dir).clientsFile, "utf-8"));
    expect(raw["1234"]).toBeDefined();
  });

  it("pruneDeadClients removes pids that no longer exist", () => {
    const reg = new Registry(dir);
    reg.addClient(process.pid); // alive
    reg.addClient(999_999_999); // dead
    reg.pruneDeadClients();
    expect(reg.listClients()).toEqual([process.pid]);
  });

  it("clientCount reflects current refcount", () => {
    const reg = new Registry(dir);
    expect(reg.clientCount).toBe(0);
    reg.addClient(1);
    reg.addClient(2);
    expect(reg.clientCount).toBe(2);
    reg.removeClient(1);
    expect(reg.clientCount).toBe(1);
  });
});

describe("detectInvalidState", () => {
  it("empty dir → invalid (nothing there)", () => {
    const s = detectInvalidState(dir);
    expect(s.pidAlive).toBe(false);
    expect(s.socketExists).toBe(false);
    expect(s.valid).toBe(false);
  });

  it("pid file with dead pid is invalid", () => {
    writeFileSync(pathsFor(dir).pidFile, "999999999");
    const s = detectInvalidState(dir);
    expect(s.pidAlive).toBe(false);
    expect(s.valid).toBe(false);
  });

  it("pid file alive + socket file present = valid", () => {
    writeFileSync(pathsFor(dir).pidFile, String(process.pid));
    writeFileSync(pathsFor(dir).socketPath, ""); // dummy
    const s = detectInvalidState(dir);
    expect(s.pidAlive).toBe(true);
    expect(s.socketExists).toBe(true);
    expect(s.valid).toBe(true);
  });

  it("pid alive but socket missing is invalid", () => {
    writeFileSync(pathsFor(dir).pidFile, String(process.pid));
    const s = detectInvalidState(dir);
    expect(s.pidAlive).toBe(true);
    expect(s.socketExists).toBe(false);
    expect(s.valid).toBe(false);
  });
});

describe("Registry.writePid / tryAcquirePid", () => {
  it("writePid writes own pid", () => {
    const reg = new Registry(dir);
    reg.writePid();
    const content = readFileSync(pathsFor(dir).pidFile, "utf-8");
    expect(Number(content.trim())).toBe(process.pid);
  });

  it("tryAcquirePid returns true when no pid file", () => {
    const reg = new Registry(dir);
    expect(reg.tryAcquirePid()).toBe(true);
    expect(existsSync(pathsFor(dir).pidFile)).toBe(true);
  });

  it("tryAcquirePid returns false when live pid already holds it", () => {
    writeFileSync(pathsFor(dir).pidFile, String(process.pid));
    const reg = new Registry(dir);
    expect(reg.tryAcquirePid()).toBe(false);
  });

  it("tryAcquirePid returns true when stale pid file (dead pid)", () => {
    writeFileSync(pathsFor(dir).pidFile, "999999999");
    const reg = new Registry(dir);
    expect(reg.tryAcquirePid()).toBe(true);
  });

  it("tryAcquirePid uses an exclusive create — no read-then-write race", () => {
    // Direct check of the underlying mechanism: tryAcquirePid must
    // never overwrite an existing pid file blindly. If a stale pid
    // file is present with a *live* pid (even ours, faked), we lose;
    // if the file exists with a dead pid, we win and our pid lands.
    //
    // We exercise this by writing a pid file with our own pid (which
    // is alive) and asserting tryAcquirePid returns false AND leaves
    // the existing pid intact — i.e. no overwrite happened.
    writeFileSync(pathsFor(dir).pidFile, String(process.pid));
    const reg = new Registry(dir);
    expect(reg.tryAcquirePid()).toBe(false);
    const after = readFileSync(pathsFor(dir).pidFile, "utf-8").trim();
    expect(Number(after)).toBe(process.pid);
  });

  it("tryAcquirePid replaces a stale pid file atomically when winning", () => {
    // Stale (dead pid) file should be replaced by ours, not
    // duplicated. After acquire there must be exactly one pid file
    // and no leftover .tmp.
    writeFileSync(pathsFor(dir).pidFile, "999999999");
    const reg = new Registry(dir);
    expect(reg.tryAcquirePid()).toBe(true);
    const content = readFileSync(pathsFor(dir).pidFile, "utf-8").trim();
    expect(Number(content)).toBe(process.pid);
    expect(existsSync(pathsFor(dir).pidFile + ".tmp")).toBe(false);
  });

  it("tryAcquirePid is race-safe: a competing writer between read and write loses gracefully", () => {
    // Reproduces the TOCTOU window in the original implementation:
    //
    //   A reads pid file → dead/missing
    //   B reads pid file → dead/missing
    //   A writes its pid → wins
    //   B writes its pid → silently overwrites A
    //
    // After the fix, the writer that goes second must observe the
    // existing live pid file and fail the acquire. We simulate this
    // by injecting a hook that fires *between* the liveness check
    // and the pid write, where a competitor materialises the file.
    writeFileSync(pathsFor(dir).pidFile, "999999999"); // looks stale
    const reg = new Registry(dir);
    const acquired = reg.tryAcquirePid({
      onAfterLivenessCheck: () => {
        // A competitor wrote its (live) pid into the file between our
        // check and our write.
        writeFileSync(pathsFor(dir).pidFile, String(process.pid));
      },
    });
    expect(acquired).toBe(false);
    // The competitor's pid must remain — we never clobbered it.
    const after = readFileSync(pathsFor(dir).pidFile, "utf-8").trim();
    expect(Number(after)).toBe(process.pid);
  });

  it("cleanup removes pid and socket files", () => {
    const reg = new Registry(dir);
    reg.writePid();
    writeFileSync(pathsFor(dir).socketPath, "dummy");
    reg.cleanup();
    expect(existsSync(pathsFor(dir).pidFile)).toBe(false);
    expect(existsSync(pathsFor(dir).socketPath)).toBe(false);
  });
});
