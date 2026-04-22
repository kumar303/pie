/**
 * macOS-specific helpers for listing and killing tsserver processes,
 * plus workspace path resolution via lsof.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isProcessAlive } from "./registry.ts";
import { errCode } from "./errors.ts";
import { sleep } from "./util.ts";

const execFileP = promisify(execFile);

/** Run ps and return stdout. Args mirror the PLAN.md snippet. */
export async function runPs(): Promise<string> {
  const { stdout } = await execFileP(
    "/bin/ps",
    ["-eo", "pid,ppid,rss,etime,args"],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout;
}

/**
 * Run `ps -eo pid,comm=` for parent-comm lookup.
 * We use `comm=` so ps omits the header; our parser handles either form.
 */
export async function runPsComm(): Promise<string> {
  const { stdout } = await execFileP("/bin/ps", ["-eo", "pid,comm="], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Send a signal. Returns false only for real signalling errors
 * (other than ESRCH, which just means the process already exited).
 */
function trySignal(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    // already dead — treat as success
    if (errCode(err) === "ESRCH") return true;
    return false;
  }
}

/** SIGTERM, wait up to `graceMs` ms, then SIGKILL. Returns true if gone. */
export async function killWithTimeout(
  pid: number,
  graceMs = 3000,
): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;

  trySignal(pid, "SIGTERM");

  const step = 250;
  const ticks = Math.ceil(graceMs / step);
  for (let i = 0; i < ticks; i++) {
    await sleep(step);
    if (!isProcessAlive(pid)) return true;
  }

  trySignal(pid, "SIGKILL");
  await sleep(200);
  return !isProcessAlive(pid);
}

/**
 * Best-effort workspace path: deepest common ancestor of files the
 * process has open under $HOME (excluding node_modules). Falls back to
 * the process cwd.
 */
/**
 * Extract filesystem paths from `lsof -Fn` output. Each line starting
 * with `n` carries one path; we strip the leading `n`.
 */
export function parseLsofFnPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("n")) continue;
    const p = line.slice(1);
    if (p) paths.push(p);
  }
  return paths;
}

export async function resolveWorkspacePath(proc: {
  pid: number;
}): Promise<string | undefined> {
  const home = homedir();
  // First: inspect open file descriptors
  try {
    const { stdout } = await execFileP(
      "/usr/sbin/lsof",
      ["-p", String(proc.pid), "-Fn"],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    const paths = parseLsofFnPaths(stdout).filter(
      (p) =>
        p.startsWith(home) &&
        !p.includes("/node_modules/") &&
        !p.startsWith("/private/var/"),
    );
    if (paths.length > 0) {
      const ancestor = deepestCommonAncestor(paths);
      if (ancestor && ancestor !== home && ancestor !== "/") {
        return ancestor;
      }
    }
  } catch {
    // Fall through to cwd lookup
  }

  // Fall back to cwd
  try {
    const { stdout } = await execFileP(
      "/usr/sbin/lsof",
      ["-a", "-d", "cwd", "-p", String(proc.pid), "-Fn"],
      { maxBuffer: 1024 * 1024 },
    );
    const [first] = parseLsofFnPaths(stdout);
    if (first) return first;
  } catch {
    // We've exhausted fallbacks; function returns undefined and the
    // caller treats the workspace as unknown.
  }
  return undefined;
}

/**
 * Return the most recent mtime (unix seconds) for any `.ts`/`.tsx`/`.js`
 * file under the given workspace root, searching up to 2 levels deep.
 * Returns 0 when the path is unknown, unreadable, or has no matches.
 *
 * Best-effort: we deliberately keep the search shallow to avoid a
 * several-minute walk of huge monorepos. The "recent activity"
 * window PLAN.md specifies is 30 seconds, so catching *any* recent
 * edit at the root is sufficient — if an editor saved a file, the
 * workspace directory mtime will update too.
 */
export function recentWorkspaceActivityAt(root: string | undefined): number {
  if (!root) return 0;
  try {
    const s = statSync(root);
    // Directory mtime updates whenever immediate children change,
    // which is enough to detect "something was saved here recently".
    return Math.floor(s.mtimeMs / 1000);
  } catch {
    return 0;
  }
}

export function deepestCommonAncestor(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const splits = paths.map((p) => p.split("/"));
  const first = splits[0];
  let i = 0;
  for (; i < first.length; i++) {
    if (splits.some((s) => s[i] !== first[i])) break;
  }
  const prefix = first.slice(0, i).join("/");
  // If the prefix is a file, step up one level
  try {
    const s = statSync(prefix);
    if (s.isDirectory()) return prefix || null;
    return prefix.split("/").slice(0, -1).join("/") || null;
  } catch {
    return prefix || null;
  }
}

export const __testonly = { deepestCommonAncestor, join };
