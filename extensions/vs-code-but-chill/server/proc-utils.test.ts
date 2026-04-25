import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deepestCommonAncestor,
  parseLsofFnPaths,
  parseLsofParentPid,
  workspaceMtimeAt,
  parseServerPgrepLine,
  findOtherServers,
  sweepOrphanServers,
  SERVER_PGREP_PATTERN,
} from "./proc-utils.ts";

describe("deepestCommonAncestor", () => {
  it("returns the common directory prefix", () => {
    const r = deepestCommonAncestor([
      "/Users/me/project/src/a.ts",
      "/Users/me/project/src/b.ts",
      "/Users/me/project/package.json",
    ]);
    expect(r).toBe("/Users/me/project");
  });

  it("returns null for empty", () => {
    expect(deepestCommonAncestor([])).toBeNull();
  });
});

describe("parseLsofFnPaths", () => {
  it("pulls out n-prefixed paths, skipping other record types", () => {
    const stdout = [
      "p12345",
      "ftxt",
      "n/Users/me/proj/src/a.ts",
      "ftxt",
      "n/Users/me/proj/src/b.ts",
      "fcwd",
      "n/Users/me/proj",
      "",
    ].join("\n");
    expect(parseLsofFnPaths(stdout)).toEqual([
      "/Users/me/proj/src/a.ts",
      "/Users/me/proj/src/b.ts",
      "/Users/me/proj",
    ]);
  });

  it("returns empty for empty input", () => {
    expect(parseLsofFnPaths("")).toEqual([]);
  });

  it("ignores an n-prefix with no path after it", () => {
    expect(parseLsofFnPaths("n\n")).toEqual([]);
  });
});

describe("parseLsofParentPid", () => {
  it("extracts the PPID from an R-prefixed record", () => {
    const stdout = ["p12345", "R9999", "ftxt", "n/some/file"].join("\n");
    expect(parseLsofParentPid(stdout)).toBe(9999);
  });

  it("returns null when no R record is present", () => {
    expect(parseLsofParentPid("p12345\nftxt\n")).toBeNull();
  });

  it("returns null for non-numeric R value", () => {
    expect(parseLsofParentPid("Rabc")).toBeNull();
  });
});

describe("workspaceMtimeAt", () => {
  it("returns 0 for undefined root", () => {
    expect(workspaceMtimeAt(undefined)).toBe(0);
  });

  it("returns 0 for non-existent path", () => {
    expect(workspaceMtimeAt("/no/such/dir/abc123")).toBe(0);
  });

  it("returns a recent ms timestamp for a just-touched dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "vscbc-activity-"));
    writeFileSync(join(dir, "x.ts"), "// hi");
    const t = workspaceMtimeAt(dir);
    const now = Date.now();
    expect(t).toBeGreaterThan(now - 5000);
    expect(t).toBeLessThanOrEqual(now + 1000);
  });
});

describe("orphan-sweep entry-path drift guard", () => {
  // Catch the case where someone renames the extension directory or
  // `server/main.ts` itself: the sweep's regex + endsWith are string
  // literals coupled to the path layout, and a rename would silently
  // make the sweep a no-op (it'd find zero processes forever, so
  // orphans pile up exactly like they did before the fix).
  //
  // We resolve `main.ts` the same way `index.ts` does — from the
  // file URL of a sibling test file — and assert that the
  // production sweep can recognise a synthetic pgrep line built
  // from that real path.
  const serverMain = fileURLToPath(new URL("./main.ts", import.meta.url));

  it("resolves to an actual file (catches rename of main.ts)", () => {
    expect(statSync(serverMain).isFile()).toBe(true);
  });

  it("SERVER_PGREP_PATTERN still matches the real entry path", () => {
    const fakeLine = `12345 /usr/bin/node /jiti.mjs ${serverMain} /tmp/dataDir`;
    expect(new RegExp(SERVER_PGREP_PATTERN).test(fakeLine)).toBe(true);
  });

  it("parseServerPgrepLine still parses the real entry path", () => {
    const fakeLine = `12345 /usr/bin/node /jiti.mjs ${serverMain} /tmp/dataDir`;
    expect(parseServerPgrepLine(fakeLine)).toEqual({
      pid: 12345,
      dataDir: "/tmp/dataDir",
    });
  });
});

