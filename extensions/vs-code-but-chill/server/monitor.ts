/**
 * Monitor logic for vs-code-but-chill.
 *
 * Pure functions for parsing ps output and classifying VS Code
 * language-server processes (tsserver + eslintServer), plus a
 * KillDecisionEngine that applies the kill rules described in PLAN.md.
 */

export type TsServerMode = "full" | "partialSemantic";
export type ProcessKind = "tsserver" | "eslint";

/**
 * A VS Code language-server process we're monitoring. `kind` picks the
 * memory threshold and the "killed" event label; `workspaceHash`
 * identifies the workspace for circuit-breaker + respawn-check
 * purposes:
 *   - tsserver: the hash in `--cancellationPipeName tscancellation-<hash>`
 *   - eslint:   `eslint:<clientProcessId>` (the VS Code window pid)
 */
export interface TsServerProcess {
  pid: number;
  ppid: number;
  rssKb: number;
  etimeSeconds: number;
  args: string;
  kind: ProcessKind;
  mode: TsServerMode;
  workspaceHash: string | null;
}

/**
 * Parse `ps -eo pid,ppid,rss,etime,args` output.
 * Only rows whose args contain `tsserver.js` are returned.
 * Rows containing `typingsInstaller.js` are filtered out.
 *
 * Note: PLAN.md calls for a "parent comm is Code Helper (Plugin)" check.
 * We do that as a second step in `filterByParentComm` once we have
 * the full ps output, so this parser stays a pure text function.
 */
export function parsePsOutput(output: string): TsServerProcess[] {
  const rows: TsServerProcess[] = [];
  const lines = output.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^PID\b/i.test(line) || /ELAPSED/i.test(line)) continue; // header

    // Columns: PID PPID RSS ETIME COMMAND...
    // Split on whitespace but keep rest of command as one field.
    const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const [, pidStr, ppidStr, rssStr, etimeStr, args] = match;
    const kind = classifyKind(args);
    if (!kind) continue;
    if (args.includes("typingsInstaller.js")) continue;

    rows.push({
      pid: Number(pidStr),
      ppid: Number(ppidStr),
      rssKb: Number(rssStr),
      etimeSeconds: parseEtimeSeconds(etimeStr),
      args,
      kind,
      mode: classifyMode(args),
      workspaceHash:
        kind === "tsserver"
          ? parseWorkspaceHash(args)
          : parseEslintWorkspaceHash(args),
    });
  }
  return rows;
}

/**
 * Classify an args string as one of the monitored VS Code
 * language-server processes, or return null if it's neither.
 *
 * The ESLint LSP server's real launch line looks like:
 *   node .../dbaeumer.vscode-eslint-<ver>/server/out/eslintServer.js
 *        --node-ipc --clientProcessId=<window-pid>
 * (Other transports `--stdio`, `--pipe`, `--socket` are also valid.)
 */
export function classifyKind(args: string): ProcessKind | null {
  if (args.includes("eslintServer.js")) return "eslint";
  if (args.includes("tsserver.js")) return "tsserver";
  return null;
}

/**
 * Workspace identity for ESLint. VS Code's ESLint extension passes
 * `--clientProcessId=<pid>` (or space-separated) identifying the
 * editor window that owns this server. Each window is one workspace
 * from our perspective, so that pid is a stable hash.
 */
export function parseEslintWorkspaceHash(args: string): string | null {
  const m = args.match(/--clientProcessId[=\s]+(\d+)/);
  return m ? `eslint:${m[1]}` : null;
}

/**
 * Parse the output of `ps -o etime=` which uses formats:
 *   SS            (seconds only, rare)
 *   MM:SS
 *   HH:MM:SS
 *   DD-HH:MM:SS
 */
export function parseEtimeSeconds(etime: string): number {
  if (!etime) return 0;
  let days = 0;
  let rest = etime;
  const dashIdx = rest.indexOf("-");
  if (dashIdx !== -1) {
    days = Number(rest.slice(0, dashIdx));
    rest = rest.slice(dashIdx + 1);
  }
  const parts = rest.split(":").map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  let seconds = 0;
  if (parts.length === 3) {
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    seconds = parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    seconds = parts[0];
  }
  return days * 86400 + seconds;
}

