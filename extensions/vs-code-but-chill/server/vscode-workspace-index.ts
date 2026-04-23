/**
 * Resolve a tsserver's workspace folder by pivoting through VS Code's
 * on-disk logs and workspaceStorage. The workspaceStorage schema
 * (`<MD5>/workspace.json` holding `{ folder: "file://..." }`) is the
 * stable part — referenced in VS Code's source. The two log-file
 * lines we grep for are VS Code implementation details but have been
 * emitted the same way for years; every step fails closed to `null`
 * so a VS Code refactor just means workspace resolution stops
 * working, not that the extension crashes.
 *
 * No caching on purpose: ticks are ~20 minutes apart, so rescanning
 * the logs each time is free and removes a whole class of stale-state
 * bugs.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * The renderer.log for each VS Code window contains a line like
 *   `[info] Started local extension host with pid 23993.`
 * The pid on that line is the ext-host process, which is the parent
 * of the tsservers we want to map.
 */
export function parseExthostPidFromRendererLog(log: string): number | null {
  const m = log.match(/Started local extension host with pid (\d+)\./);
  return m ? Number(m[1]) : null;
}

/**
 * The exthost.log for each window references its workspaceStorage
 * directory by MD5 (32-char hex). Any line like
 *   `workspaceStorage/<32-hex>` or ending in `workspaceStorage/<32-hex>.`
 * is fine; the MD5 is stable per-workspace.
 */
export function parseWorkspaceStorageIdFromExthostLog(
  log: string,
): string | null {
  const m = log.match(/workspaceStorage\/([0-9a-f]{32})\b/);
  return m ? m[1] : null;
}

/**
 * Read the `folder` URI out of a workspaceStorage `workspace.json`
 * and convert it to a filesystem path. Returns null for anything but
 * a `file://` URI (remote/container workspaces have no local path)
 * or for malformed JSON.
 */
export function parseWorkspaceFolderPath(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const folder = (parsed as { folder?: unknown }).folder;
  if (typeof folder !== "string") return null;
  if (!folder.startsWith("file://")) return null;
  try {
    return decodeURIComponent(folder.slice("file://".length));
  } catch {
    return null;
  }
}

/**
 * Find the most recently modified `YYYYMMDDTHHMMSS` directory under
 * `logsRoot`. Sorting by name is not enough — VS Code sometimes
 * reuses an older-named session directory on restart, so mtime is
 * authoritative for "the session currently in use".
 */
export function findLatestSessionDir(logsRoot: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(logsRoot);
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const name of entries) {
    if (!/^\d{8}T\d{6}$/.test(name)) continue;
    const path = join(logsRoot, name);
    try {
      const st = statSync(path);
      if (!st.isDirectory()) continue;
      if (!best || st.mtimeMs > best.mtime) {
        best = { path, mtime: st.mtimeMs };
      }
    } catch {
      // ignore unreadable entries
    }
  }
  return best?.path ?? null;
}

export interface ResolveTsserverWorkspaceOptions {
  exthostPid: number;
  /** Defaults to `~/Library/Application Support/Code/logs`. */
  logsRoot?: string;
  /** Defaults to `~/Library/Application Support/Code/User/workspaceStorage`. */
  workspaceStorageRoot?: string;
}

/**
 * Walk the log pivot: session → window whose renderer.log holds
 * `pid <exthostPid>` → workspaceStorage MD5 from that window's
 * exthost.log → `<MD5>/workspace.json` → folder path. Any missing
 * step returns null.
 */
export function resolveTsserverWorkspacePath(
  opts: ResolveTsserverWorkspaceOptions,
): string | null {
  const logsRoot = opts.logsRoot ?? defaultLogsRoot();
  const storageRoot =
    opts.workspaceStorageRoot ?? defaultWorkspaceStorageRoot();

  const session = findLatestSessionDir(logsRoot);
  if (!session) return null;

  let windows: string[];
  try {
    windows = readdirSync(session).filter((n) => n.startsWith("window"));
  } catch {
    return null;
  }

  for (const win of windows) {
    const winDir = join(session, win);
    const renderer = safeReadText(join(winDir, "renderer.log"));
    if (!renderer) continue;
    const foundPid = parseExthostPidFromRendererLog(renderer);
    if (foundPid !== opts.exthostPid) continue;

    const exthostLog = safeReadText(join(winDir, "exthost", "exthost.log"));
    if (!exthostLog) return null;
    const md5 = parseWorkspaceStorageIdFromExthostLog(exthostLog);
    if (!md5) return null;

    const wsJson = safeReadText(join(storageRoot, md5, "workspace.json"));
    if (!wsJson) return null;
    return parseWorkspaceFolderPath(wsJson);
  }
  return null;
}

function defaultLogsRoot(): string {
  return join(homedir(), "Library", "Application Support", "Code", "logs");
}

function defaultWorkspaceStorageRoot(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "Code",
    "User",
    "workspaceStorage",
  );
}

function safeReadText(path: string): string | null {
  try {
    // Guard against huge logs — read the first 128 KB only. The pid
    // and workspaceStorage lines are always near the top of the file
    // (emitted during startup), so we don't need the rest.
    const fd = statSync(path);
    if (!fd.isFile()) return null;
    return readFileSync(path, { encoding: "utf8" }).slice(0, 131072);
  } catch {
    return null;
  }
}
