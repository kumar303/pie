/**
 * Brain extension data layer.
 *
 * All file I/O for sessions, logs, and status — no TUI imports.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ── Types (JSDoc) ───────────────────────────────────────────────────

/**
 * @typedef {"working" | "idle"} AgentState
 */

/**
 * @typedef {Object} SessionEntry
 * @property {string} sessionId
 * @property {string} dir
 * @property {string | null} branch
 * @property {number} timestamp
 * @property {number} lastFocused
 */

/**
 * @typedef {Object} DirEntry
 * @property {string} sessionId
 * @property {string} dir
 * @property {string | null} branch
 * @property {number} lastFocused
 * @property {boolean} active
 */

/**
 * @typedef {Object} BrainData
 * @property {DirEntry[]} today
 * @property {DirEntry[]} earlier
 */

/**
 * @typedef {Object} StatusData
 * @property {AgentState} state
 * @property {number} updatedAt
 */

// ── Paths ───────────────────────────────────────────────────────────

/** @param {string} [dataDir] @returns {string} */
export function getDataDir(dataDir) {
  const dir =
    dataDir ||
    process.env.PI_BRAIN_DIR ||
    join(homedir(), ".pi", "agent", "brain");
  mkdirSync(join(dir, "status"), { recursive: true });
  mkdirSync(join(dir, "logs"), { recursive: true });
  return dir;
}

/** @param {string} dataDir @returns {string} */
function sessionsPath(dataDir) {
  return join(dataDir, "sessions.jsonl");
}

/** @param {string} dataDir @param {string} sessionId @returns {string} */
function statusPath(dataDir, sessionId) {
  return join(dataDir, "status", `${sessionId}.status`);
}

/** @param {string} dataDir @param {string} sessionId @returns {string} */
function logPath(dataDir, sessionId) {
  return join(dataDir, "logs", `${sessionId}.log`);
}

// ── Git ─────────────────────────────────────────────────────────────

