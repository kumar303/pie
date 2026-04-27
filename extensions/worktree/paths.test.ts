/**
 * Edge-case unit tests for the centralized worktree path helpers.
 *
 * These are last-resort unit tests (per AGENTS.md): pure path
 * transforms that no integration test can observe more
 * directly than the helpers themselves.
 *
 * The constants `WORKTREE_NAME_INFIX`, `DEFAULT_DATA_DIR`, etc.
 * are intentionally NOT tested directly — that would just
 * duplicate the literals. They're exercised indirectly by
 * the behavior tests below.
 */

import { describe, it, expect } from "vitest";
import {
  worktreeDirName,
  worktreeAbsolutePath,
  worktreeParentDir,
  parseBranchFromWorktreeDirName,
  treesDirIn,
  configFileIn,
} from "./paths.js";

describe("worktreeDirName", () => {
  it("joins repo leaf and branch with an underscore", () => {
    expect(worktreeDirName("pie", "feat")).toBe("pie_feat");
  });

  it("preserves dashes in either side", () => {
    expect(worktreeDirName("my-repo", "some-branch")).toBe(
      "my-repo_some-branch",
    );
  });
});

describe("worktreeAbsolutePath", () => {
  const home = "/Users/kumar";
  const trees = "/Users/kumar/.local/share/worktree-pi/trees";

  it("strips the home dir for repos under HOME", () => {
    // /Users/kumar/src/github.com/kumar303/pie + branch some-branch
    //   →  trees/src/github.com/kumar303/pie_some-branch
    expect(
      worktreeAbsolutePath(
        "/Users/kumar/src/github.com/kumar303/pie",
        "some-branch",
        { treesDir: trees, homeDir: home },
      ),
    ).toBe(`${trees}/src/github.com/kumar303/pie_some-branch`);
  });

  it("preserves absolute structure for repos outside HOME", () => {
    // /Volumes/some/other/place/example + branch some-branch
    //   →  trees/Volumes/some/other/place/example_some-branch
    expect(
      worktreeAbsolutePath("/Volumes/some/other/place/example", "some-branch", {
        treesDir: trees,
        homeDir: home,
      }),
    ).toBe(`${trees}/Volumes/some/other/place/example_some-branch`);
  });

  it("does not strip a HOME-like prefix that isn't followed by a separator", () => {
    // /Users/kumarbug/repo must NOT match /Users/kumar — the
    // strip is only valid when followed by a path separator.
    expect(
      worktreeAbsolutePath("/Users/kumarbug/repo", "feat", {
        treesDir: trees,
        homeDir: home,
      }),
    ).toBe(`${trees}/Users/kumarbug/repo_feat`);
  });
});

describe("worktreeParentDir", () => {
  const home = "/Users/kumar";
  const trees = "/Users/kumar/.local/share/worktree-pi/trees";

  it("returns the worktree's parent directory (used to enumerate sibling worktrees)", () => {
    expect(
      worktreeParentDir("/Users/kumar/src/github.com/kumar303/pie", {
        treesDir: trees,
        homeDir: home,
      }),
    ).toBe(`${trees}/src/github.com/kumar303`);
  });

  it("works for paths outside HOME", () => {
    expect(
      worktreeParentDir("/Volumes/some/other/place/example", {
        treesDir: trees,
        homeDir: home,
      }),
    ).toBe(`${trees}/Volumes/some/other/place`);
  });
});

describe("parseBranchFromWorktreeDirName", () => {
  // Splitting `<leaf>_<branch>` on the first '_' is ambiguous
  // when leaves themselves contain underscores. Callers
  // always know the leaf (they're enumerating worktrees for a
  // specific repo), so we take it as input and treat the
  // remainder as the branch.
  it("extracts the branch given the known repo leaf", () => {
    expect(parseBranchFromWorktreeDirName("pie_some-branch", "pie")).toBe(
      "some-branch",
    );
  });

  it("preserves underscores inside the branch", () => {
    expect(parseBranchFromWorktreeDirName("pie_feat_v2", "pie")).toBe(
      "feat_v2",
    );
  });

  it("preserves underscores inside the leaf", () => {
    expect(parseBranchFromWorktreeDirName("my_repo_feat", "my_repo")).toBe(
      "feat",
    );
  });

  it("returns null when the directory does not match the leaf prefix", () => {
    expect(parseBranchFromWorktreeDirName("other_feat", "pie")).toBeNull();
  });

  it("returns null when the directory is exactly the leaf with no branch", () => {
    expect(parseBranchFromWorktreeDirName("pie_", "pie")).toBeNull();
    expect(parseBranchFromWorktreeDirName("pie", "pie")).toBeNull();
  });
});

describe("treesDirIn / configFileIn", () => {
  it("derives the trees dir from a data dir", () => {
    expect(treesDirIn("/x/data")).toBe("/x/data/trees");
  });

  it("derives the config file path from a data dir", () => {
    expect(configFileIn("/x/data")).toBe("/x/data/config.json");
  });
});
