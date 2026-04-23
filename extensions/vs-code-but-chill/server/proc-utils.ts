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
import { resolveTsserverWorkspacePath } from "./vscode-workspace-index.ts";
import type { ProcessKind } from "./monitor.ts";

const execFileP = promisify(execFile);

/**
 * Run `pgrep -afl <pattern>` and return stdout. `pgrep` is the only
 * unprivileged enumeration tool available — `/bin/ps` is setuid root
 * and macOS rejects the exec in our sandbox context.
 *
 * We issue two calls because pgrep regex matches any single substring
 * and we want both tsserver.js and eslintServer.js. Results are
 * concatenated; callers feed the combined output to parsePgrepOutput.
 */
export async function runPgrep(): Promise<string> {
  const patterns = ["tsserver\\.js", "eslintServer\\.js"];
  const results = await Promise.all(
    patterns.map(async (pat) => {
      try {
        const { stdout } = await execFileP("/usr/bin/pgrep", ["-afl", pat], {
          maxBuffer: 10 * 1024 * 1024,
        });
        return stdout;
      } catch (err) {
        // Exit code 1 = no matches. That's not an error — return empty.
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code: unknown }).code === 1
        ) {
          return "";
        }
        throw err;
      }
    }),
  );
  return results.join("\n");
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

/**
 * Extract the parent pid from `lsof -FR` output. The field is
 * emitted once per process on a line starting with `R` followed by
 * the numeric ppid.
 */
export function parseLsofParentPid(stdout: string): number | null {
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("R")) continue;
    const n = Number(line.slice(1));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export async function resolveWorkspacePath(proc: {
  pid: number;
  kind: ProcessKind;
}): Promise<string | undefined> {
  const home = homedir();
  // First: inspect open file descriptors. Also grab the ppid (-FR)
  // for the tsserver fallback below.
  let ppid: number | null = null;
  try {
    const { stdout } = await execFileP(
      "/usr/sbin/lsof",
      ["-p", String(proc.pid), "-Fn", "-FR"],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    ppid = parseLsofParentPid(stdout);
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
    // Fall through to cwd / log pivot
  }

  // tsserver never has user project files open via lsof — it reads
  // them through synchronous fs calls that leave no long-lived fds.
  // Pivot through VS Code's log files instead: the tsserver's ppid
  // is its ext-host pid, which is recorded in the window's
  // renderer.log and maps to a workspaceStorage entry.
  if (proc.kind === "tsserver" && ppid !== null) {
    const resolved = resolveTsserverWorkspacePath({ exthostPid: ppid });
    if (resolved) return resolved;
  }

  // Last resort: process cwd. eslintServer typically has its cwd set
  // to the workspace root.
  try {
    const { stdout } = await execFileP(
      "/usr/sbin/lsof",
      ["-a", "-d", "cwd", "-p", String(proc.pid), "-Fn"],
      { maxBuffer: 1024 * 1024 },
    );
    const [first] = parseLsofFnPaths(stdout);
    // Reject useless fallbacks like `/` or `/private/var/...`: those
    // aren't real workspaces, and using them leads to either false
    // negatives (`/` mtime bumps constantly) or meaningless activity
    // signals.
    if (first && first.startsWith(home) && first !== home) return first;
  } catch {
    // We've exhausted fallbacks; function returns undefined and the
    // caller treats the workspace as unknown.
  }
  return undefined;
}

/**
 * Return the workspace root's mtime in ms since epoch, or 0 if the
 * path is unknown or unreadable. Directory mtime bumps on every
 * create/delete/rename in the directory — i.e. every editor save —
 * so it's a good "is anyone working here" signal without walking
 * the tree.
 */
export function workspaceMtimeAt(root: string | undefined): number {
  if (!root) return 0;
  try {
    return statSync(root).mtimeMs;
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