describe("parseServerPgrepLine", () => {
  it("extracts pid and dataDir from a typical pgrep -afl line", () => {
    const line =
      "12765 /nix/store/abc/bin/node /repo/node_modules/.pnpm/jiti/lib/jiti-cli.mjs " +
      "/Users/kumar/src/pie/extensions/vs-code-but-chill/server/main.ts " +
      "/Users/kumar/.cache/vs-code-but-chill_pi";
    expect(parseServerPgrepLine(line)).toEqual({
      pid: 12765,
      dataDir: "/Users/kumar/.cache/vs-code-but-chill_pi",
    });
  });

  it("handles a temp-dir dataDir (the dev-mode orphan signature)", () => {
    const line =
      "85861 /usr/local/bin/node /tmp/jiti-cli.mjs " +
      "/repo/extensions/vs-code-but-chill/server/main.ts " +
      "/var/folders/5j/foo/T/vscbc-ext-VwKf7x/.cache/vs-code-but-chill_pi";
    expect(parseServerPgrepLine(line)).toEqual({
      pid: 85861,
      dataDir:
        "/var/folders/5j/foo/T/vscbc-ext-VwKf7x/.cache/vs-code-but-chill_pi",
    });
  });

  it("returns null when the line doesn't reference the server entry", () => {
    expect(
      parseServerPgrepLine("99 /usr/bin/node /some/other/script.js /tmp"),
    ).toBeNull();
  });

  it("returns null for an empty line", () => {
    expect(parseServerPgrepLine("")).toBeNull();
  });

  it("returns null when the pid prefix is missing or malformed", () => {
    expect(
      parseServerPgrepLine(
        "abc /node /vs-code-but-chill/server/main.ts /tmp/data",
      ),
    ).toBeNull();
  });

  it("returns null when no dataDir argument follows main.ts", () => {
    expect(
      parseServerPgrepLine(
        "1 /node /repo/extensions/vs-code-but-chill/server/main.ts",
      ),
    ).toBeNull();
  });
});

describe("findOtherServers", () => {
  it("uses the right pgrep pattern and parses every matching line", async () => {
    const exec = vi.fn(async (_file: string, args: string[]) => {
      expect(args).toEqual(["-afl", SERVER_PGREP_PATTERN]);
      return {
        stdout: [
          "111 /node /jiti/cli.mjs /a/extensions/vs-code-but-chill/server/main.ts /home/.cache/vs-code-but-chill_pi",
          "222 /node /jiti/cli.mjs /b/extensions/vs-code-but-chill/server/main.ts /tmp/x/.cache/vs-code-but-chill_pi",
          "",
        ].join("\n"),
      };
    });
    const result = await findOtherServers({ exec });
    expect(result).toEqual([
      { pid: 111, dataDir: "/home/.cache/vs-code-but-chill_pi" },
      { pid: 222, dataDir: "/tmp/x/.cache/vs-code-but-chill_pi" },
    ]);
  });

  it("returns an empty array when pgrep finds no matches (exit 1)", async () => {
    const err = Object.assign(new Error("no match"), { code: 1 });
    const exec = vi.fn(async () => {
      throw err;
    });
    expect(await findOtherServers({ exec })).toEqual([]);
  });

  it("excludes selfPid from the result", async () => {
    const exec = vi.fn(async () => ({
      stdout: [
        "111 /node /jiti.mjs /repo/extensions/vs-code-but-chill/server/main.ts /home/.cache/vs-code-but-chill_pi",
        "222 /node /jiti.mjs /repo/extensions/vs-code-but-chill/server/main.ts /tmp/x/.cache/vs-code-but-chill_pi",
      ].join("\n"),
    }));
    const result = await findOtherServers({ exec, selfPid: 111 });
    expect(result).toEqual([
      { pid: 222, dataDir: "/tmp/x/.cache/vs-code-but-chill_pi" },
    ]);
  });

  it("skips lines that don't parse instead of throwing", async () => {
    const exec = vi.fn(async () => ({
      stdout: [
        "garbage line with no pid",
        "111 /node /jiti.mjs /repo/extensions/vs-code-but-chill/server/main.ts /home/.cache/vs-code-but-chill_pi",
        "abc /not /a /pid",
      ].join("\n"),
    }));
    expect(await findOtherServers({ exec })).toEqual([
      { pid: 111, dataDir: "/home/.cache/vs-code-but-chill_pi" },
    ]);
  });

  it("rethrows non-exit-1 errors so callers can surface real failures", async () => {
    const err = Object.assign(new Error("no such file"), { code: "ENOENT" });
    const exec = vi.fn(async () => {
      throw err;
    });
    await expect(findOtherServers({ exec })).rejects.toThrow("no such file");
  });
});

