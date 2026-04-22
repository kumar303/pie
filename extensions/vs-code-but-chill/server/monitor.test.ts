import { describe, it, expect, beforeEach } from "vitest";
import {
  parsePsOutput,
  parseWorkspaceHash,
  classifyMode,
  parseEtimeSeconds,
  parsePidCommMap,
  filterByParentComm,
  type TsServerProcess,
  KillDecisionEngine,
} from "./monitor.ts";

describe("parsePsOutput — eslintServer.js", () => {
  it("parses an eslintServer row and tags it kind=eslint", () => {
    // Actual VS Code ESLint extension launches look like this on macOS
    // (observed in /Users/.../dbaeumer.vscode-eslint-*/client/out/extension.js).
    // The server is forked by the `Code Helper (Plugin)` parent with
    // `--node-ipc` plus `--clientProcessId=<window-pid>`.
    const psOut = `
  PID  PPID    RSS     ELAPSED COMMAND
54321 11111 1800000      12:30 /usr/local/bin/node --max-old-space-size=4096 /Users/me/.vscode/extensions/dbaeumer.vscode-eslint-3.0.24/server/out/eslintServer.js --node-ipc --clientProcessId=11111
`.trim();
    const rows = parsePsOutput(psOut);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pid: 54321,
      kind: "eslint",
      mode: "full",
      workspaceHash: "eslint:11111",
    });
  });

  it("parses tsserver and eslint rows together", () => {
    const psOut = `
  PID  PPID    RSS     ELAPSED COMMAND
12345 11111 3072000      10:15 node /path/tsserver.js --cancellationPipeName /tmp/tscancellation-foo.sock
54321 11111 1800000      12:30 node /ext/eslintServer.js --node-ipc --clientProcessId=11111
`.trim();
    const rows = parsePsOutput(psOut);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind).sort()).toEqual(["eslint", "tsserver"]);
  });

  it("returns workspaceHash null when clientProcessId is missing", () => {
    const psOut = `
  PID  PPID    RSS     ELAPSED COMMAND
54321 11111 1800000   00:00:30 node /ext/eslintServer.js --stdio
`.trim();
    const rows = parsePsOutput(psOut);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("eslint");
    expect(rows[0].workspaceHash).toBeNull();
  });

  it("accepts `--clientProcessId 11111` space form", () => {
    const psOut = `
  PID  PPID    RSS     ELAPSED COMMAND
54321 11111 1800000   00:00:30 node /ext/eslintServer.js --node-ipc --clientProcessId 22222
`.trim();
    expect(parsePsOutput(psOut)[0].workspaceHash).toBe("eslint:22222");
  });
});

describe("parsePsOutput", () => {
  it("tags tsserver rows with kind=tsserver", () => {
    const psOut = `
  PID  PPID    RSS     ELAPSED COMMAND
12345 11111 3072000      10:15 node /path/tsserver.js --cancellationPipeName /tmp/tscancellation-foo.sock
`.trim();
    expect(parsePsOutput(psOut)[0].kind).toBe("tsserver");
  });

  it("parses a single full-semantic tsserver row", () => {
    const psOut = `
  PID  PPID    RSS     ELAPSED COMMAND
12345 11111 3072000      10:15 /usr/local/bin/node /path/to/tsserver.js --serverMode partialSemantic --cancellationPipeName /var/folders/xx/abcdef123/tscancellation-foo
`.trim();
    const rows = parsePsOutput(psOut);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pid: 12345,
      ppid: 11111,
      rssKb: 3072000,
      etimeSeconds: 10 * 60 + 15,
      args: expect.stringContaining("tsserver.js"),
    });
  });

  it("skips non-tsserver lines", () => {
    const psOut = `
  PID  PPID    RSS     ELAPSED COMMAND
12345 11111   1024       00:05 node /path/to/typingsInstaller.js
22222 11111 3072000   01:10:00 node /path/to/tsserver.js
`.trim();
    const rows = parsePsOutput(psOut);
    expect(rows).toHaveLength(1);
    expect(rows[0].pid).toBe(22222);
  });

  it("excludes typingsInstaller.js even if tsserver.js appears elsewhere", () => {
    const psOut = `
  PID  PPID    RSS     ELAPSED COMMAND
99999 11111   1024   00:00:05 node /path/tsserver.js/foo/typingsInstaller.js
`.trim();
    const rows = parsePsOutput(psOut);
    expect(rows).toHaveLength(0);
  });

  it("returns empty for blank input", () => {
    expect(parsePsOutput("")).toEqual([]);
    expect(parsePsOutput("\n")).toEqual([]);
  });
});

