/**
 * Paths, pid file, socket file, and clients.json refcount for
 * vs-code-but-chill.
 *
 * The "registry" is just a handful of files in the cache dir — we keep
 * the logic here so tests can exercise the state machine.
 */

import { errCode, reportStderr } from "./errors.ts";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export interface RegistryPaths {
  dir: string;
  pidFile: string;
  socketPath: string;
  logFile: string;
  logRotatedFile: string;
  clientsFile: string;
}

export function pathsFor(dir: string): RegistryPaths {
  return {
    dir,
    pidFile: join(dir, "server.pid"),
    socketPath: join(dir, "server.sock"),
    logFile: join(dir, "server.log"),
    logRotatedFile: join(dir, "server.log.1"),
    clientsFile: join(dir, "clients.json"),
  };
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it
    return errCode(err) === "EPERM";
  }
}

export interface InvalidStateReport {
  pidAlive: boolean;
  pidFromFile: number | null;
  socketExists: boolean;
  valid: boolean;
  reasons: string[];
}

export interface PidFileResult {
  pid: number | null;
  reason: string | null;
}

/**
 * Read a pid file and return its numeric contents, or a falsy result
 * with a reason. Does not touch process liveness — callers decide
 * what to do with the pid.
 */
export function readPidFile(pidFile: string): PidFileResult {
  if (!existsSync(pidFile)) return { pid: null, reason: "pid file missing" };
  try {
    const raw = readFileSync(pidFile, "utf-8").trim();
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return { pid: n, reason: null };
    return { pid: null, reason: "pid file is malformed" };
  } catch {
    // Callers that want to surface this can check `reason`.
    return { pid: null, reason: "pid file unreadable" };
  }
}

export function detectInvalidState(dir: string): InvalidStateReport {
  const p = pathsFor(dir);
  const reasons: string[] = [];
  let pidFromFile: number | null = null;
  let pidAlive = false;
  const result = readPidFile(p.pidFile);
  if (result.pid !== null) {
    pidFromFile = result.pid;
    pidAlive = isProcessAlive(result.pid);
    if (!pidAlive) reasons.push(`pid ${result.pid} is not alive`);
  } else {
    reasons.push(result.reason);
  }
  const socketExists = existsSync(p.socketPath);
  if (!socketExists) reasons.push("socket file missing");
  const valid = pidAlive && socketExists;
  return { pidAlive, pidFromFile, socketExists, valid, reasons };
}

export class Registry {
  private readonly paths: RegistryPaths;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.paths = pathsFor(dir);
  }

  get clientsFile(): string {
    return this.paths.clientsFile;
  }

  /**
   * Try to become the owning server by writing our pid.
   *
   * Uses an exclusive create (`O_EXCL | O_CREAT`) so concurrent
   * acquirers can't both "win" through the historical read-then-write
   * race. If the file already exists with a *dead* pid, we replace it
   * (unlink + retry the exclusive create); if it exists with a live
   * pid, we lose.
   *
   * `opts.onAfterLivenessCheck` is a test injection point that fires
   * after the liveness probe but *before* the exclusive write — it
   * lets tests simulate a competitor materialising the file in the
   * race window. Production callers leave it unset.
   */
  tryAcquirePid(opts?: { onAfterLivenessCheck?: () => void }): boolean {
    // First: see what's already there. If a live pid owns the file
    // we lose immediately; if it's stale or unreadable we'll try to
    // replace it below.
    const result = readPidFile(this.paths.pidFile);
    if (result.pid !== null && isProcessAlive(result.pid)) {
      return false;
    }
    if (result.reason === "pid file unreadable") {
      // Corrupt/truncated pid file — expected after a crash.
      // Surface it so it's visible in manual debugging.
      reportStderr(
        "pid file unreadable, overwriting",
        new Error(result.reason),
      );
    }

    opts?.onAfterLivenessCheck?.();

    // Two attempts: one assuming the file is gone, and one after we
    // unlink a stale file. A second EEXIST after unlinking means a
    // competitor genuinely beat us to the create — give up cleanly.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.paths.pidFile, "wx");
        try {
          writeSync(fd, String(process.pid));
        } finally {
          closeSync(fd);
        }
        return true;
      } catch (err) {
        if (errCode(err) !== "EEXIST") throw err;
        // Race: someone created it between our check and the open.
        // Re-check liveness; if alive, we lose. If dead, unlink and
        // retry exactly once.
        const after = readPidFile(this.paths.pidFile);
        if (after.pid !== null && isProcessAlive(after.pid)) {
          return false;
        }
        try {
          unlinkSync(this.paths.pidFile);
        } catch (unlinkErr) {
          // Either it was unlinked beneath us (ENOENT) or we lost the
          // permissions race. The next attempt will surface the real
          // failure mode.
          if (errCode(unlinkErr) !== "ENOENT") {
            reportStderr("could not unlink stale pid file", unlinkErr);
          }
        }
      }
    }
    return false;
  }

  writePid(): void {
    const tmp = this.paths.pidFile + ".tmp";
    writeFileSync(tmp, String(process.pid), "utf-8");
    renameSync(tmp, this.paths.pidFile);
  }

  addClient(pid: number): void {
    const map = this.#read();
    map[String(pid)] = new Date().toISOString();
    this.#write(map);
  }

  removeClient(pid: number): void {
    const map = this.#read();
    delete map[String(pid)];
    this.#write(map);
  }

  listClients(): number[] {
    const map = this.#read();
    return Object.keys(map).map((k) => Number(k));
  }

  get clientCount(): number {
    return this.listClients().length;
  }

  pruneDeadClients(): number {
    const map = this.#read();
    let removed = 0;
    for (const pidStr of Object.keys(map)) {
      if (!isProcessAlive(Number(pidStr))) {
        delete map[pidStr];
        removed++;
      }
    }
    if (removed > 0) this.#write(map);
    return removed;
  }

  cleanup(): void {
    for (const p of [
      this.paths.pidFile,
      this.paths.socketPath,
      this.paths.clientsFile,
    ]) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch (err) {
        reportStderr(`cleanup failed for ${p}`, err);
      }
    }
  }

  #read(): Record<string, string> {
    if (!existsSync(this.paths.clientsFile)) return {};
    try {
      const raw = readFileSync(this.paths.clientsFile, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
      return {};
    } catch (err) {
      // A corrupt clients.json is recoverable (we overwrite on next
      // addClient/removeClient) but worth surfacing.
      reportStderr("clients file corrupt, resetting", err);
      return {};
    }
  }

  #write(map: Record<string, string>): void {
    const tmp = this.paths.clientsFile + ".tmp";
    writeFileSync(tmp, JSON.stringify(map, null, 2), "utf-8");
    renameSync(tmp, this.paths.clientsFile);
  }
}
