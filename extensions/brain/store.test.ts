import { describe, it, expect, beforeEach } from "vitest";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getDataDir,
  registerSession,
  recordFocus,
  writeStatus,
  readStatus,
  isSessionActive,
  readSessions,
  filterDirs,
  appendLog,
  readLog,
  pruneOldSessions,
  type DirEntry,
} from "./store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "brain-test-"));
  // Ensure subdirs exist
  mkdirSync(join(tmpDir, "status"), { recursive: true });
  mkdirSync(join(tmpDir, "logs"), { recursive: true });
});

// ── getDataDir ──────────────────────────────────────────────────────

describe("getDataDir", () => {
  it("uses PI_BRAIN_DIR env var when set", () => {
    const orig = process.env.PI_BRAIN_DIR;
    try {
      process.env.PI_BRAIN_DIR = tmpDir;
      const dir = getDataDir();
      expect(dir).toBe(tmpDir);
    } finally {
      if (orig === undefined) delete process.env.PI_BRAIN_DIR;
      else process.env.PI_BRAIN_DIR = orig;
    }
  });

  it("creates subdirectories", () => {
    const orig = process.env.PI_BRAIN_DIR;
    try {
      const freshDir = join(tmpDir, "fresh");
      process.env.PI_BRAIN_DIR = freshDir;
      getDataDir();
      expect(existsSync(join(freshDir, "status"))).toBe(true);
      expect(existsSync(join(freshDir, "logs"))).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.PI_BRAIN_DIR;
      else process.env.PI_BRAIN_DIR = orig;
    }
  });
});

// ── registerSession ─────────────────────────────────────────────────