describe("parseEtimeSeconds", () => {
  it("parses SS", () => {
    expect(parseEtimeSeconds("42")).toBe(42);
  });
  it("parses MM:SS", () => {
    expect(parseEtimeSeconds("05:30")).toBe(5 * 60 + 30);
  });
  it("parses HH:MM:SS", () => {
    expect(parseEtimeSeconds("01:02:03")).toBe(3600 + 120 + 3);
  });
  it("parses DD-HH:MM:SS", () => {
    expect(parseEtimeSeconds("2-01:00:00")).toBe(2 * 86400 + 3600);
  });
  it("returns 0 for garbage", () => {
    expect(parseEtimeSeconds("nope")).toBe(0);
  });
});

describe("parseWorkspaceHash", () => {
  it("pulls hash from --cancellationPipeName", () => {
    const args =
      "node tsserver.js --cancellationPipeName /var/folders/5j/tmp/tscancellation-abc123.sock*";
    expect(parseWorkspaceHash(args)).toBe("abc123");
  });

  it("returns null when missing", () => {
    expect(parseWorkspaceHash("node tsserver.js --foo")).toBeNull();
  });
});

describe("parsePidCommMap", () => {
  it("parses pid,comm pairs", () => {
    const out = `  PID COMM\n  100 Code Helper (Plugin)\n  200 node\n  300 bash\n`;
    const map = parsePidCommMap(out);
    expect(map.get(100)).toBe("Code Helper (Plugin)");
    expect(map.get(200)).toBe("node");
  });
});

describe("filterByParentComm", () => {
  const baseProc = (ppid: number): TsServerProcess => ({
    pid: 1,
    ppid,
    rssKb: 1024,
    etimeSeconds: 100,
    args: "tsserver.js",
    kind: "tsserver",
    mode: "full",
    workspaceHash: null,
  });

  it("keeps tsservers under Code Helper (Plugin)", () => {
    const procs = [baseProc(10)];
    const map = new Map([[10, "Code Helper (Plugin)"]]);
    expect(filterByParentComm(procs, map)).toHaveLength(1);
  });

  it("keeps tsservers under Cursor Helper (Plugin)", () => {
    const procs = [baseProc(10)];
    const map = new Map([[10, "Cursor Helper (Plugin)"]]);
    expect(filterByParentComm(procs, map)).toHaveLength(1);
  });

  it("drops tsservers whose parent is plain node (like tsc --watch)", () => {
    const procs = [baseProc(10)];
    const map = new Map([[10, "node"]]);
    expect(filterByParentComm(procs, map)).toHaveLength(0);
  });

  it("keeps when parent is unknown (permissive)", () => {
    const procs = [baseProc(999)];
    const map = new Map<number, string>();
    expect(filterByParentComm(procs, map)).toHaveLength(1);
  });
});

describe("classifyMode", () => {
  it("returns partialSemantic for partial-semantic flag", () => {
    expect(classifyMode("node tsserver.js --serverMode partialSemantic")).toBe(
      "partialSemantic",
    );
  });
  it("returns full otherwise", () => {
    expect(classifyMode("node tsserver.js --locale en")).toBe("full");
  });
});

