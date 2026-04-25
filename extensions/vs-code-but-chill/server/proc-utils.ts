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

// ── Orphan-server sweep ────────────────────────────────────────────
//
// The dataDir-scoped pid file in `registry.ts` only protects against
// a *second* server running in the *same* dataDir. It can't see
// orphan servers from earlier `pi -e` sessions whose dataDir was a
// fresh temp directory, or from a different checkout of this
// extension entirely.

/**
 * `pgrep -af <pattern>` matches against the full command line as a
 * regex. We anchor on the relative path of `server/main.ts` so we
 * find this extension's server regardless of where the repo is
 * checked out, and we escape `.` so the dot doesn't accidentally
 * match other characters in unrelated processes' command lines.
 */
export const SERVER_PGREP_PATTERN = "vs-code-but-chill/server/main\\.ts";

interface FoundServer {
  pid: number;
  dataDir: string;
}

type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string }>;

/**
 * Pure parser for one line of `pgrep -afl` output. Returns null when
 * the line isn't a valid vs-code-but-chill server invocation.
 *
 * Expected shape:
 *   `<pid> <node> <jiti-cli> <...>/server/main.ts <dataDir>`
 */
export function parseServerPgrepLine(line: string): FoundServer | null {
  if (!line) return null;
  const tokens = line.trim().split(/\s+/);
  if (tokens.length < 2) return null;
  const pid = Number(tokens[0]);
  if (!Number.isFinite(pid) || pid <= 0 || !/^\d+$/.test(tokens[0])) {
    return null;
  }
  const mainIdx = tokens.findIndex((t) =>
    t.endsWith("/vs-code-but-chill/server/main.ts"),
  );
  if (mainIdx < 0) return null;
  const dataDir = tokens[mainIdx + 1];
  if (!dataDir) return null;
  return { pid, dataDir };
}

/**
 * Enumerate every running server process. Errors from `pgrep` other
 * than "no matches" (exit 1) bubble up so a misconfigured environment
 * is visible instead of silently pretending no orphans exist.
 */
export async function findOtherServers(opts?: {
  exec?: ExecFn;
  selfPid?: number;
}): Promise<FoundServer[]> {
  const exec: ExecFn =
    opts?.exec ??
    (((file: string, args: string[]) =>
      execFileP(file, args, { maxBuffer: 10 * 1024 * 1024 })) as ExecFn);

  let stdout: string;
  try {
    const result = await exec("/usr/bin/pgrep", ["-afl", SERVER_PGREP_PATTERN]);
    stdout = result.stdout;
  } catch (err) {
    // pgrep exits 1 when there are no matches — not an error.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: unknown }).code === 1
    ) {
      return [];
    }
    throw err;
  }

  const out: FoundServer[] = [];
  for (const line of stdout.split("\n")) {
    const parsed = parseServerPgrepLine(line);
    if (!parsed) continue;
    if (opts?.selfPid !== undefined && parsed.pid === opts.selfPid) continue;
    out.push(parsed);
  }
  return out;
}

/** Minimal write-only log sink. Matches `LogWriter` in `./log.ts`. */
export interface SweepLogSink {
  write(line: string): void;
}

/**
 * Sweep the host for any sibling vs-code-but-chill servers running
 * in *other* dataDirs and terminate them. Run once at startup so
 * orphans are dead before we bind the socket. Failures are caught
 * and logged so a transient pgrep / kill issue never blocks startup.
 */
export async function sweepOrphanServers(opts: {
  dataDir: string;
  log: SweepLogSink;
  exec?: ExecFn;
  kill?: (pid: number) => Promise<boolean>;
}): Promise<void> {
  const killFn = opts.kill ?? ((pid: number) => killWithTimeout(pid));
  try {
    const found = await findOtherServers({
      exec: opts.exec,
      selfPid: process.pid,
    });
    const killed: number[] = [];
    const failed: number[] = [];
    for (const f of found) {
      if (f.dataDir === opts.dataDir) continue;
      const ok = await killFn(f.pid);
      if (ok) killed.push(f.pid);
      else failed.push(f.pid);
    }
    if (killed.length > 0) {
      opts.log.write(
        `swept orphan vs-code-but-chill servers: pids=${killed.join(",")}`,
      );
    }
    if (failed.length > 0) {
      opts.log.write(
        `could not kill orphan vs-code-but-chill server pids: ${failed.join(",")}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.log.write(`orphan sweep failed: ${message}`);
  }
}