/** @param {string} dir @returns {string | null} */
export function getGitBranch(dir) {
  try {
    return (
      execSync("git branch --show-current", {
        encoding: "utf-8",
        timeout: 3000,
        cwd: dir,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

// ── Sessions ────────────────────────────────────────────────────────

/** @param {string} sessionId @param {string} dir @param {string} [dataDir] */
export function registerSession(sessionId, dir, dataDir) {
  const dd = dataDir ?? getDataDir();
  const branch = getGitBranch(dir);
  const now = Date.now();
  /** @type {SessionEntry} */
  const entry = { sessionId, dir, branch, timestamp: now, lastFocused: now };
  const line = JSON.stringify(entry) + "\n";
  const file = sessionsPath(dd);
  if (!existsSync(file)) {
    writeFileSync(file, line);
  } else {
    const fd = openSync(file, "a");
    writeSync(fd, line);
    closeSync(fd);
  }
}

/** @param {string} sessionId @param {string} dir @param {string} [dataDir] */
export function recordFocus(sessionId, dir, dataDir) {
  const dd = dataDir ?? getDataDir();
  const branch = getGitBranch(dir);
  const now = Date.now();
  /** @type {SessionEntry} */
  const entry = { sessionId, dir, branch, timestamp: now, lastFocused: now };
  const line = JSON.stringify(entry) + "\n";
  const file = sessionsPath(dd);
  if (!existsSync(file)) {
    writeFileSync(file, line);
  } else {
    const fd = openSync(file, "a");
    writeSync(fd, line);
    closeSync(fd);
  }
}

// ── Status ──────────────────────────────────────────────────────────

/** @param {string} sessionId @param {AgentState} state @param {string} [dataDir] */
export function writeStatus(sessionId, state, dataDir) {
  const dd = dataDir ?? getDataDir();
  /** @type {StatusData} */
  const data = { state, updatedAt: Date.now() };
  writeFileSync(statusPath(dd, sessionId), JSON.stringify(data));
}

/** @param {string} sessionId @param {string} [dataDir] @returns {StatusData | null} */
export function readStatus(sessionId, dataDir) {
  const dd = dataDir ?? getDataDir();
  const file = statusPath(dd, sessionId);
  try {
    const raw = readFileSync(file, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const STALE_MS = 5 * 60 * 1000; // 5 minutes

/** @param {string} sessionId @param {string} [dataDir] @param {number} [now] @returns {boolean} */
export function isSessionActive(sessionId, dataDir, now) {
  const status = readStatus(sessionId, dataDir);
  if (!status) return false;
  if (status.state !== "working") return false;
  const currentTime = now ?? Date.now();
  return currentTime - status.updatedAt < STALE_MS;
}

// ── Read sessions ───────────────────────────────────────────────────

/** @param {string} dataDir @returns {SessionEntry[]} */
function readAllEntries(dataDir) {
  const file = sessionsPath(dataDir);
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf-8");
  /** @type {SessionEntry[]} */
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip corrupt lines
    }
  }
  return entries;
}

/** @returns {number} */
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const MAX_LIST = 500;
const MAX_AGE_DAYS = 180;

/** @param {string} [dataDir] @param {number} [now] @returns {BrainData} */
export function readSessions(dataDir, now) {
  const dd = dataDir ?? getDataDir();
  const currentTime = now ?? Date.now();
  const entries = readAllEntries(dd);

  // Prune entries older than 60 days
  const cutoff = currentTime - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const recent = entries.filter((e) => e.lastFocused >= cutoff);

  // Dedup by dir — latest lastFocused wins
  /** @type {Map<string, SessionEntry>} */
  const byDir = new Map();
  for (const e of recent) {
    const existing = byDir.get(e.dir);
    if (!existing || e.lastFocused > existing.lastFocused) {
      byDir.set(e.dir, e);
    }
  }

  const todayStart = startOfToday();
  /** @type {DirEntry[]} */
  const today = [];
  /** @type {DirEntry[]} */
  const earlier = [];

  for (const e of byDir.values()) {
    /** @type {DirEntry} */
    const entry = {
      sessionId: e.sessionId,
      dir: e.dir,
      branch: e.branch,
      lastFocused: e.lastFocused,
      active: isSessionActive(e.sessionId, dd, currentTime),
    };
    if (e.lastFocused >= todayStart) {
      today.push(entry);
    } else {
      earlier.push(entry);
    }
  }

  // Sort by most recently focused first
  today.sort((a, b) => b.lastFocused - a.lastFocused);
  earlier.sort((a, b) => b.lastFocused - a.lastFocused);

  return {
    today: today.slice(0, MAX_LIST),
    earlier: earlier.slice(0, MAX_LIST),
  };
}

// ── Filtering ───────────────────────────────────────────────────────

/** @param {DirEntry[]} dirs @param {string} query @returns {DirEntry[]} */
export function filterDirs(dirs, query) {
  if (!query) return dirs;
  const q = query.toLowerCase();
  return dirs.filter((d) => {
    const name = basename(d.dir).toLowerCase();
    const full = d.dir.toLowerCase();
    const branch = (d.branch || "").toLowerCase();
    return name.includes(q) || full.includes(q) || branch.includes(q);
  });
}

// ── Logs ────────────────────────────────────────────────────────────

const MAX_LOG_LINES = 100;

/** @param {string} sessionId @param {string} toolName @param {string} output @param {string} [dataDir] */
export function appendLog(sessionId, toolName, output, dataDir) {
  const dd = dataDir ?? getDataDir();
  const file = logPath(dd, sessionId);

  const ts = new Date().toISOString();
  const header = `[${toolName}] ${ts}`;
  const newContent = header + "\n" + output + "\n";

  let existing = "";
  try {
    existing = readFileSync(file, "utf-8");
  } catch {
    // file doesn't exist yet
  }

  const combined = existing + newContent;
  const lines = combined.split("\n");

  // Truncate to last MAX_LOG_LINES lines
  const truncated = lines.slice(-MAX_LOG_LINES);
  writeFileSync(file, truncated.join("\n"));
}

/** @param {string} sessionId @param {string} [dataDir] @returns {string[]} */
export function readLog(sessionId, dataDir) {
  const dd = dataDir ?? getDataDir();
  const file = logPath(dd, sessionId);
  try {
    const raw = readFileSync(file, "utf-8");
    return raw.split("\n");
  } catch {
    return [];
  }
}

// ── Pruning ─────────────────────────────────────────────────────────

/** @param {number} [maxAgeDays] @param {string} [dataDir] */
export function pruneOldSessions(maxAgeDays, dataDir) {
  const dd = dataDir ?? getDataDir();
  const days = maxAgeDays ?? MAX_AGE_DAYS;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const entries = readAllEntries(dd);

  /** @type {SessionEntry[]} */
  const kept = [];
  /** @type {Set<string>} */
  const removedSessionIds = new Set();

  for (const e of entries) {
    if (e.lastFocused >= cutoff) {
      kept.push(e);
    } else {
      removedSessionIds.add(e.sessionId);
    }
  }

  // Rewrite sessions.jsonl with only kept entries
  const file = sessionsPath(dd);
  writeFileSync(
    file,
    kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""),
  );

  // Don't remove files for sessions that are still referenced by kept entries
  const keptSessionIds = new Set(kept.map((e) => e.sessionId));
  for (const sid of removedSessionIds) {
    if (keptSessionIds.has(sid)) continue;
    // Remove status and log files
    try {
      unlinkSync(statusPath(dd, sid));
    } catch {}
    try {
      unlinkSync(logPath(dd, sid));
    } catch {}
  }
}
