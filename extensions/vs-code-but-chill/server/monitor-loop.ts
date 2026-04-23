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

  for (const proc of processes) {
    const workspacePath = await opts.resolveWorkspacePath(proc);
    const mtime = opts.workspaceMtimeAt(workspacePath);
    const decision = opts.engine.shouldKill(proc, mtime);
    if (!decision.kill) {
      opts.log?.(
        `skip pid=${proc.pid} kind=${proc.kind} workspace=${workspacePath ?? "?"}: ${decision.reason}`,
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
