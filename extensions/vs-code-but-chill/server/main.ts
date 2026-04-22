/**
 * Server entry point for vs-code-but-chill.
 *
 * Runs detached from any pi process. Monitors tsserver processes and
 * restarts oversized ones. Talks to pi-extension clients over a Unix
 * domain socket.
 *
 * Usage:
 *   node <jiti> main.ts <dataDir>
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Registry, pathsFor, detectInvalidState } from "./registry.ts";
import { KillDecisionEngine, parsePsOutput } from "./monitor.ts";
import { runMonitorTick } from "./monitor-loop.ts";
import { IpcServer } from "./ipc.ts";
import { LogWriter } from "./log.ts";
import { errMessage } from "./errors.ts";
import {
  runPs,
  runPsComm,
  killWithTimeout,
  resolveWorkspacePath,
  recentWorkspaceActivityAt,
} from "./proc-utils.ts";

interface Config {
  fullMb: number;
  partialMb: number;
  tickMs: number;
  minEtimeSec: number;
}

function readConfig(): Config {
  const env = process.env;
  return {
    fullMb: Number(env.VSCBC_FULL_MB) || 2500,
    partialMb: Number(env.VSCBC_PARTIAL_MB) || 800,
    tickMs: Number(env.VSCBC_TICK_MS) || 20 * 60 * 1000,
    minEtimeSec: Number(env.VSCBC_MIN_ETIME_S) || 300,
  };
}

async function main(dataDir: string): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  const paths = pathsFor(dataDir);

  // Note: Node.js doesn't expose setpgid(2). For cleanup on shutdown
  // we instead use `pkill -P <pid>` to target direct children. This is
  // macOS-friendly and doesn't risk signalling unrelated processes.

  // Invalid-state check before acquiring pid
  const pre = detectInvalidState(dataDir);
  if (!pre.valid && pre.pidFromFile && !pre.pidAlive) {
    // stale pid file — will be overwritten by tryAcquirePid
  }

  const registry = new Registry(dataDir);
  if (!registry.tryAcquirePid()) {
    // Another server is alive and well
    process.exit(0);
  }

  const log = new LogWriter(paths.logFile, paths.logRotatedFile);
  log.write(`vs-code-but-chill server started pid=${process.pid}`);
  log.write(
    `to stop manually: kill ${process.pid}    (or: pkill -P ${process.pid}; kill ${process.pid})`,
  );

  const config = readConfig();
  log.write(
    `config full=${config.fullMb}MB partial=${config.partialMb}MB tick=${config.tickMs}ms minEtime=${config.minEtimeSec}s`,
  );

  const engine = new KillDecisionEngine({
    fullMb: config.fullMb,
    partialMb: config.partialMb,
    minEtimeSeconds: config.minEtimeSec,
    // Recent workspace activity hook — lightweight heuristic only.
    recentWorkspaceModifiedAt: (proc) =>
      recentWorkspaceActivityAt(workspaceCache.get(proc.workspaceHash ?? "")),
  });

  // Last known snapshot for the `status` IPC request
  let lastProcesses: Awaited<ReturnType<typeof runMonitorTick>>["processes"] =
    [];
  let killCount = 0;
  const startedAt = Date.now();

  // Cache: workspace hash → resolved filesystem path.
  const workspaceCache = new Map<string, string | undefined>();

  const cachedResolveWorkspacePath = async (proc: {
    pid: number;
    workspaceHash: string | null;
  }) => {
    const key = proc.workspaceHash ?? "";
    if (key && workspaceCache.has(key)) return workspaceCache.get(key);
    const resolved = await resolveWorkspacePath(proc);
    if (key) workspaceCache.set(key, resolved);
    return resolved;
  };

  // Clean stale socket file before binding. If this fails we'll find
  // out immediately when the IPC server fails to bind and we abort.
  if (existsSync(paths.socketPath)) {
    try {
      unlinkSync(paths.socketPath);
    } catch (err) {
      log.write(
        `could not remove stale socket ${paths.socketPath}: ${errMessage(err)}`,
      );
    }
  }

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.write(`shutdown: ${reason}`);
    if (tickHandle) clearInterval(tickHandle);
    try {
      await ipc.stop();
    } catch (err) {
      log.write(`ipc.stop failed: ${errMessage(err)}`);
    }
    // Signal direct children (ps/lsof/kill waits), wait briefly,
    // then hard-kill any stragglers. pkill itself failing is unexpected
    // and worth logging.
    try {
      spawnSync("/usr/bin/pkill", ["-TERM", "-P", String(process.pid)], {
        stdio: "ignore",
        timeout: 1000,
      });
    } catch (err) {
      log.write(`pkill -TERM failed: ${errMessage(err)}`);
    }
    setTimeout(() => {
      try {
        spawnSync("/usr/bin/pkill", ["-KILL", "-P", String(process.pid)], {
          stdio: "ignore",
          timeout: 1000,
        });
      } catch (err) {
        log.write(`pkill -KILL failed: ${errMessage(err)}`);
      }
    }, 500);
    registry.cleanup();
    // Flush log listeners
    setTimeout(() => process.exit(0), 50);
  };

  const ipc = new IpcServer(paths.socketPath, {
    onHello: (pid) => {
      registry.addClient(pid);
      log.write(`client hello pid=${pid} total=${registry.clientCount}`);
    },
    onBye: (pid) => {
      registry.removeClient(pid);
      log.write(`client bye pid=${pid} remaining=${registry.clientCount}`);
      if (registry.clientCount === 0) {
        void shutdown("last client disconnected");
      }
    },
    getStatus: () => ({
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      killed: killCount,
      watching: lastProcesses.map((p) => ({
        pid: p.pid,
        rssMb: Math.round(p.rssKb / 1024),
        mode: p.mode,
        workspace: p.workspaceHash,
        etimeSec: p.etimeSeconds,
      })),
    }),
    getLogs: (tail) => log.tail(tail),
    onStop: () => {
      void shutdown("stop command");
    },
  });
  await ipc.start();

  // Stream new log lines to event-subscribers (the log viewer).
  log.onLine((line) => {
    ipc.broadcastLog(line);
  });

  /**
   * PLAN.md verification: ~10 seconds after a kill, re-run ps and
   * check whether VS Code has respawned a tsserver for the same
   * workspace hash. Log a warning if not.
   */
  const scheduleRespawnCheck = (workspaceHash: string, killedPid: number) => {
    setTimeout(() => {
      void (async () => {
        try {
          const raw = await runPs();
          const procs = parsePsOutput(raw);
          const found = procs.find(
            (p) => p.workspaceHash === workspaceHash && p.pid !== killedPid,
          );
          if (!found) {
            log.write(
              `WARN no respawn detected 10s after killing pid=${killedPid} workspace=${workspaceHash}`,
            );
          }
        } catch (err) {
          log.write(`respawn check failed: ${errMessage(err)}`);
        }
      })();
    }, 10_000).unref();
  };

  const tick = async () => {
    try {
      registry.pruneDeadClients();
      if (registry.clientCount === 0) {
        // No live clients — nothing is listening; keep running but skip work
      }
      const result = await runMonitorTick({
        runPs,
        runPsComm,
        engine,
        killProcess: (pid) => killWithTimeout(pid),
        resolveWorkspacePath: cachedResolveWorkspacePath,
        emit: (ev) => {
          ipc.broadcastEvent(ev);
          log.write(
            `killed pid=${ev.pid} mode=${ev.mode} rss=${ev.rssMb}MB workspace=${ev.workspacePath ?? ev.workspace ?? "?"} reason=${ev.reason}`,
          );
        },
        log: (msg) => log.write(msg),
        scheduleRespawnCheck,
      });
      lastProcesses = result.processes;
      killCount += result.killed.length;
    } catch (err) {
      log.write(`tick error: ${errMessage(err)}`);
      ipc.broadcastEvent({
        type: "error",
        message: errMessage(err),
      });
    }
  };

  const tickHandle = setInterval(() => {
    void tick();
  }, config.tickMs);
  // Run one tick at startup to prime state.
  void tick();

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    log.write(`uncaughtException: ${errMessage(err)}`);
  });
  process.on("unhandledRejection", (err) => {
    log.write(`unhandledRejection: ${String(err)}`);
  });
}

const dataDir = process.argv[2];
if (!dataDir) {
  process.stderr.write("Usage: main.ts <dataDir>\n");
  process.exit(1);
}
void main(dataDir);
