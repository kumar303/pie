import { describe, it, expect, vi } from "vitest";
import { runMonitorTick } from "./monitor-loop.ts";
import { IdleDecisionEngine } from "./monitor.ts";

const MIN_AGE_MS = 5 * 60 * 1000;
const IDLE_MS = 60 * 60 * 1000;

function pgrep(
  rows: Array<{ pid: number; workspace?: string | null; eslint?: boolean }>,
): string {
  return rows
    .map((r) => {
      if (r.eslint) {
        return `${r.pid} node /ext/eslintServer.js --node-ipc --clientProcessId=${r.workspace ?? 0}`;
      }
      const cancel =
        r.workspace === null
          ? ""
          : ` --cancellationPipeName /tmp/tscancellation-${r.workspace ?? "abc"}.sock`;
      return `${r.pid} node /path/tsserver.js${cancel}`;
    })
    .join("\n");
}

function makeEngine(now: () => number) {
  return new IdleDecisionEngine({
    minAgeMs: MIN_AGE_MS,
    idleMs: IDLE_MS,
    clock: now,
  });
}

describe("runMonitorTick", () => {
  it("does not kill on first sight (process too young)", async () => {
    const t = 1_000_000_000;
    const engine = makeEngine(() => t);
    const killProcess = vi.fn();
    const runPgrep = vi.fn().mockResolvedValue(pgrep([{ pid: 10 }]));
    const result = await runMonitorTick({
      runPgrep,
      engine,
      killProcess,
      resolveWorkspacePath: async () => "/home/me/project",
      workspaceMtimeAt: () => t - 10 * IDLE_MS, // long-idle
      emit: () => {},
    });
    expect(killProcess).not.toHaveBeenCalled();
    expect(result.killed).toHaveLength(0);
    expect(result.processes).toHaveLength(1);
  });

  it("kills once min-age has passed and workspace is idle", async () => {
    let t = 1_000_000_000;
    const engine = makeEngine(() => t);
    const killProcess = vi.fn().mockResolvedValue(true);
    const runPgrep = vi.fn().mockResolvedValue(pgrep([{ pid: 10 }]));
    const emit = vi.fn();
    const workspaceMtimeAt = () => t - 10 * IDLE_MS;

    // prime
    await runMonitorTick({
      runPgrep,
      engine,
      killProcess,
      resolveWorkspacePath: async () => "/home/me/project",
      workspaceMtimeAt,
      emit,
    });
    expect(killProcess).not.toHaveBeenCalled();

    t += MIN_AGE_MS + 1;
    const result = await runMonitorTick({
      runPgrep,
      engine,
      killProcess,
      resolveWorkspacePath: async () => "/home/me/project",
      workspaceMtimeAt,
      emit,
    });
    expect(killProcess).toHaveBeenCalledWith(10);
    expect(result.killed).toEqual([10]);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "killed",
        pid: 10,
        kind: "tsserver",
        workspace: "abc",
        workspacePath: "/home/me/project",
      }),
    );
  });

  it("kills an eslintServer and emits kind=eslint", async () => {
    let t = 1_000_000_000;
    const engine = makeEngine(() => t);
    const killProcess = vi.fn().mockResolvedValue(true);
    const runPgrep = vi
      .fn()
      .mockResolvedValue(
        pgrep([{ pid: 54321, eslint: true, workspace: "11111" }]),
      );
    const emit = vi.fn();
    const workspaceMtimeAt = () => t - 10 * IDLE_MS;

    await runMonitorTick({
      runPgrep,
      engine,
      killProcess,
      resolveWorkspacePath: async () => "/home/me/project",
      workspaceMtimeAt,
      emit,
    });
    expect(killProcess).not.toHaveBeenCalled();

    t += MIN_AGE_MS + 1;
    const result = await runMonitorTick({
      runPgrep,
      engine,
      killProcess,
      resolveWorkspacePath: async () => "/home/me/project",
      workspaceMtimeAt,
      emit,
    });
    expect(killProcess).toHaveBeenCalledWith(54321);
    expect(result.killed).toEqual([54321]);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "killed",
        kind: "eslint",
        workspace: "eslint:11111",
        workspacePath: "/home/me/project",
      }),
    );
  });

  it("does not kill when workspace is active (recent edit)", async () => {
    let t = 1_000_000_000;
    const engine = makeEngine(() => t);
    const killProcess = vi.fn().mockResolvedValue(true);
    const runPgrep = vi.fn().mockResolvedValue(pgrep([{ pid: 10 }]));

    await runMonitorTick({
      runPgrep,
      engine,
      killProcess,
      resolveWorkspacePath: async () => "/home/me/project",
      workspaceMtimeAt: () => t - 1000,
      emit: () => {},
    });
    t += MIN_AGE_MS + 1;
    const result = await runMonitorTick({
      runPgrep,
      engine,
      killProcess,
      resolveWorkspacePath: async () => "/home/me/project",
      workspaceMtimeAt: () => t - 1000, // edit 1s ago
      emit: () => {},
    });
    expect(killProcess).not.toHaveBeenCalled();
    expect(result.killed).toHaveLength(0);
  });

  it("does not kill when workspace can't be resolved", async () => {
    let t = 1_000_000_000;
    const engine = makeEngine(() => t);
    const killProcess = vi.fn();
    const runPgrep = vi.fn().mockResolvedValue(pgrep([{ pid: 10 }]));

    await runMonitorTick({
      runPgrep,
      engine,
      killProcess,
      resolveWorkspacePath: async () => undefined,
      workspaceMtimeAt: () => 0,
      emit: () => {},
    });
    t += MIN_AGE_MS + 1;
    const result = await runMonitorTick({
      runPgrep,
      engine,
      killProcess,
      resolveWorkspacePath: async () => undefined,
      workspaceMtimeAt: () => 0,
      emit: () => {},
    });
    expect(killProcess).not.toHaveBeenCalled();
    expect(result.killed).toHaveLength(0);
  });

  it("prunes tracking state for pids that disappeared", async () => {
    let t = 1_000_000_000;
    const engine = makeEngine(() => t);
    const prune = vi.spyOn(engine, "prunePids");
    const runPgrep = vi
      .fn()
      .mockResolvedValueOnce(pgrep([{ pid: 10 }, { pid: 20 }]))
      .mockResolvedValueOnce(pgrep([{ pid: 10 }]));
    await runMonitorTick({
      runPgrep,
      engine,
      killProcess: vi.fn(),
      resolveWorkspacePath: async () => undefined,
      workspaceMtimeAt: () => 0,
      emit: () => {},
    });
    t += 10_000;
    await runMonitorTick({
      runPgrep,
      engine,
      killProcess: vi.fn(),
      resolveWorkspacePath: async () => undefined,
      workspaceMtimeAt: () => 0,
      emit: () => {},
    });
    expect(prune).toHaveBeenLastCalledWith(new Set([10]));
  });

  it("schedules a respawn check after a kill with a workspace hash", async () => {
    let t = 1_000_000_000;
    const engine = makeEngine(() => t);
    const runPgrep = vi.fn().mockResolvedValue(pgrep([{ pid: 10 }]));
    const schedule = vi.fn();

    await runMonitorTick({
      runPgrep,
      engine,
      killProcess: vi.fn().mockResolvedValue(true),
      resolveWorkspacePath: async () => "/home/me/project",
      workspaceMtimeAt: () => t - 10 * IDLE_MS,
      emit: () => {},
      scheduleRespawnCheck: schedule,
    });
    expect(schedule).not.toHaveBeenCalled();

    t += MIN_AGE_MS + 1;
    await runMonitorTick({
      runPgrep,
      engine,
      killProcess: vi.fn().mockResolvedValue(true),
      resolveWorkspacePath: async () => "/home/me/project",
      workspaceMtimeAt: () => t - 10 * IDLE_MS,
      emit: () => {},
      scheduleRespawnCheck: schedule,
    });
    expect(schedule).toHaveBeenCalledWith("abc", 10);
  });

  it("does not schedule respawn check when workspace hash is missing", async () => {
    let t = 1_000_000_000;
    const engine = makeEngine(() => t);
    const runPgrep = vi
      .fn()
      .mockResolvedValue(pgrep([{ pid: 10, workspace: null }]));
    const schedule = vi.fn();

    await runMonitorTick({
      runPgrep,
      engine,
      killProcess: vi.fn().mockResolvedValue(true),
      resolveWorkspacePath: async () => "/home/me/project",
      workspaceMtimeAt: () => t - 10 * IDLE_MS,
      emit: () => {},
      scheduleRespawnCheck: schedule,
    });
    t += MIN_AGE_MS + 1;
    await runMonitorTick({
      runPgrep,
      engine,
      killProcess: vi.fn().mockResolvedValue(true),
      resolveWorkspacePath: async () => "/home/me/project",
      workspaceMtimeAt: () => t - 10 * IDLE_MS,
      emit: () => {},
      scheduleRespawnCheck: schedule,
    });
    expect(schedule).not.toHaveBeenCalled();
  });
});
