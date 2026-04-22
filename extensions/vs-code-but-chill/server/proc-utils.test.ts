import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deepestCommonAncestor,
  parseLsofFnPaths,
  recentWorkspaceActivityAt,
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

describe("recentWorkspaceActivityAt", () => {
  it("returns 0 for undefined root", () => {
    expect(recentWorkspaceActivityAt(undefined)).toBe(0);
  });

  it("returns 0 for non-existent path", () => {
    expect(recentWorkspaceActivityAt("/no/such/dir/abc123")).toBe(0);
  });

  it("returns a recent unix-seconds timestamp for a just-touched dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "vscbc-activity-"));
    // Force an mtime bump by writing a file
    writeFileSync(join(dir, "x.ts"), "// hi");
    const t = recentWorkspaceActivityAt(dir);
    const now = Math.floor(Date.now() / 1000);
    expect(t).toBeGreaterThan(now - 5);
    expect(t).toBeLessThanOrEqual(now + 1);
  });
});
