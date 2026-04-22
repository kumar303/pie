/**
 * Per-tick orchestration: run ps, feed the decision engine, kill
 * candidates, emit events.
 */

import {
  parsePsOutput,
  parsePidCommMap,
  filterByParentComm,
  KillDecisionEngine,
  type TsServerProcess,
} from "./monitor.ts";
import type { KilledEvent } from "./protocol.ts";
import { errMessage } from "./errors.ts";

export interface MonitorTickOptions {
  runPs: () => Promise<string>;
  /**
   * Returns `ps -eo pid,comm=` output for parent-comm filtering.
   * Optional — when omitted, the parent-comm check is skipped.
   */
  runPsComm?: () => Promise<string>;
  engine: KillDecisionEngine;
  /** Sends SIGTERM (then SIGKILL after a grace period). Returns true if the pid is gone. */
  killProcess: (pid: number) => Promise<boolean>;
  resolveWorkspacePath: (proc: TsServerProcess) => Promise<string | undefined>;
  emit: (event: KilledEvent) => void;
  /** Called with each non-kill decision for logging. Optional. */
  log?: (msg: string) => void;
  /**
   * PLAN.md verification-after-kill: a ~10s follow-up that re-runs ps
   * and logs a warning if VS Code hasn't respawned a tsserver for the
   * same workspace hash. The monitor loop calls `scheduleRespawnCheck`
   * with the expected hash after every successful kill; pass a no-op
   * to disable.
   */
  scheduleRespawnCheck?: (workspaceHash: string, killedPid: number) => void;
}

export interface MonitorTickResult {
  processes: TsServerProcess[];
  killed: number[];
}

export async function runMonitorTick(
  opts: MonitorTickOptions,
): Promise<MonitorTickResult> {
  const raw = await opts.runPs();
  let processes = parsePsOutput(raw);
  if (opts.runPsComm && processes.length > 0) {
    try {
      const commRaw = await opts.runPsComm();
      const map = parsePidCommMap(commRaw);
      processes = filterByParentComm(processes, map);
    } catch (err) {
      // Permissive: if ps -o pid,comm fails we keep the candidates as-is
      // (better a false-positive kill than missing a rogue tsserver).
      // Still surface so it's visible in /logs.
      opts.log?.(
        `ps pid,comm lookup failed (keeping all candidates): ${errMessage(err)}`,
      );
    }
  }

  opts.engine.prunePids(new Set(processes.map((p) => p.pid)));

  const killed: number[] = [];

  for (const proc of processes) {
    const decision = opts.engine.shouldKill(proc);
    if (!decision.kill) {
      opts.log?.(
        `skip pid=${proc.pid} mode=${proc.mode} rss=${(proc.rssKb / 1024).toFixed(0)}MB: ${decision.reason}`,
      );
      continue;
    }

    const workspacePath = await opts.resolveWorkspacePath(proc);
    let gone: boolean;
    try {
      gone = await opts.killProcess(proc.pid);
    } catch (err) {
      opts.log?.(`kill failed pid=${proc.pid}: ${errMessage(err)}`);
      continue;
    }
    if (!gone) {
      opts.log?.(`kill timed out pid=${proc.pid}`);
      continue;
    }

    killed.push(proc.pid);
    if (proc.workspaceHash) {
      opts.engine.recordKill(proc.workspaceHash);
      opts.scheduleRespawnCheck?.(proc.workspaceHash, proc.pid);
    }
    opts.emit({
      type: "killed",
      pid: proc.pid,
      workspace: proc.workspaceHash,
      workspacePath,
      rssMb: Math.round(proc.rssKb / 1024),
      mode: proc.mode,
      reason: decision.reason,
    });
  }

  return { processes, killed };
}
