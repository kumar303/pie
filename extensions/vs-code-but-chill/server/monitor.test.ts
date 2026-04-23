import { describe, it, expect, beforeEach } from "vitest";
import {
  parsePgrepOutput,
  parseWorkspaceHash,
  parseEslintWorkspaceHash,
  parseCancellationDir,
  classifyKind,
  IdleDecisionEngine,
  type MonitoredProcess,
} from "./monitor.ts";

describe("parsePgrepOutput", () => {
  it("parses a tsserver row", () => {
    const out =
      "12345 /usr/local/bin/node /path/tsserver.js --cancellationPipeName /tmp/wsdir/tscancellation-abc.sock";
    const rows = parsePgrepOutput(out);
    expect(rows).toEqual([
      {
        pid: 12345,
        args: expect.stringContaining("tsserver.js"),
        kind: "tsserver",
        workspaceHash: "abc",
        activityPath: "/tmp/wsdir",
      },
    ]);
  });

  it("leaves activityPath null for eslintServer rows", () => {
    const out =
      "54321 node /ext/eslintServer.js --node-ipc --clientProcessId=11111";
    expect(parsePgrepOutput(out)[0].activityPath).toBeNull();
  });

  it("parses an eslintServer row with clientProcessId=", () => {
    const out =
      "54321 node /ext/eslintServer.js --node-ipc --clientProcessId=11111";
    const rows = parsePgrepOutput(out);
    expect(rows).toEqual([
      {
        pid: 54321,
        args: expect.stringContaining("eslintServer.js"),
        kind: "eslint",
        workspaceHash: "eslint:11111",
        activityPath: null,
      },
    ]);
  });

  it("accepts `--clientProcessId 22222` (space form)", () => {
    const out = "54321 node /ext/eslintServer.js --clientProcessId 22222";
    expect(parsePgrepOutput(out)[0].workspaceHash).toBe("eslint:22222");
  });

  it("filters out typingsInstaller.js rows", () => {
    const out = [
      "11111 node /path/typingsInstaller.js",
      "22222 node /path/tsserver.js",
    ].join("\n");
    const rows = parsePgrepOutput(out);
    expect(rows).toHaveLength(1);
    expect(rows[0].pid).toBe(22222);
  });

  it("skips lines that don't match any monitored kind", () => {
    const out = [
      "10 node /some/other/thing.js",
      "20 /bin/bash -lc echo hi",
    ].join("\n");
    expect(parsePgrepOutput(out)).toEqual([]);
  });

  it("returns empty for blank input", () => {
    expect(parsePgrepOutput("")).toEqual([]);
    expect(parsePgrepOutput("\n")).toEqual([]);
  });
});

