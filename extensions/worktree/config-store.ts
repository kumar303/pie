/**
 * Persisted user config for the /worktree extension.
 *
 * Stored as JSON at `<dataDir>/config.json`. The default
 * `dataDir` is `~/.local/share/worktree-pi/`. Tests construct
 * a store rooted in a tmpdir so they never touch the real
 * one.
 *
 * The on-disk shape is an object so we can grow it later
 * without another migration:
 *
 *     { "dirs": ["/path/to/scan/root", ...] }
 *
 * For now `dirs` is the only field — the directories the
 * user has configured for repository scanning.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_FILE, DEFAULT_DATA_DIR } from "./paths.js";
import { assertStringArray, isObject } from "./type-guards.js";

export interface ConfigStore {
  /** All directories the user has configured, in insertion order. */
  list(): string[];
  /** Add a directory; idempotent. Returns true when added. */
  add(dir: string): boolean;
  /** Remove a directory. Returns true when something was removed. */
  remove(dir: string): boolean;
  /** Replace the whole list. */
  replace(dirs: string[]): void;
}

/**
 * Normalize a directory path: strip trailing slashes, resolve
 * relative segments. Tilde expansion is handled at the call
 * site (see `expandHome`).
 */
export function normalizeDir(dir: string): string {
  return resolve(dir);
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(dir: string): string {
  if (dir === "~") return homedir();
  if (dir.startsWith("~/")) return join(homedir(), dir.slice(2));
  return dir;
}

interface ConfigShape {
  dirs: string[];
}

export function createConfigStore(
  dataDir: string = DEFAULT_DATA_DIR,
): ConfigStore {
  const path = join(dataDir, CONFIG_FILE);

  const read = (): ConfigShape => {
    if (!existsSync(path)) return { dirs: [] };
    const raw = readFileSync(path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) {
      throw new Error(`Malformed config at ${path}: expected an object`);
    }
    const dirs = parsed.dirs;
    if (!Array.isArray(dirs)) {
      throw new Error(`Malformed config at ${path}: 'dirs' must be an array`);
    }
    // assertStringArray narrows `dirs` to `string[]`.
    assertStringArray(dirs, `${path}#dirs`);
    return { dirs };
  };

  const write = (cfg: ConfigShape): void => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
  };

  return {
    list: () => read().dirs,
    add(dir) {
      const norm = normalizeDir(dir);
      const cfg = read();
      if (cfg.dirs.includes(norm)) return false;
      write({ ...cfg, dirs: [...cfg.dirs, norm] });
      return true;
    },
    remove(dir) {
      const norm = normalizeDir(dir);
      const cfg = read();
      const next = cfg.dirs.filter((d) => d !== norm);
      if (next.length === cfg.dirs.length) return false;
      write({ ...cfg, dirs: next });
      return true;
    },
    replace(dirs) {
      const cfg = read();
      write({ ...cfg, dirs: dirs.map(normalizeDir) });
    },
  };
}