/** Extract the workspace "hash" from --cancellationPipeName /path/tscancellation-<hash>.sock */
export function parseWorkspaceHash(args: string): string | null {
  const m = args.match(/tscancellation-([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

export function classifyMode(args: string): TsServerMode {
  if (/--serverMode\s+partialSemantic/.test(args)) return "partialSemantic";
  return "full";
}

/**
 * Parse `ps -eo pid,comm` into a pid → comm map.
 * `comm` is the command name without args (but may contain spaces).
 */
export function parsePidCommMap(output: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^PID\b/i.test(line)) continue;
    const m = line.match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    map.set(Number(m[1]), m[2]);
  }
  return map;
}

/**
 * Keep only processes whose parent `comm` matches a VS Code helper.
 * The expected parent is one of:
 *   - "Code Helper (Plugin)"
 *   - "Code - Insiders Helper (Plugin)"
 *   - "Cursor Helper (Plugin)"
 *   - or any comm matching /Helper \(Plugin\)/
 *
 * Unresolvable ppids (not in the map) are kept — we'd rather log a
 * missed filter than drop legitimate kills.
 */
export function filterByParentComm(
  procs: TsServerProcess[],
  pidToComm: Map<number, string>,
): TsServerProcess[] {
  return procs.filter((p) => {
    const comm = pidToComm.get(p.ppid);
    if (!comm) return true; // unknown parent — be permissive
    return /Helper \(Plugin\)/.test(comm);
  });
}

// ── Kill decision engine ────────────────────────────────────────────

export interface KillDecisionEngineOptions {
  fullMb: number;
  partialMb: number;
  /** Threshold (MB) for ESLint LSP server processes. */
  eslintMb: number;
  minEtimeSeconds: number;
  /** Returns ms since epoch. Defaults to Date.now. */
  clock?: () => number;
  /**
   * Returns the most-recent modification timestamp (unix seconds) for
   * files within the process's workspace. 0 / null when unknown.
   * Used by the "respect user activity" rule.
   */
  recentWorkspaceModifiedAt?: (proc: TsServerProcess) => number;
  /** Window (seconds) to treat as "recent activity". Default 30. */
  recentActivityWindowSec?: number;
}

export interface KillDecision {
  kill: boolean;
  reason: string;
}

interface TrackedProc {
  lastRssKb: number;
  lastSeenAt: number; // ms
}

export class KillDecisionEngine {
  private readonly opts: Required<
    Omit<KillDecisionEngineOptions, "recentWorkspaceModifiedAt">
  > & {
    recentWorkspaceModifiedAt: (proc: TsServerProcess) => number;
  };
  private tracked = new Map<number, TrackedProc>();
  /** Per workspace hash: list of kill timestamps (ms). */
  private kills = new Map<string, number[]>();

  constructor(opts: KillDecisionEngineOptions) {
    this.opts = {
      fullMb: opts.fullMb,
      partialMb: opts.partialMb,
      eslintMb: opts.eslintMb,
      minEtimeSeconds: opts.minEtimeSeconds,
      clock: opts.clock ?? (() => Date.now()),
      recentWorkspaceModifiedAt: opts.recentWorkspaceModifiedAt ?? (() => 0),
      recentActivityWindowSec: opts.recentActivityWindowSec ?? 30,
    };
  }

  #thresholdFor(proc: TsServerProcess): number {
    if (proc.kind === "eslint") return this.opts.eslintMb;
    return proc.mode === "partialSemantic"
      ? this.opts.partialMb
      : this.opts.fullMb;
  }

  shouldKill(proc: TsServerProcess): KillDecision {
    const now = this.opts.clock();
    const prev = this.tracked.get(proc.pid);
    // Always update tracking
    this.tracked.set(proc.pid, { lastRssKb: proc.rssKb, lastSeenAt: now });

    const thresholdMb = this.#thresholdFor(proc);
    const rssMb = proc.rssKb / 1024;

    if (rssMb < thresholdMb) {
      return {
        kill: false,
        reason: `under threshold (${rssMb.toFixed(0)}MB < ${thresholdMb}MB)`,
      };
    }

    if (proc.etimeSeconds < this.opts.minEtimeSeconds) {
      return {
        kill: false,
        reason: `process too young (etime=${proc.etimeSeconds}s < ${this.opts.minEtimeSeconds}s)`,
      };
    }

    if (!prev) {
      return {
        kill: false,
        reason: "first sighting, need growth confirmation",
      };
    }

    if (proc.rssKb < prev.lastRssKb) {
      return {
        kill: false,
        reason: `memory draining (was ${(prev.lastRssKb / 1024).toFixed(0)}MB, now ${rssMb.toFixed(0)}MB)`,
      };
    }

    // Respect user activity
    const lastModified = this.opts.recentWorkspaceModifiedAt(proc);
    if (lastModified > 0) {
      const nowSec = now / 1000;
      const ageSec = nowSec - lastModified;
      if (ageSec < this.opts.recentActivityWindowSec) {
        return {
          kill: false,
          reason: `recent workspace activity (${ageSec.toFixed(1)}s ago)`,
        };
      }
    }

    // Circuit breaker
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
      reason: `rss ${rssMb.toFixed(0)}MB ≥ ${thresholdMb}MB, confirmed growing/flat-high`,
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