describe("classifyKind", () => {
  it("tags tsserver", () => {
    expect(classifyKind("node /path/tsserver.js")).toBe("tsserver");
  });
  it("tags eslint", () => {
    expect(classifyKind("node /path/eslintServer.js --node-ipc")).toBe(
      "eslint",
    );
  });
  it("returns null otherwise", () => {
    expect(classifyKind("node /path/rg")).toBeNull();
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

describe("parseCancellationDir", () => {
  it("returns the parent directory of --cancellationPipeName", () => {
    const args =
      "node tsserver.js --cancellationPipeName /var/folders/5j/T/vscode-typescript501/abc123/tscancellation-xyz.tmp";
    expect(parseCancellationDir(args)).toBe(
      "/var/folders/5j/T/vscode-typescript501/abc123",
    );
  });

  it("strips VS Code's trailing `*` glob marker", () => {
    const args =
      "node tsserver.js --cancellationPipeName /tmp/vscode-typescript501/abc/tscancellation-xyz.tmp*";
    expect(parseCancellationDir(args)).toBe("/tmp/vscode-typescript501/abc");
  });

  it("accepts the `--cancellationPipeName=<path>` equals form", () => {
    const args =
      "node tsserver.js --cancellationPipeName=/tmp/vscode-typescript501/abc/tscancellation-xyz.tmp";
    expect(parseCancellationDir(args)).toBe("/tmp/vscode-typescript501/abc");
  });

  it("returns null when --cancellationPipeName is missing", () => {
    expect(parseCancellationDir("node tsserver.js --locale en")).toBeNull();
  });

  it("returns null when the pipe path isn't absolute", () => {
    expect(
      parseCancellationDir("node tsserver.js --cancellationPipeName tsc.tmp"),
    ).toBeNull();
  });
});

describe("parseEslintWorkspaceHash", () => {
  it("returns null when clientProcessId is missing", () => {
    expect(parseEslintWorkspaceHash("node eslintServer.js --stdio")).toBeNull();
  });
  it("parses `--clientProcessId=11111`", () => {
    expect(
      parseEslintWorkspaceHash(
        "node eslintServer.js --node-ipc --clientProcessId=11111",
      ),
    ).toBe("eslint:11111");
  });
});

describe("IdleDecisionEngine", () => {
  const MIN_AGE_MS = 5 * 60 * 1000; // 5 min
  const IDLE_MS = 60 * 60 * 1000; // 60 min

  function baseProc(
    overrides: Partial<MonitoredProcess> = {},
  ): MonitoredProcess {
    return {
      pid: 100,
      args: "node /path/tsserver.js --cancellationPipeName /tmp/tscancellation-abc.sock",
      kind: "tsserver",
      workspaceHash: "abc",
      activityPath: null,
      ...overrides,
    };
  }

  let engine: IdleDecisionEngine;
  let now = 0;
  beforeEach(() => {
    now = 1_000_000_000; // any ms-since-epoch
    engine = new IdleDecisionEngine({
      minAgeMs: MIN_AGE_MS,
      idleMs: IDLE_MS,
      clock: () => now,
    });
  });

  it("does not kill on first sight — process is too young", () => {
    // Idle far past the threshold, but process just appeared.
    const d = engine.shouldKill(baseProc(), now - 10 * IDLE_MS);
    expect(d.kill).toBe(false);
    expect(d.reason).toMatch(/young|age/i);
  });

  it("kills once min age has elapsed and workspace is idle", () => {
    engine.shouldKill(baseProc(), now - 10 * IDLE_MS); // first sighting
    now += MIN_AGE_MS + 1;
    const d = engine.shouldKill(baseProc(), now - 10 * IDLE_MS);
    expect(d.kill).toBe(true);
    expect(d.reason).toMatch(/idle/i);
  });

  it("does not kill when workspace is active (recent edit)", () => {
    engine.shouldKill(baseProc(), 0); // first sighting
    now += MIN_AGE_MS + 1;
    const d = engine.shouldKill(baseProc(), now - 1000); // edit 1s ago
    expect(d.kill).toBe(false);
    expect(d.reason).toMatch(/active|edit/i);
  });

  it("does not kill when workspace is unknown", () => {
    engine.shouldKill(baseProc(), 0);
    now += MIN_AGE_MS + 1;
    const d = engine.shouldKill(baseProc(), 0);
    expect(d.kill).toBe(false);
    expect(d.reason).toMatch(/unknown|workspace/i);
  });

  it("circuit breaker: stops after 3 kills/hour for the same workspace", () => {
    // Prime 3 kills
    for (let i = 0; i < 3; i++) {
      engine.shouldKill(baseProc({ pid: 100 + i }), 0);
      now += MIN_AGE_MS + 1;
      const d = engine.shouldKill(
        baseProc({ pid: 100 + i }),
        now - 10 * IDLE_MS,
      );
      expect(d.kill).toBe(true);
      engine.recordKill("abc");
    }

    // Fourth attempt — blocked
    engine.shouldKill(baseProc({ pid: 999 }), 0);
    now += MIN_AGE_MS + 1;
    const blocked = engine.shouldKill(
      baseProc({ pid: 999 }),
      now - 10 * IDLE_MS,
    );
    expect(blocked.kill).toBe(false);
    expect(blocked.reason).toMatch(/circuit|breaker/i);

    // After 1h, breaker resets
    now += 3600 * 1000 + 1;
    engine.shouldKill(baseProc({ pid: 1000 }), 0);
    now += MIN_AGE_MS + 1;
    const after = engine.shouldKill(
      baseProc({ pid: 1000 }),
      now - 10 * IDLE_MS,
    );
    expect(after.kill).toBe(true);
  });

  it("prunes tracking state for pids that disappear", () => {
    engine.shouldKill(baseProc({ pid: 111 }), 0);
    engine.shouldKill(baseProc({ pid: 222 }), 0);
    now += MIN_AGE_MS + 1;
    engine.prunePids(new Set([111]));
    // 222 was pruned, so its firstSeenAt resets — too young again.
    const d = engine.shouldKill(baseProc({ pid: 222 }), now - 10 * IDLE_MS);
    expect(d.kill).toBe(false);
    expect(d.reason).toMatch(/young|age/i);
  });
});
