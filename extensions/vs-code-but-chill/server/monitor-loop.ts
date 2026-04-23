/**
 * Per-tick orchestration: enumerate candidate processes, resolve each
 * one's workspace, ask the engine for an idleness decision, kill
 * eligible targets, emit events.
 */

import {
  parsePgrepOutput,
  IdleDecisionEngine,
  type MonitoredProcess,
} from "./monitor.ts";
import type { KilledEvent } from "./protocol.ts";
import { errMessage } from "./errors.ts";

export interface MonitorTickOptions {
  runPgrep: () => Promise<string>;
  engine: IdleDecisionEngine;
  killProcess: (pid: number) => Promise<boolean>;
  resolveWorkspacePath: (proc: MonitoredProcess) => Promise<string | undefined>;
  /**
   * Returns the most-recent mtime (ms since epoch) of the workspace
   * root. 0 when the path is unknown or unreadable.
   */
  workspaceMtimeAt: (path: string | undefined) => number;
  emit: (event: KilledEvent) => void;
  log?: (msg: string) => void;
  /**
   * Follow-up that re-runs enumeration a few seconds later and logs
   * a warning if VS Code hasn't respawned a server for the killed
   * workspace. Pass a no-op to disable.
   */
  scheduleRespawnCheck?: (workspaceHash: string, killedPid: number) => void;
}

export interface MonitorTickResult {
  processes: MonitoredProcess[];
  killed: number[];
}

export async function runMonitorTick(
  opts: MonitorTickOptions,
): Promise<MonitorTickResult> {
  const raw = await opts.runPgrep();
  const processes = parsePgrepOutput(raw);

  opts.engine.prunePids(new Set(processes.map((p) => p.pid)));

  const killed: number[] = [];
  // Tick-scoped resolve cache: multiple tsservers for the same
  // workspace share an ext host and resolve to the same path, so
  // doing the lsof + log pivot once per workspace per tick is both
  // correct and a meaningful win. Cleared at the end of the tick.
  const resolveCache = new Map<string, string | undefined>();

  for (const proc of processes) {
    const key = proc.workspaceHash;
    let workspacePath: string | undefined;
    if (key && resolveCache.has(key)) {
      workspacePath = resolveCache.get(key);
    } else {
      workspacePath = await opts.resolveWorkspacePath(proc);
      if (key) resolveCache.set(key, workspacePath);
    }
    // Prefer the process's own activityPath (tsserver's cancellation
    // pipe dir) because lsof can't see tsserver's project files. For
    // eslint and anything else without one, fall back to the resolved
    // workspace path.
    const mtimeSource = proc.activityPath ?? workspacePath;
    const mtime = opts.workspaceMtimeAt(mtimeSource);
    const decision = opts.engine.shouldKill(proc, mtime);
    if (!decision.kill) {
      opts.log?.(
        `skip pid=${proc.pid} kind=${proc.kind} workspace=${workspacePath ?? proc.workspaceHash ?? "?"}: ${decision.reason}`,
      );
      continue;
    }

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
      kind: proc.kind,
      workspace: proc.workspaceHash,
      workspacePath,
      reason: decision.reason,
    });
  }

  return { processes, killed };
}
