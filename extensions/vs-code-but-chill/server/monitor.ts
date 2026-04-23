/**
 * Monitor logic for vs-code-but-chill.
 *
 * Parses `pgrep -afl` output into candidate processes and decides
 * whether each one is idle enough to kill. We can't read RSS without
 * a setuid binary (blocked by the macOS sandbox), so idleness is
 * derived from workspace-directory mtime: if no one has saved a
 * file in the workspace for a while, the language server is fair
 * game. Killing is cheap — VS Code respawns immediately when needed.
 */

export type ProcessKind = "tsserver" | "eslint";

export interface MonitoredProcess {
  pid: number;
  args: string;
  kind: ProcessKind;
  /**
   * Stable per-workspace identity used for the circuit breaker and
   * respawn check. For tsserver this is the cancellationPipeName
   * hash; for eslintServer it's `eslint:<clientProcessId>` (the
   * editor window pid).
   */
  workspaceHash: string | null;
  /**
   * Filesystem path whose mtime tracks VS Code talking to this
   * process. For tsserver: the `--cancellationPipeName` parent dir,
   * which VS Code writes a new file into on every request. For
   * eslintServer: null (we use the lsof-resolved workspace instead).
   */
  activityPath: string | null;
}

/**
 * Parse `pgrep -afl <pattern>` output — one process per line:
 *   `<pid> <argv...>`
 * Anything without a matching kind classifier is dropped. Rows whose
 * argv contains `typingsInstaller.js` are filtered out — that's a
 * separate child that VS Code manages on its own.
 */
export function parsePgrepOutput(output: string): MonitoredProcess[] {
  const rows: MonitoredProcess[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const args = m[2];
    const kind = classifyKind(args);
    if (!kind) continue;
    if (args.includes("typingsInstaller.js")) continue;
    rows.push({
      pid,
      args,
      kind,
      workspaceHash:
        kind === "tsserver"
          ? parseWorkspaceHash(args)
          : parseEslintWorkspaceHash(args),
      activityPath: kind === "tsserver" ? parseCancellationDir(args) : null,
    });
  }
  return rows;
}

export function classifyKind(args: string): ProcessKind | null {
  if (args.includes("eslintServer.js")) return "eslint";
  if (args.includes("tsserver.js")) return "tsserver";
  return null;
}

/** Extract the workspace hash from `--cancellationPipeName /path/tscancellation-<hash>`. */
export function parseWorkspaceHash(args: string): string | null {
  const m = args.match(/tscancellation-([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

/**
 * Extract the parent directory of `--cancellationPipeName` from a
 * tsserver's argv. VS Code creates a new `tscancellation-*` file in
 * that directory on every request, so the directory mtime is a
 * direct "is VS Code talking to this workspace" signal.
 *
 * Returns null when the flag is missing, the value isn't absolute,
 * or the path has no parent. VS Code appends a trailing `*` glob
 * marker to the value, which we strip.
 */
export function parseCancellationDir(args: string): string | null {
  const m = args.match(/--cancellationPipeName[=\s]+(\/[^\s*]+)/);
  if (!m) return null;
  const file = m[1];
  const slash = file.lastIndexOf("/");
  if (slash <= 0) return null;
  return file.slice(0, slash);
}

/**
 * ESLint LSP server workspace identity. VS Code passes
 * `--clientProcessId=<pid>` (or space-separated) identifying the
 * owning editor window, which is one workspace from our perspective.
 */
export function parseEslintWorkspaceHash(args: string): string | null {
  const m = args.match(/--clientProcessId[=\s]+(\d+)/);
  return m ? `eslint:${m[1]}` : null;
}

// ── Kill decision engine ────────────────────────────────────────────

export interface IdleDecisionEngineOptions {
  /**
   * A process must have been observed for at least this long before
   * it's eligible to be killed. Guards against killing a freshly
   * spawned server that hasn't had a chance to be useful yet.
   */
  minAgeMs: number;
  /**
   * Kill when the workspace directory's mtime is older than this.
   * Directory mtime bumps on every file create/delete/rename — i.e.
   * any save VS Code performs — so "no recent mtime" is a reliable
   * proxy for "no one is working here".
   */
  idleMs: number;
  /** Returns ms since epoch. Defaults to Date.now. */
  clock?: () => number;
}

export interface IdleDecision {
  kill: boolean;
  reason: string;
}

interface TrackedProc {
  firstSeenAt: number;
}

/**
 * Per-pid bookkeeping and per-workspace circuit breaker. The engine
 * is purely advisory — the caller supplies the process list and the
 * workspace-mtime lookup; the engine decides yes/no with a reason.
 */
export class IdleDecisionEngine {
  private readonly opts: Required<IdleDecisionEngineOptions>;
  private tracked = new Map<number, TrackedProc>();
  /** Per workspace hash: list of kill timestamps (ms). */
  private kills = new Map<string, number[]>();

  constructor(opts: IdleDecisionEngineOptions) {
    this.opts = {
      minAgeMs: opts.minAgeMs,
      idleMs: opts.idleMs,
      clock: opts.clock ?? (() => Date.now()),
    };
  }

  /**
   * Decide whether to kill `proc`. `workspaceMtimeMs` is the most
   * recent mtime of the process's workspace root in ms (0 when the
   * workspace isn't known). When we can't resolve a workspace we
   * can't measure idleness, so we skip — better to leave a server
   * alone than to kill one we don't understand.
   */
  shouldKill(proc: MonitoredProcess, workspaceMtimeMs: number): IdleDecision {
    const now = this.opts.clock();
    const prev = this.tracked.get(proc.pid);
    const firstSeenAt = prev?.firstSeenAt ?? now;
    if (!prev) this.tracked.set(proc.pid, { firstSeenAt });

    const age = now - firstSeenAt;
    if (age < this.opts.minAgeMs) {
      return {
        kill: false,
        reason: `process too young (age=${Math.round(age / 1000)}s < ${Math.round(this.opts.minAgeMs / 1000)}s)`,
      };
    }

    if (workspaceMtimeMs <= 0) {
      return { kill: false, reason: "workspace unknown" };
    }

    const idleFor = now - workspaceMtimeMs;
    if (idleFor < this.opts.idleMs) {
      return {
        kill: false,
        reason: `workspace active (${Math.round(idleFor / 1000)}s since last edit)`,
      };
    }

    if (proc.workspaceHash) {
      const recent = this.recentKills(proc.workspaceHash, now);
      if (recent.length >= 3) {
        return {
          kill: false,
          reason: `circuit breaker: ${recent.length} kills in last hour for workspace ${proc.workspaceHash}`,
        };
      }
    }

    return {
      kill: true,
      reason: `workspace idle ${Math.round(idleFor / 1000)}s ≥ ${Math.round(this.opts.idleMs / 1000)}s`,
    };
  }

  recordKill(workspaceHash: string): void {
    const now = this.opts.clock();
    const arr = this.kills.get(workspaceHash) ?? [];
    arr.push(now);
    this.kills.set(workspaceHash, arr);
  }

  private recentKills(hash: string, now: number): number[] {
    const arr = this.kills.get(hash) ?? [];
    const cutoff = now - 3600 * 1000;
    const recent = arr.filter((t) => t >= cutoff);
    this.kills.set(hash, recent);
    return recent;
  }

  /** Remove tracking entries for pids not in the `alive` set. */
  prunePids(alive: Set<number>): void {
    for (const pid of this.tracked.keys()) {
      if (!alive.has(pid)) {
        this.tracked.delete(pid);
      }
    }
  }
}