describe("sweepOrphanServers", () => {
  /** A LogWriter-shaped sink that captures messages for assertions. */
  function makeLog() {
    const lines: string[] = [];
    return {
      lines,
      write: (s: string) => {
        lines.push(s);
      },
    };
  }

  function execWith(stdout: string) {
    return vi.fn(async () => ({ stdout }));
  }

  const KEEP = "/keep/.cache/vs-code-but-chill_pi";
  const ORPHAN_A = "/orphan-a/.cache/vs-code-but-chill_pi";
  const ORPHAN_B = "/orphan-b/.cache/vs-code-but-chill_pi";
  const ENTRY = "/repo/extensions/vs-code-but-chill/server/main.ts";

  it("kills servers in other dataDirs and logs the action", async () => {
    const log = makeLog();
    const exec = execWith(
      [
        `111 /node /jiti ${ENTRY} ${KEEP}`,
        `222 /node /jiti ${ENTRY} ${ORPHAN_A}`,
        `333 /node /jiti ${ENTRY} ${ORPHAN_B}`,
      ].join("\n"),
    );
    const kills: number[] = [];
    const kill = vi.fn(async (pid: number) => {
      kills.push(pid);
      return true;
    });

    await sweepOrphanServers({ dataDir: KEEP, log, exec, kill });

    expect(kills.sort()).toEqual([222, 333]);
    expect(log.lines.join("\n")).toMatch(/swept orphan.*222.*333/);
  });

  it("logs a different line for failed kills", async () => {
    const log = makeLog();
    const exec = execWith(`444 /node /jiti ${ENTRY} ${ORPHAN_A}`);
    const kill = vi.fn(async () => false);

    await sweepOrphanServers({ dataDir: KEEP, log, exec, kill });

    expect(log.lines.join("\n")).toMatch(/could not kill.*444/);
  });

  it("does nothing visible when there are no orphans", async () => {
    // A clean host shouldn't litter the log on every startup.
    const log = makeLog();
    const err = Object.assign(new Error("no match"), { code: 1 });
    const exec = vi.fn(async () => {
      throw err;
    });
    const kill = vi.fn(async () => true);

    await sweepOrphanServers({ dataDir: KEEP, log, exec, kill });

    expect(log.lines).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("never throws when pgrep fails — logs and continues", async () => {
    // pgrep can be missing or sandbox-blocked. Startup must not abort.
    const log = makeLog();
    const exec = vi.fn(async () => {
      throw Object.assign(new Error("pgrep ENOENT"), { code: "ENOENT" });
    });

    await expect(
      sweepOrphanServers({ dataDir: KEEP, log, exec }),
    ).resolves.toBeUndefined();
    expect(log.lines.join("\n")).toMatch(/orphan sweep failed.*pgrep ENOENT/);
  });
});