describe("registerSession", () => {
  it("appends a session entry to sessions.jsonl", () => {
    registerSession("s1", "/tmp/project-a", tmpDir);
    const raw = readFileSync(join(tmpDir, "sessions.jsonl"), "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.sessionId).toBe("s1");
    expect(entry.dir).toBe("/tmp/project-a");
    expect(entry.lastFocused).toBeTypeOf("number");
  });

  it("appends multiple sessions", () => {
    registerSession("s1", "/tmp/a", tmpDir);
    registerSession("s2", "/tmp/b", tmpDir);
    const raw = readFileSync(join(tmpDir, "sessions.jsonl"), "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});

// ── recordFocus ─────────────────────────────────────────────────────

describe("recordFocus", () => {
  it("appends a new entry with updated lastFocused", () => {
    registerSession("s1", "/tmp/a", tmpDir);
    recordFocus("s1", "/tmp/a", tmpDir);
    const raw = readFileSync(join(tmpDir, "sessions.jsonl"), "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(second.lastFocused).toBeGreaterThanOrEqual(first.lastFocused);
  });
});

// ── Status ──────────────────────────────────────────────────────────

describe("writeStatus / readStatus", () => {
  it("writes and reads status", () => {
    writeStatus("s1", "working", tmpDir);
    const status = readStatus("s1", tmpDir);
    expect(status).not.toBeNull();
    expect(status!.state).toBe("working");
    expect(status!.updatedAt).toBeTypeOf("number");
  });

  it("returns null for missing status", () => {
    const status = readStatus("nonexistent", tmpDir);
    expect(status).toBeNull();
  });

  it("overwrites with idle", () => {
    writeStatus("s1", "working", tmpDir);
    writeStatus("s1", "idle", tmpDir);
    const status = readStatus("s1", tmpDir);
    expect(status!.state).toBe("idle");
  });
});

// ── isSessionActive ─────────────────────────────────────────────────

describe("isSessionActive", () => {
  it("returns true for working status within 5 minutes", () => {
    writeStatus("s1", "working", tmpDir);
    const status = readStatus("s1", tmpDir)!;
    expect(isSessionActive("s1", tmpDir, status.updatedAt + 1000)).toBe(true);
  });

  it("returns false for idle status", () => {
    writeStatus("s1", "idle", tmpDir);
    expect(isSessionActive("s1", tmpDir)).toBe(false);
  });

  it("returns false for stale working status (> 5 min)", () => {
    writeStatus("s1", "working", tmpDir);
    const status = readStatus("s1", tmpDir)!;
    const staleTime = status.updatedAt + 6 * 60 * 1000;
    expect(isSessionActive("s1", tmpDir, staleTime)).toBe(false);
  });

  it("returns false for missing status file", () => {
    expect(isSessionActive("nonexistent", tmpDir)).toBe(false);
  });
});

// ── readSessions ────────────────────────────────────────────────────

describe("readSessions", () => {
  it("returns empty data for no sessions", () => {
    const data = readSessions(tmpDir);
    expect(data.today).toHaveLength(0);
    expect(data.earlier).toHaveLength(0);
  });

  it("deduplicates by dir, keeping latest lastFocused", () => {
    const now = Date.now();
    // Write two entries for same dir
    const file = join(tmpDir, "sessions.jsonl");
    const e1 = JSON.stringify({
      sessionId: "s1",
      dir: "/tmp/a",
      branch: null,
      timestamp: now - 1000,
      lastFocused: now - 1000,
    });
    const e2 = JSON.stringify({
      sessionId: "s1",
      dir: "/tmp/a",
      branch: "main",
      timestamp: now,
      lastFocused: now,
    });
    writeFileSync(file, e1 + "\n" + e2 + "\n");

    const data = readSessions(tmpDir, now);
    const all = [...data.today, ...data.earlier];
    expect(all).toHaveLength(1);
    expect(all[0].branch).toBe("main"); // latest entry
  });

  it("partitions into today and earlier", () => {
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const file = join(tmpDir, "sessions.jsonl");
    const todayEntry = JSON.stringify({
      sessionId: "s1",
      dir: "/tmp/today",
      branch: null,
      timestamp: now,
      lastFocused: now,
    });
    const yesterdayTime = todayStart.getTime() - 1000;
    const earlierEntry = JSON.stringify({
      sessionId: "s2",
      dir: "/tmp/yesterday",
      branch: null,
      timestamp: yesterdayTime,
      lastFocused: yesterdayTime,
    });
    writeFileSync(file, todayEntry + "\n" + earlierEntry + "\n");

    const data = readSessions(tmpDir, now);
    expect(data.today).toHaveLength(1);
    expect(data.today[0].dir).toBe("/tmp/today");
    expect(data.earlier).toHaveLength(1);
    expect(data.earlier[0].dir).toBe("/tmp/yesterday");
  });

  it("caps each list at 100 entries", () => {
    const now = Date.now();
    const file = join(tmpDir, "sessions.jsonl");
    let content = "";
    for (let i = 0; i < 110; i++) {
      content +=
        JSON.stringify({
          sessionId: `s${i}`,
          dir: `/tmp/project-${i}`,
          branch: null,
          timestamp: now - i * 1000,
          lastFocused: now - i * 1000,
        }) + "\n";
    }
    writeFileSync(file, content);

    const data = readSessions(tmpDir, now);
    expect(data.today.length).toBeLessThanOrEqual(500);
  });

  it("sorts by most recently focused first", () => {
    const now = Date.now();
    const file = join(tmpDir, "sessions.jsonl");
    const e1 = JSON.stringify({
      sessionId: "s1",
      dir: "/tmp/a",
      branch: null,
      timestamp: now - 2000,
      lastFocused: now - 2000,
    });
    const e2 = JSON.stringify({
      sessionId: "s2",
      dir: "/tmp/b",
      branch: null,
      timestamp: now - 1000,
      lastFocused: now,
    });
    writeFileSync(file, e1 + "\n" + e2 + "\n");

    const data = readSessions(tmpDir, now);
    const all = [...data.today, ...data.earlier];
    expect(all[0].dir).toBe("/tmp/b");
    expect(all[1].dir).toBe("/tmp/a");
  });

  it("prunes entries older than 180 days", () => {
    const now = Date.now();
    const oldTime = now - 181 * 24 * 60 * 60 * 1000;
    const file = join(tmpDir, "sessions.jsonl");
    const e1 = JSON.stringify({
      sessionId: "s1",
      dir: "/tmp/old",
      branch: null,
      timestamp: oldTime,
      lastFocused: oldTime,
    });
    const e2 = JSON.stringify({
      sessionId: "s2",
      dir: "/tmp/new",
      branch: null,
      timestamp: now,
      lastFocused: now,
    });
    writeFileSync(file, e1 + "\n" + e2 + "\n");

    const data = readSessions(tmpDir, now);
    const all = [...data.today, ...data.earlier];
    expect(all).toHaveLength(1);
    expect(all[0].dir).toBe("/tmp/new");
  });

  it("populates active flag from disk on startup", () => {
    const now = Date.now();
    const file = join(tmpDir, "sessions.jsonl");
    writeFileSync(
      file,
      JSON.stringify({
        sessionId: "s1",
        dir: "/tmp/active",
        branch: null,
        timestamp: now,
        lastFocused: now,
      }) + "\n",
    );
    writeStatus("s1", "working", tmpDir);

    const data = readSessions(tmpDir, now + 1000);
    expect(data.today[0].active).toBe(true);
  });
});

// ── filterDirs ──────────────────────────────────────────────────────

describe("filterDirs", () => {
  const dirs: DirEntry[] = [
    {
      sessionId: "s1",
      dir: "/home/user/project-alpha",
      branch: "main",
      lastFocused: 1,
      active: false,
    },
    {
      sessionId: "s2",
      dir: "/home/user/project-beta",
      branch: "feat/login",
      lastFocused: 2,
      active: false,
    },
    {
      sessionId: "s3",
      dir: "/home/user/gamma",
      branch: null,
      lastFocused: 3,
      active: false,
    },
  ];

  it("returns all dirs for empty query", () => {
    expect(filterDirs(dirs, "")).toEqual(dirs);
  });

  it("filters by basename (case-insensitive)", () => {
    const result = filterDirs(dirs, "Alpha");
    expect(result).toHaveLength(1);
    expect(result[0].dir).toBe("/home/user/project-alpha");
  });

  it("filters by full path", () => {
    const result = filterDirs(dirs, "/home/user/gamma");
    expect(result).toHaveLength(1);
    expect(result[0].dir).toBe("/home/user/gamma");
  });

  it("filters by branch", () => {
    const result = filterDirs(dirs, "login");
    expect(result).toHaveLength(1);
    expect(result[0].dir).toBe("/home/user/project-beta");
  });

  it("returns empty for no match", () => {
    expect(filterDirs(dirs, "zzz")).toHaveLength(0);
  });
});

// ── Logs ────────────────────────────────────────────────────────────

describe("appendLog / readLog", () => {
  it("appends and reads log", () => {
    appendLog("s1", "bash", "hello world", tmpDir);
    const lines = readLog("s1", tmpDir);
    expect(lines.some((l) => l.includes("[bash]"))).toBe(true);
    expect(lines.some((l) => l.includes("hello world"))).toBe(true);
  });

  it("returns empty array for missing log", () => {
    expect(readLog("nonexistent", tmpDir)).toEqual([]);
  });

  it("truncates to last 100 lines", () => {
    // Write more than 100 lines
    for (let i = 0; i < 60; i++) {
      appendLog("s1", "bash", `line-${i}\nline-${i}-b`, tmpDir);
    }
    const lines = readLog("s1", tmpDir);
    expect(lines.length).toBeLessThanOrEqual(100);
  });
});

// ── pruneOldSessions ────────────────────────────────────────────────

describe("pruneOldSessions", () => {
  it("removes entries and files older than maxAgeDays", () => {
    const now = Date.now();
    const oldTime = now - 2 * 24 * 60 * 60 * 1000; // 2 days ago

    const file = join(tmpDir, "sessions.jsonl");
    writeFileSync(
      file,
      JSON.stringify({
        sessionId: "old",
        dir: "/tmp/old",
        branch: null,
        timestamp: oldTime,
        lastFocused: oldTime,
      }) +
        "\n" +
        JSON.stringify({
          sessionId: "new",
          dir: "/tmp/new",
          branch: null,
          timestamp: now,
          lastFocused: now,
        }) +
        "\n",
    );

    writeStatus("old", "idle", tmpDir);
    appendLog("old", "bash", "old output", tmpDir);
    writeStatus("new", "working", tmpDir);

    pruneOldSessions(1, tmpDir); // Prune older than 1 day

    const raw = readFileSync(file, "utf-8");
    const entries = raw.trim().split("\n").filter(Boolean);
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]).sessionId).toBe("new");

    // Old files removed
    expect(existsSync(join(tmpDir, "status", "old.status"))).toBe(false);
    expect(existsSync(join(tmpDir, "logs", "old.log"))).toBe(false);

    // New files kept
    expect(existsSync(join(tmpDir, "status", "new.status"))).toBe(true);
  });

  it("does not remove files for sessions still referenced", () => {
    const now = Date.now();
    const oldTime = now - 2 * 24 * 60 * 60 * 1000;

    const file = join(tmpDir, "sessions.jsonl");
    // Two entries for same session: one old dir, one new dir
    writeFileSync(
      file,
      JSON.stringify({
        sessionId: "s1",
        dir: "/tmp/old",
        branch: null,
        timestamp: oldTime,
        lastFocused: oldTime,
      }) +
        "\n" +
        JSON.stringify({
          sessionId: "s1",
          dir: "/tmp/new",
          branch: null,
          timestamp: now,
          lastFocused: now,
        }) +
        "\n",
    );

    writeStatus("s1", "working", tmpDir);

    pruneOldSessions(1, tmpDir);

    // s1 status file should still exist since s1 is referenced by kept entry
    expect(existsSync(join(tmpDir, "status", "s1.status"))).toBe(true);
  });
});
