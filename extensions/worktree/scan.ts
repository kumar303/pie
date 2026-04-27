/**
 * Scan configured directories for git repositories.
 *
 * A "repository" here is any direct child directory of a
 * configured path that contains a `.git` entry (file or
 * directory). The scan is non-recursive on purpose:
 * configured paths are expected to be GitHub-org-style
 * "containers" (e.g. `~/src/github.com/kumar303`).
 *
 * Results from each configured directory are merged into a
 * single deduplicated, sorted list of absolute repository
 * paths.
 *
 * Errors are surfaced via the result object instead of being
 * thrown — a single malformed directory should not abort the
 * whole scan, but the caller still needs to see what failed.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// Note: worktrees no longer live next to the repos they
// originate from — they're under a separate `<dataDir>/trees`
// hierarchy — so the scanner doesn't need any "skip worktree
// dirs" logic anymore.

export interface ScanResult {
  /** Absolute paths to discovered repositories, sorted. */
  repos: string[];
  /** Per-directory errors. Empty on success. */
  errors: Array<{ dir: string; message: string }>;
}

/**
 * Validate that a single configured directory path is usable.
 * Returns an error string on failure or `null` on success.
 *
 * Rules:
 *  - must be an absolute path (the caller is responsible for
 *    `~` expansion).
 *  - must exist and be a directory.
 *  - must contain at least one git repository among its
 *    immediate children.
 */
export function validateConfigDir(dir: string): string | null {
  if (!isAbsolute(dir))
    return "Path must be absolute (try expanding ~ to your home directory)";
  if (!existsSync(dir)) return "Path does not exist";
  const st = statSync(dir);
  if (!st.isDirectory()) return "Path is not a directory";

  const repos = listRepos(dir);
  if (repos.length === 0)
    return "Directory contains no git repositories (looked for .git in immediate children)";
  return null;
}

/** Return absolute paths to git repos that are direct children of `dir`. */
export function listRepos(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const repos: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const child = join(dir, e.name);
    if (existsSync(join(child, ".git"))) repos.push(child);
  }
  return repos.sort();
}

/**
 * Scan all configured directories and produce a deduped,
 * sorted result. Errors are collected per directory.
 */
export function scanRepos(dirs: string[]): ScanResult {
  const seen = new Set<string>();
  const errors: ScanResult["errors"] = [];
  for (const dir of dirs) {
    try {
      for (const repo of listRepos(dir)) seen.add(repo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ dir, message });
    }
  }
  return { repos: [...seen].sort(), errors };
}
