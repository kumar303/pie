/**
 * Thin wrapper around `git worktree` plumbing.
 *
 * Centralized so the rest of the extension never has to think
 * about argv quoting or stderr capture.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import {
  parseBranchFromWorktreeDirName,
  worktreeAbsolutePath,
  worktreeParentDir,
  type PathContext,
} from "./paths.js";

export interface GitResult {
  ok: boolean;
  /** Combined stdout + stderr (in stream order isn't preserved; both are concatenated). */
  output: string;
  /** Exit code (or `null` if the process didn't exit normally). */
  code: number | null;
}

function run(args: string[], cwd: string): GitResult {
  const r = spawnSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if (r.error) {
    return {
      ok: false,
      output: `git ${args.join(" ")}: ${r.error.message}`,
      code: null,
    };
  }
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { ok: r.status === 0, output: out, code: r.status };
}

/**
 * Whether the local git repository already has a branch with
 * the given name (any kind: heads/, remotes/, tags/ would
 * return no match here — we only check local heads).
 */
export function localBranchExists(repoPath: string, branch: string): boolean {
  const r = run(
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    repoPath,
  );
  // exit 0 → ref exists, exit 1 → does not exist, anything else
  // is unexpected and we surface it via the caller's pre-flight
  // check by returning false here (the worktree-add command
  // will then attempt and report the real error).
  return r.code === 0;
}

/**
 * Common shape for `git worktree {add|remove}` operations
 * targetting the canonical `<treesDir>/<rel>/<leaf>_<branch>`
 * directory.
 */
export interface WorktreeOp {
  repoPath: string;
  branch: string;
  /** Path context (treesDir + homeDir) — supplied by the caller. */
  paths: PathContext;
}

export interface WorktreeOpResult {
  /** Absolute path to the worktree (whether or not the op succeeded). */
  worktreePath: string;
  /** Result from running git. */
  git: GitResult;
}

// Back-compat aliases for callers that prefer the named shape.
export type CreateWorktreeOptions = WorktreeOp;
export type CreateWorktreeResult = WorktreeOpResult;
export type RemoveWorktreeOptions = WorktreeOp;
export type RemoveWorktreeResult = WorktreeOpResult;

/**
 * Resolve the canonical absolute path for a worktree and run
 * an arbitrary `git worktree ...` command against it. Used
 * by both `createWorktree` and `removeWorktree` so the path-
 * derivation lives in one place.
 *
 * The path is passed to git as an absolute path (rather than
 * a relative one) because the worktree location is no longer
 * a sibling of the repository — it lives under a separate
 * data directory entirely.
 */
function runWorktreeOp(
  opts: WorktreeOp,
  buildArgs: (absPath: string, branch: string) => string[],
): WorktreeOpResult {
  const { repoPath, branch, paths } = opts;
  const absPath = worktreeAbsolutePath(repoPath, branch, paths);
  const git = run(buildArgs(absPath, branch), repoPath);
  return { worktreePath: absPath, git };
}

/**
 * Run `git worktree add <absPath> -b <branch>` inside the
 * given repository.
 *
 * Pre-flight checks (branch exists, target dir exists) are
 * the caller's responsibility — they live closer to the UI
 * surface so error messages can be tailored. This function
 * only runs the command and reports whatever git says.
 */
export function createWorktree(opts: WorktreeOp): WorktreeOpResult {
  return runWorktreeOp(opts, (absPath, branch) => [
    "worktree",
    "add",
    absPath,
    "-b",
    branch,
  ]);
}

/**
 * Run `git worktree remove <absPath>` inside the given
 * repository.
 */
export function removeWorktree(opts: WorktreeOp): WorktreeOpResult {
  return runWorktreeOp(opts, (absPath) => ["worktree", "remove", absPath]);
}

/**
 * List branches that have an existing on-disk worktree
 * directory under the canonical `<treesDir>/<rel>/<leaf>_<branch>`
 * convention for the given repository.
 *
 * Reads the filesystem rather than `git worktree list` so the
 * results are guaranteed to use the canonical naming pattern
 * — worktrees created outside this extension are intentionally
 * ignored.
 */
export function listExistingWorktreeBranches(
  repoPath: string,
  paths: PathContext,
): string[] {
  const leaf = basename(repoPath);
  const parent = worktreeParentDir(repoPath, paths);
  if (!existsSync(parent)) return [];
  let entries: string[];
  try {
    entries = readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    throw new Error(
      `Failed to read worktree parent directory ${parent}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  const branches: string[] = [];
  for (const name of entries) {
    const branch = parseBranchFromWorktreeDirName(name, leaf);
    if (branch !== null) branches.push(branch);
  }
  return branches.sort();
}
