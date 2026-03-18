/**
 * Brain extension data layer.
 *
 * All file I/O for sessions, logs, and status — no TUI imports.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ── Types ───────────────────────────────────────────────────────────

export interface SessionEntry {
  sessionId: string;
  dir: string;
  branch: string | null;
  timestamp: number;
  lastFocused: number;
}

export interface DirEntry {
  sessionId: string;
  dir: string;
  branch: string | null;
  lastFocused: number;
  active: boolean;
}

export interface BrainData {
  today: DirEntry[];
  earlier: DirEntry[];
}

export interface StatusData {
  state: "working" | "idle";
  updatedAt: number;
}

// ── Paths ───────────────────────────────────────────────────────────

export function getDataDir(): string {
  const dir = process.env.PI_BRAIN_DIR || join(homedir(), ".pi", "agent", "brain");
  mkdirSync(join(dir, "status"), { recursive: true });
  mkdirSync(join(dir, "logs"), { recursive: true });
  return dir;
}

function sessionsPath(dataDir: string): string {
  return join(dataDir, "sessions.jsonl");
}

function statusPath(dataDir: string, sessionId: string): string {
  return join(dataDir, "status", `${sessionId}.status`);
}

function logPath(dataDir: string, sessionId: string): string {
  return join(dataDir, "logs", `${sessionId}.log`);
}

// ── Git ─────────────────────────────────────────────────────────────

export function getGitBranch(dir: string): string | null {
  try {
    return execSync("git branch --show-current", {
      encoding: "utf-8",
      timeout: 3000,
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim() || null;
  } catch {
    return null;
  }
}

// ── Sessions ────────────────────────────────────────────────────────

export function registerSession(sessionId: string, dir: string, dataDir?: string): void {
  const dd = dataDir ?? getDataDir();
  const branch = getGitBranch(dir);
  const now = Date.now();
  const entry: SessionEntry = {
    sessionId,
    dir,
    branch,
    timestamp: now,
    lastFocused: now,
  };
  const line = JSON.stringify(entry) + "\n";
  const file = sessionsPath(dd);
  if (!existsSync(file)) {
    writeFileSync(file, line);
  } else {
    const fd = require("node:fs").openSync(file, "a");
    require("node:fs").writeSync(fd, line);
    require("node:fs").closeSync(fd);
  }
}

export function recordFocus(sessionId: string, dir: string, dataDir?: string): void {
  const dd = dataDir ?? getDataDir();
  const branch = getGitBranch(dir);
  const now = Date.now();
  const entry: SessionEntry = {
    sessionId,
    dir,
    branch,
    timestamp: now,
    lastFocused: now,
  };
  const line = JSON.stringify(entry) + "\n";
  const file = sessionsPath(dd);
  if (!existsSync(file)) {
    writeFileSync(file, line);
  } else {
    const fd = require("node:fs").openSync(file, "a");
    require("node:fs").writeSync(fd, line);
    require("node:fs").closeSync(fd);
  }
}

// ── Status ──────────────────────────────────────────────────────────

export function writeStatus(sessionId: string, state: "working" | "idle", dataDir?: string): void {
  const dd = dataDir ?? getDataDir();
  const data: StatusData = { state, updatedAt: Date.now() };
  writeFileSync(statusPath(dd, sessionId), JSON.stringify(data));
}

export function readStatus(sessionId: string, dataDir?: string): StatusData | null {
  const dd = dataDir ?? getDataDir();
  const file = statusPath(dd, sessionId);
  try {
    const raw = readFileSync(file, "utf-8");
    return JSON.parse(raw) as StatusData;
  } catch {
    return null;
  }
}

const STALE_MS = 5 * 60 * 1000; // 5 minutes

export function isSessionActive(sessionId: string, dataDir?: string, now?: number): boolean {
  const status = readStatus(sessionId, dataDir);
  if (!status) return false;
  if (status.state !== "working") return false;
  const currentTime = now ?? Date.now();
  return (currentTime - status.updatedAt) < STALE_MS;
}

// ── Read sessions ───────────────────────────────────────────────────

function readAllEntries(dataDir: string): SessionEntry[] {
  const file = sessionsPath(dataDir);
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf-8");
  const entries: SessionEntry[] = [];
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

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const MAX_LIST = 50;
const MAX_AGE_DAYS = 30;

export function readSessions(dataDir?: string, now?: number): BrainData {
  const dd = dataDir ?? getDataDir();
  const currentTime = now ?? Date.now();
  const entries = readAllEntries(dd);

  // Prune entries older than 30 days
  const cutoff = currentTime - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const recent = entries.filter((e) => e.lastFocused >= cutoff);

  // Dedup by dir — latest lastFocused wins
  const byDir = new Map<string, SessionEntry>();
  for (const e of recent) {
    const existing = byDir.get(e.dir);
    if (!existing || e.lastFocused > existing.lastFocused) {
      byDir.set(e.dir, e);
    }
  }

  const todayStart = startOfToday();
  const today: DirEntry[] = [];
  const earlier: DirEntry[] = [];

  for (const e of byDir.values()) {
    const entry: DirEntry = {
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

export function filterDirs(dirs: DirEntry[], query: string): DirEntry[] {
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

export function appendLog(sessionId: string, toolName: string, output: string, dataDir?: string): void {
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

export function readLog(sessionId: string, dataDir?: string): string[] {
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

export function pruneOldSessions(maxAgeDays?: number, dataDir?: string): void {
  const dd = dataDir ?? getDataDir();
  const days = maxAgeDays ?? MAX_AGE_DAYS;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const entries = readAllEntries(dd);

  const kept: SessionEntry[] = [];
  const removedSessionIds = new Set<string>();

  for (const e of entries) {
    if (e.lastFocused >= cutoff) {
      kept.push(e);
    } else {
      removedSessionIds.add(e.sessionId);
    }
  }

  // Rewrite sessions.jsonl with only kept entries
  const file = sessionsPath(dd);
  writeFileSync(file, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""));

  // Don't remove files for sessions that are still referenced by kept entries
  const keptSessionIds = new Set(kept.map((e) => e.sessionId));
  for (const sid of removedSessionIds) {
    if (keptSessionIds.has(sid)) continue;
    // Remove status and log files
    try { unlinkSync(statusPath(dd, sid)); } catch {}
    try { unlinkSync(logPath(dd, sid)); } catch {}
  }
}
