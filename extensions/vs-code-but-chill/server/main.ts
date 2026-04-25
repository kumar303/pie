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
import { IdleDecisionEngine, parsePgrepOutput } from "./monitor.ts";
import { runMonitorTick } from "./monitor-loop.ts";
import { IpcServer } from "./ipc.ts";
import { LogWriter } from "./log.ts";
import { errMessage } from "./errors.ts";
import {
  runPgrep,
  killWithTimeout,
  resolveWorkspacePath,
  workspaceMtimeAt,
  sweepOrphanServers,
} from "./proc-utils.ts";

interface Config {
  tickMs: number;
  minAgeMs: number;
  idleMs: number;
}

function readConfig(): Config {
  const env = process.env;
  return {
    tickMs: Number(env.VSCBC_TICK_MS) || 20 * 60 * 1000,
    minAgeMs: Number(env.VSCBC_MIN_AGE_MS) || 5 * 60 * 1000,
    idleMs: Number(env.VSCBC_IDLE_MS) || 60 * 60 * 1000,
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

  // Sweep any sibling vs-code-but-chill servers running in *other*
  // dataDirs (orphans from previous `pi -e` sessions, stale launchd
  // jobs, manual debugging). Doing this *before* binding the socket
  // means new clients always reach this server, not a zombie.
  await sweepOrphanServers({ dataDir, log });

  const config = readConfig();
  log.write(
    `config tick=${config.tickMs}ms minAge=${config.minAgeMs}ms idle=${config.idleMs}ms`,
  );

  const engine = new IdleDecisionEngine({
    minAgeMs: config.minAgeMs,
    idleMs: config.idleMs,
  });

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
    onStop: () => {
      void shutdown("stop command");
    },
    onReap: async () => {
      log.write("reap requested by client");
      const result = await safeTick();
      log.write(
        result.ok
          ? `reap done killed=${result.killed}`
          : `reap failed: ${result.error}`,
      );
      return result;
    },
  });
  await ipc.start();

  /**
   * PLAN.md verification: ~10 seconds after a kill, re-run ps and
   * check whether VS Code has respawned a tsserver for the same
   * workspace hash. Log a warning if not.
   */
  const scheduleRespawnCheck = (workspaceHash: string, killedPid: number) => {
    setTimeout(() => {
      void (async () => {
        try {
          const raw = await runPgrep();
          const procs = parsePgrepOutput(raw);
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

  /**
   * Run the monitoring pass once.
   *
   * Returns the number of processes killed this tick so the `reap`
   * IPC handler can report an accurate count back to the caller. On
   * failure it logs and broadcasts an error event (as before) and
   * rethrows — the interval wrapper catches; `reap` surfaces the
   * error to the client as `{ ok: false, error }`.
   */
  const tick = async (): Promise<number> => {
    registry.pruneDeadClients();
    if (registry.clientCount === 0) {
      // No live clients — nothing is listening; keep running but skip work
    }
    const result = await runMonitorTick({
      runPgrep,
      engine,
      killProcess: (pid) => killWithTimeout(pid),
      resolveWorkspacePath,
      workspaceMtimeAt,
      emit: (ev) => {
        ipc.broadcastKilled(ev);
        log.write(
          `killed ${ev.kind} pid=${ev.pid} workspace=${ev.workspacePath ?? ev.workspace ?? "?"} reason=${ev.reason}`,
        );
      },
      log: (msg) => log.write(msg),
      scheduleRespawnCheck,
    });
    return result.killed.length;
  };

  /**
   * Wrap `tick()` with the one-and-only error path: on failure, log
   * the error, broadcast it to event subscribers, and return an
   * `{ ok: false, error }` result. The interval loop ignores the
   * return; the `reap` handler forwards it to the requesting client
   * so users get the same "went wrong" signal either way.
   */
  const safeTick = async (): Promise<{
    ok: boolean;
    killed: number;
    error?: string;
  }> => {
    try {
      const killed = await tick();
      return { ok: true, killed };
    } catch (err) {
      const message = errMessage(err);
      // The log write fans out to event subscribers via `log.onLine`
      // → `ipc.broadcastLog`, so a second `ipc.broadcastEvent({type:
      // "error"})` here would show the same failure twice in the log
      // viewer. Keep the canonical single entry.
      log.write(`tick error: ${message}`);
      return { ok: false, killed: 0, error: message };
    }
  };

  const tickHandle = setInterval(() => {
    void safeTick();
  }, config.tickMs);
  // Run one tick at startup to prime state.
  void safeTick();

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
