/**
 * Centralized helpers for worktree directory naming and
 * extension storage paths.
 *
 * All worktrees created by /worktree share the convention
 *
 *     <treesDir>/<rel-parent>/<leaf>_<branch>
 *
 * where:
 *   treesDir    = `<dataDir>/trees` (default `~/.local/share/worktree-pi/trees`)
 *   rel-parent  = the repository's parent directory, with the
 *                 user's HOME prefix stripped if present, or
 *                 with the leading `/` dropped otherwise.
 *   leaf        = the repository's basename
 *   branch      = the branch name
 *
 * Examples (HOME = /Users/kumar):
 *   /Users/kumar/src/github.com/kumar303/pie + some-branch
 *     →  <treesDir>/src/github.com/kumar303/pie_some-branch
 *   /Volumes/some/other/place/example + some-branch
 *     →  <treesDir>/Volumes/some/other/place/example_some-branch
 *
 * Code that creates, removes, lists, or parses worktree
 * directories MUST go through this module so the convention
 * is defined in exactly one place.
 */

import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Default location for all extension state (config + trees).
 * Tests pass an override rooted under their tmpdir.
 */
export const DEFAULT_DATA_DIR = join(
  homedir(),
  ".local",
  "share",
  "worktree-pi",
);

/** Filename used for the persisted user config inside dataDir. */
export const CONFIG_FILE = "config.json";

/** Subdirectory under dataDir where worktrees live. */
export const TREES_SUBDIR = "trees";

/**
 * Separator between repo leaf and branch in worktree dir
 * names. A single literal — change here only.
 */
export const WORKTREE_NAME_INFIX = "_";

/** Derive the trees dir from a dataDir. */
export function treesDirIn(dataDir: string): string {
  return join(dataDir, TREES_SUBDIR);
}

/** Derive the config file path from a dataDir. */
export function configFileIn(dataDir: string): string {
  return join(dataDir, CONFIG_FILE);
}

/**
 * Build the worktree directory basename — `<leaf><infix><branch>`.
 * Useful when constructing relative paths to display in the UI.
 */
export function worktreeDirName(leaf: string, branch: string): string {
  return `${leaf}${WORKTREE_NAME_INFIX}${branch}`;
}

export interface PathContext {
  /** Absolute path to the trees root (e.g. `~/.local/share/worktree-pi/trees`). */
  treesDir: string;
  /** Absolute path to the user's home directory. */
  homeDir: string;
}

/**
 * Compute the path of the repo relative to either HOME or the
 * filesystem root, normalized so it can be appended to
 * treesDir without escaping it.
 *
 * - If `repoPath` is exactly HOME or starts with HOME + `/`,
 *   the HOME prefix is stripped (HOME alone collapses to "").
 * - Otherwise the leading `/` is dropped.
 *
 * The HOME match is anchored on a trailing separator so a
 * partial username collision (e.g. `/Users/kumarbug` vs
 * `/Users/kumar`) doesn't accidentally match.
 */
function repoRelativeFromRoot(repoPath: string, homeDir: string): string {
  const homeWithSep = homeDir.endsWith("/") ? homeDir : `${homeDir}/`;
  if (repoPath === homeDir) return "";
  if (repoPath.startsWith(homeWithSep)) {
    return repoPath.slice(homeWithSep.length);
  }
  // Outside HOME: drop the leading separator so we can append
  // the rest under treesDir without it acting as an absolute
  // path that would override the join.
  return repoPath.startsWith("/") ? repoPath.slice(1) : repoPath;
}

/**
 * Build the absolute on-disk worktree path for a (repo,
 * branch) pair. See module header for the naming convention.
 */
export function worktreeAbsolutePath(
  repoPath: string,
  branch: string,
  ctx: PathContext,
): string {
  const rel = repoRelativeFromRoot(repoPath, ctx.homeDir);
  const parentRel = dirname(rel);
  const leaf = basename(rel) || basename(repoPath);
  const dirName = worktreeDirName(leaf, branch);
  // dirname("") and dirname(<single-segment>) both return ".",
  // which would inject a literal "." into the path. Skip the
  // join in that degenerate case.
  if (parentRel === "" || parentRel === ".") {
    return join(ctx.treesDir, dirName);
  }
  return join(ctx.treesDir, parentRel, dirName);
}

/**
 * Directory that contains every worktree this extension would
 * create for the given repo. Used to enumerate sibling
 * worktrees (e.g. for the `/worktree remove` branch
 * autocompletion).
 */
export function worktreeParentDir(repoPath: string, ctx: PathContext): string {
  const rel = repoRelativeFromRoot(repoPath, ctx.homeDir);
  const parentRel = dirname(rel);
  if (parentRel === "" || parentRel === ".") {
    return ctx.treesDir;
  }
  return join(ctx.treesDir, parentRel);
}

/**
 * Inverse of `worktreeDirName`: given a directory entry name
 * and the known repo leaf, return the branch portion.
 *
 * The leaf is taken as input rather than parsed because both
 * leaf and branch can legitimately contain underscores —
 * splitting on the first `_` would be ambiguous. Callers
 * always know which repo's worktrees they're enumerating, so
 * passing the leaf in is natural.
 *
 * Returns `null` if `name` is not `<leaf><infix><non-empty>`.
 */
export function parseBranchFromWorktreeDirName(
  name: string,
  leaf: string,
): string | null {
  const prefix = `${leaf}${WORKTREE_NAME_INFIX}`;
  if (!name.startsWith(prefix)) return null;
  const branch = name.slice(prefix.length);
  if (branch.length === 0) return null;
  return branch;
}
