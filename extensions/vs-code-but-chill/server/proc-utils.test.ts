import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deepestCommonAncestor,
  parseLsofFnPaths,
  parseLsofParentPid,
  workspaceMtimeAt,
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