describe("KillDecisionEngine", () => {
  const defaults = {
    fullMb: 2500,
    partialMb: 800,
    eslintMb: 1500,
    minEtimeSeconds: 300,
  };

  function baseProc(overrides: Partial<TsServerProcess> = {}): TsServerProcess {
    return {
      pid: 100,
      ppid: 1,
      rssKb: 3000 * 1024, // 3000 MB
      etimeSeconds: 600,
      args: "node tsserver.js --cancellationPipeName /tmp/tscancellation-abc.sock --locale en",
      mode: "full",
      kind: "tsserver",
      workspaceHash: "abc",
      ...overrides,
    };
  }

  it("uses the eslint threshold for kind=eslint", () => {
    const engine = new KillDecisionEngine({
      ...defaults,
      clock: () => 1_000_000,
      recentWorkspaceModifiedAt: () => 0,
    });
    // 1600 MB is under the full/partial thresholds but over eslintMb
    engine.shouldKill(
      baseProc({
        kind: "eslint",
        rssKb: 1600 * 1024,
        workspaceHash: "eslint:99",
      }),
    );
    const d = engine.shouldKill(
      baseProc({
        kind: "eslint",
        rssKb: 1700 * 1024,
        workspaceHash: "eslint:99",
      }),
    );
    expect(d.kill).toBe(true);
  });

  it("does not kill an eslint process below the eslint threshold", () => {
    const engine = new KillDecisionEngine({
      ...defaults,
      clock: () => 1_000_000,
      recentWorkspaceModifiedAt: () => 0,
    });
    engine.shouldKill(
      baseProc({
        kind: "eslint",
        rssKb: 1400 * 1024,
        workspaceHash: "eslint:99",
      }),
    );
    const d = engine.shouldKill(
      baseProc({
        kind: "eslint",
        rssKb: 1450 * 1024,
        workspaceHash: "eslint:99",
      }),
    );
    expect(d.kill).toBe(false);
    expect(d.reason).toMatch(/threshold/i);
  });

  let engine: KillDecisionEngine;
  let now = 0;
  beforeEach(() => {
    now = 1_000_000;
    engine = new KillDecisionEngine({
      ...defaults,
      clock: () => now,
      recentWorkspaceModifiedAt: () => 0, // no recent activity
    });
  });

  it("does not kill on first sight (growth not confirmed)", () => {
    const proc = baseProc();
    const decision = engine.shouldKill(proc);
    expect(decision.kill).toBe(false);
    expect(decision.reason).toMatch(/first/i);
  });

  it("kills after growth confirmed across two ticks", () => {
    const proc = baseProc();
    engine.shouldKill(proc);
    const decision = engine.shouldKill(baseProc({ rssKb: 3100 * 1024 }));
    expect(decision.kill).toBe(true);
  });

  it("does not kill if RSS is decreasing", () => {
    const proc = baseProc({ rssKb: 3100 * 1024 });
    engine.shouldKill(proc);
    const decision = engine.shouldKill(baseProc({ rssKb: 2600 * 1024 }));
    // still over threshold (2600 > 2500) but decreasing
    expect(decision.kill).toBe(false);
    expect(decision.reason).toMatch(/draining|decreas/i);
  });

  it("does not kill if under threshold", () => {
    const proc = baseProc({ rssKb: 1000 * 1024 });
    engine.shouldKill(proc);
    const decision = engine.shouldKill(baseProc({ rssKb: 1100 * 1024 }));
    expect(decision.kill).toBe(false);
    expect(decision.reason).toMatch(/threshold/i);
  });

  it("uses partialSemantic threshold for partial tsserver", () => {
    const procA = baseProc({
      mode: "partialSemantic",
      rssKb: 900 * 1024,
    });
    engine.shouldKill(procA);
    const d = engine.shouldKill(
      baseProc({ mode: "partialSemantic", rssKb: 950 * 1024 }),
    );
    expect(d.kill).toBe(true);
  });

  it("skips if process is younger than min etime", () => {
    const proc = baseProc({ etimeSeconds: 60 });
    engine.shouldKill(proc);
    const d = engine.shouldKill(
      baseProc({ etimeSeconds: 120, rssKb: 3100 * 1024 }),
    );
    expect(d.kill).toBe(false);
    expect(d.reason).toMatch(/young|etime/i);
  });

  it("skips if workspace files recently modified", () => {
    engine = new KillDecisionEngine({
      ...defaults,
      clock: () => now,
      recentWorkspaceModifiedAt: () => now / 1000 - 10, // 10 seconds ago
    });
    engine.shouldKill(baseProc());
    const d = engine.shouldKill(baseProc({ rssKb: 3100 * 1024 }));
    expect(d.kill).toBe(false);
    expect(d.reason).toMatch(/recent|activity/i);
  });

  it("circuit breaker: stops killing same workspace after 3 kills/hour", () => {
    // Confirm then kill 3 times
    for (let i = 0; i < 3; i++) {
      engine.shouldKill(baseProc({ pid: 100 + i * 2 }));
      const d = engine.shouldKill(
        baseProc({ pid: 100 + i * 2, rssKb: 3100 * 1024 }),
      );
      expect(d.kill).toBe(true);
      engine.recordKill("abc");
    }
    // Fourth attempt
    engine.shouldKill(baseProc({ pid: 999 }));
    const d = engine.shouldKill(baseProc({ pid: 999, rssKb: 3100 * 1024 }));
    expect(d.kill).toBe(false);
    expect(d.reason).toMatch(/circuit|breaker/i);

    // After 1h elapses, resumes
    now += 3600 * 1000 + 1;
    engine.shouldKill(baseProc({ pid: 888 }));
    const d2 = engine.shouldKill(baseProc({ pid: 888, rssKb: 3100 * 1024 }));
    expect(d2.kill).toBe(true);
  });

  it("prunes tracking state for pids that disappear", () => {
    engine.shouldKill(baseProc({ pid: 111 }));
    engine.shouldKill(baseProc({ pid: 222 }));
    engine.prunePids(new Set([111]));
    // 222 was pruned, so it's now "first sight" again
    const d = engine.shouldKill(baseProc({ pid: 222, rssKb: 3100 * 1024 }));
    expect(d.kill).toBe(false);
    expect(d.reason).toMatch(/first/i);
  });
});
