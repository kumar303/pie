/**
 * On-disk cache of the most recent repository scan.
 *
 * Stored at `<cacheDir>/repos.json`. The default `cacheDir` is
 * `~/.cache/worktree-pi/v1`. The `v1` segment is intentionally
 * baked into the default so a future incompatible cache format
 * change can simply move to `v2` without breaking older clients.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertStringArray, isObject } from "./type-guards.js";

const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "worktree-pi", "v1");
const REPOS_FILE = "repos.json";

export interface CachedRepos {
  /** Absolute paths to scanned repositories. */
  repos: string[];
  /** Unix epoch milliseconds. */
  scannedAt: number;
}

export interface RepoCache {
  /** Load the cached scan; returns `null` when no cache exists. */
  load(): CachedRepos | null;
  /** Persist a new scan result. */
  save(repos: string[]): void;
  /** Drop the cache (used by tests and future "reset" flows). */
  clear(): void;
}

export function createRepoCache(
  cacheDir: string = DEFAULT_CACHE_DIR,
): RepoCache {
  const path = join(cacheDir, REPOS_FILE);

  return {
    load() {
      if (!existsSync(path)) return null;
      const raw = readFileSync(path, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      // Narrow `parsed` step by step. assertStringArray is an
      // assertion function so TypeScript proves the final
      // shape structurally — no `as string[]` cast needed.
      if (!isObject(parsed))
        throw new Error(`Malformed cache at ${path}: not an object`);
      const repos = parsed.repos;
      if (!Array.isArray(repos))
        throw new Error(`Malformed cache at ${path}: missing repos`);
      assertStringArray(repos, `${path} repos`);
      const scannedAt = parsed.scannedAt;
      if (typeof scannedAt !== "number")
        throw new Error(`Malformed cache at ${path}: missing scannedAt`);
      return { repos, scannedAt };
    },
    save(repos) {
      mkdirSync(cacheDir, { recursive: true });
      const payload: CachedRepos = { repos, scannedAt: Date.now() };
      writeFileSync(path, JSON.stringify(payload, null, 2), "utf-8");
    },
    clear() {
      if (!existsSync(path)) return;
      writeFileSync(path, JSON.stringify({ repos: [], scannedAt: 0 }), "utf-8");
    },
  };
}
