import { describe, it, expect, vi } from "vitest";
import { runMonitorTick } from "./monitor-loop.ts";
import { KillDecisionEngine } from "./monitor.ts";

function makePsOutput(
  rows: Array<{
    pid: number;
    rssKb: number;
    etimeSec: number;
    /** Workspace hash; pass `null` to omit --cancellationPipeName entirely. */
    workspace?: string | null;
    partial?: boolean;
  }>,
): string {
  const lines = rows.map((r) => {
    const mins = Math.floor(r.etimeSec / 60);
    const secs = r.etimeSec % 60;
    const etime = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    const cancelArg =
      r.workspace === null
        ? ""
        : ` --cancellationPipeName /tmp/tscancellation-${r.workspace ?? "abc"}.sock`;
    const args =
      `node /path/tsserver.js${r.partial ? " --serverMode partialSemantic" : ""}` +
      cancelArg;
    return `${r.pid} 1 ${r.rssKb} ${etime} ${args}`;
  });
  return "PID PPID RSS ELAPSED COMMAND\n" + lines.join("\n");
}

describe("runMonitorTick", () => {
  it("does not kill on first sight", async () => {
    const engine = new KillDecisionEngine({
      fullMb: 2500,
      partialMb: 800,
      eslintMb: 1500,
      minEtimeSeconds: 300,
    });
    const kill = vi.fn();
    const runPs = vi
      .fn()
      .mockResolvedValue(
        makePsOutput([{ pid: 10, rssKb: 3000 * 1024, etimeSec: 1000 }]),
      );
    const result = await runMonitorTick({
      runPs,
      engine,
      killProcess: kill,
      resolveWorkspacePath: async () => undefined,
      emit: () => {},
    });
    expect(kill).not.toHaveBeenCalled();
    expect(result.killed).toHaveLength(0);
    expect(result.processes).toHaveLength(1);
  });

  it("kills after growth confirmed", async () => {
    const engine = new KillDecisionEngine({
      fullMb: 2500,
      partialMb: 800,
      eslintMb: 1500,
      minEtimeSeconds: 300,
    });
    const killFn = vi.fn().mockResolvedValue(true);
    const runPs = vi
      .fn()
      .mockResolvedValue(
        makePsOutput([{ pid: 10, rssKb: 3000 * 1024, etimeSec: 1000 }]),
      );
    const emit = vi.fn();

    // First tick — primes tracking
    await runMonitorTick({
      runPs,
      engine,
      killProcess: killFn,
      resolveWorkspacePath: async () => "/home/me/project",
      emit,
    });
    expect(killFn).not.toHaveBeenCalled();

    // Second tick — same pid, same-or-higher RSS → kill
    runPs.mockResolvedValueOnce(
      makePsOutput([{ pid: 10, rssKb: 3100 * 1024, etimeSec: 1020 }]),
    );
    const result = await runMonitorTick({
      runPs,
      engine,
      killProcess: killFn,
      resolveWorkspacePath: async () => "/home/me/project",
      emit,
    });
    expect(killFn).toHaveBeenCalledWith(10);
    expect(result.killed).toEqual([10]);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "killed",
        pid: 10,
        kind: "tsserver",
        workspace: "abc",
        workspacePath: "/home/me/project",
        mode: "full",
      }),
    );
  });

  it("kills an eslintServer and emits kind=eslint", async () => {
    const engine = new KillDecisionEngine({
      fullMb: 2500,
      partialMb: 800,
      eslintMb: 1500,
      minEtimeSeconds: 300,
    });
    const killFn = vi.fn().mockResolvedValue(true);
    const psOut = (rss: number, etime: string) =>
      [
        "PID PPID RSS ELAPSED COMMAND",
        `54321 11111 ${rss} ${etime} node /ext/eslintServer.js --node-ipc --clientProcessId=11111`,
      ].join("\n");
    const runPs = vi.fn().mockResolvedValueOnce(psOut(1700 * 1024, "10:00"));
    const emit = vi.fn();

    // Prime
    await runMonitorTick({
      runPs,
      engine,
      killProcess: killFn,
      resolveWorkspacePath: async () => "/home/me/project",
      emit,
    });
    expect(killFn).not.toHaveBeenCalled();

    runPs.mockResolvedValueOnce(psOut(1800 * 1024, "10:05"));
    const result = await runMonitorTick({
      runPs,
      engine,
      killProcess: killFn,
      resolveWorkspacePath: async () => "/home/me/project",
      emit,
    });
    expect(killFn).toHaveBeenCalledWith(54321);
    expect(result.killed).toEqual([54321]);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "killed",
        pid: 54321,
        kind: "eslint",
        workspace: "eslint:11111",
        workspacePath: "/home/me/project",
      }),
    );
  });

  it("prunes tracking state for pids that disappeared", async () => {
    const engine = new KillDecisionEngine({
      fullMb: 2500,
      partialMb: 800,
      eslintMb: 1500,
      minEtimeSeconds: 300,
    });
    const prune = vi.spyOn(engine, "prunePids");
    const runPs = vi
      .fn()
      .mockResolvedValueOnce(
        makePsOutput([
          { pid: 10, rssKb: 100, etimeSec: 1000 },
          { pid: 20, rssKb: 100, etimeSec: 1000 },
        ]),
      )
      .mockResolvedValueOnce(
        makePsOutput([{ pid: 10, rssKb: 100, etimeSec: 1020 }]),
      );
    await runMonitorTick({
      runPs,
      engine,
      killProcess: vi.fn(),
      resolveWorkspacePath: async () => undefined,
      emit: () => {},
    });
    await runMonitorTick({
      runPs,
      engine,
      killProcess: vi.fn(),
      resolveWorkspacePath: async () => undefined,
      emit: () => {},
    });
    expect(prune).toHaveBeenLastCalledWith(new Set([10]));
  });

  it("schedules a respawn check after a kill with a workspace hash", async () => {
    const engine = new KillDecisionEngine({
      fullMb: 2500,
      partialMb: 800,
      eslintMb: 1500,
      minEtimeSeconds: 300,
    });
    const runPs = vi
      .fn()
      .mockResolvedValue(
        makePsOutput([
          { pid: 10, rssKb: 3000 * 1024, etimeSec: 1000, workspace: "abc" },
        ]),
      );
    const schedule = vi.fn();
    // First tick primes tracking without killing.
    await runMonitorTick({
      runPs,
      engine,
      killProcess: vi.fn().mockResolvedValue(true),
      resolveWorkspacePath: async () => undefined,
      emit: () => {},
      scheduleRespawnCheck: schedule,
    });
    expect(schedule).not.toHaveBeenCalled();
    // Second tick sees confirmed growth and kills.
    runPs.mockResolvedValueOnce(
      makePsOutput([
        { pid: 10, rssKb: 3100 * 1024, etimeSec: 1020, workspace: "abc" },
      ]),
    );
    await runMonitorTick({
      runPs,
      engine,
      killProcess: vi.fn().mockResolvedValue(true),
      resolveWorkspacePath: async () => undefined,
      emit: () => {},
      scheduleRespawnCheck: schedule,
    });
    expect(schedule).toHaveBeenCalledWith("abc", 10);
  });

  it("does not schedule respawn check when workspace hash is missing", async () => {
    const engine = new KillDecisionEngine({
      fullMb: 2500,
      partialMb: 800,
      eslintMb: 1500,
      minEtimeSeconds: 300,
    });
    const runPs = vi
      .fn()
      .mockResolvedValue(
        makePsOutput([
          { pid: 10, rssKb: 3000 * 1024, etimeSec: 1000, workspace: null },
        ]),
      );
    const schedule = vi.fn();
    await runMonitorTick({
      runPs,
      engine,
      killProcess: vi.fn().mockResolvedValue(true),
      resolveWorkspacePath: async () => undefined,
      emit: () => {},
      scheduleRespawnCheck: schedule,
    });
    runPs.mockResolvedValueOnce(
      makePsOutput([
        { pid: 10, rssKb: 3100 * 1024, etimeSec: 1020, workspace: null },
      ]),
    );
    await runMonitorTick({
      runPs,
      engine,
      killProcess: vi.fn().mockResolvedValue(true),
      resolveWorkspacePath: async () => undefined,
      emit: () => {},
      scheduleRespawnCheck: schedule,
    });
    expect(schedule).not.toHaveBeenCalled();
  });
});
