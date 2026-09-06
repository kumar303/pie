// Temp-directory sandboxes with atomic teardown.
//
// Every sandbox lives under one root directory, so teardown is a single
// recursive delete. Child processes registered with the sandbox are killed
// first. All live sandboxes are also torn down if the eval process exits or
// is interrupted, so a crashed run does not leave pi processes or temp
// directories behind.
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Unix domain socket paths are limited to ~104 bytes on macOS (108 on Linux).
 * `os.tmpdir()` on macOS is already ~50 characters, so prefer a short base
 * such as /tmp when it is writable. Override with PI_EVAL_TMPDIR.
 */
export function shortTmpBase() {
  const candidates = [process.env.PI_EVAL_TMPDIR, "/tmp", tmpdir()].filter(
    Boolean,
  );
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.W_OK);
      return candidate;
    } catch {
      // try the next one
    }
  }
  return tmpdir();
}

const live = new Set();
let hooksInstalled = false;

function installExitHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const teardownAllSync = () => {
    for (const sandbox of [...live]) sandbox.teardownSync();
  };
  process.once("exit", teardownAllSync);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      teardownAllSync();
      process.exit(130);
    });
  }
}

export class Sandbox {
  constructor(prefix) {
    installExitHooks();
    this.root = mkdtempSync(join(shortTmpBase(), `${prefix}-`));
    this.children = new Set();
    this.closed = false;
    live.add(this);
  }

  path(...parts) {
    return join(this.root, ...parts);
  }

  /** Register a child process (anything with .kill() and .killed/.exitCode). */
  track(child) {
    this.children.add(child);
    child.once?.("exit", () => this.children.delete(child));
    return child;
  }

  /** Synchronous best-effort teardown, safe to call from exit handlers. */
  teardownSync() {
    if (this.closed) return;
    this.closed = true;
    live.delete(this);
    for (const child of this.children) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    this.children.clear();
    try {
      rmSync(this.root, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      process.stderr.write(
        `[sandbox] failed to remove ${this.root}: ${error.message}\n`,
      );
    }
  }

  /** Graceful teardown: let children close, then delete everything. */
  async teardown(closeChildren) {
    if (this.closed) return;
    try {
      if (closeChildren) await closeChildren();
    } finally {
      this.teardownSync();
    }
  }
}
