/**
 * Append-only log writer with rotation at 5 MB.
 */

import {
  appendFileSync,
  existsSync,
  renameSync,
  statSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { reportStderr } from "./errors.ts";

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Render a timestamp in the local timezone as ISO 8601 with offset
 * (e.g. `2026-04-23T23:05:10.566+01:00`). We avoid `Date.toISOString()`
 * because that forces UTC (`Z` suffix), which was off by one hour
 * from the user's wall clock.
 */
export function formatLocalTimestamp(d: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  const ms = pad(d.getMilliseconds(), 3);
  // getTimezoneOffset is minutes WEST of UTC, so invert the sign.
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const tz = `${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`;
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}${tz}`;
}

interface LogEntry {
  ts: string;
  msg: string;
}

/** Type guard for a well-formed persisted log entry. */
function isLogEntry(v: unknown): v is LogEntry {
  return (
    !!v &&
    typeof v === "object" &&
    "ts" in v &&
    typeof v.ts === "string" &&
    "msg" in v &&
    typeof v.msg === "string"
  );
}

export class LogWriter {
  private readonly path: string;
  private readonly rotatedPath: string;
  /** Ring buffer of recent lines for the `logs` IPC request. */
  private readonly recent: string[] = [];
  private readonly recentCap: number;
  /** Listeners for streamed log lines. */
  private readonly listeners: Array<(line: string) => void> = [];

  constructor(
    path: string,
    rotatedPath: string,
    opts?: { recentCap?: number },
  ) {
    this.path = path;
    this.rotatedPath = rotatedPath;
    this.recentCap = opts?.recentCap ?? 1000;
    // Seed recent from existing file so `/logs` works on cold start.
    // Pretty-print each JSON entry back to "[ts] msg" for the viewer.
    try {
      if (existsSync(this.path)) {
        const raw = readFileSync(this.path, "utf-8");
        const lines = raw.split("\n").filter(Boolean);
        for (const l of lines.slice(-this.recentCap)) {
          // A line that won't parse is expected on interrupted writes;
          // fall through to raw display without logging each one.
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(l);
          } catch {
            parsed = null;
          }
          if (isLogEntry(parsed)) {
            this.recent.push(`[${parsed.ts}] ${parsed.msg}`);
          } else {
            this.recent.push(l);
          }
        }
      }
    } catch (err) {
      // Surface to stderr — we can't log to the log file we just failed
      // to read. Server continues with an empty recent buffer.
      reportStderr("log seed failed", err);
    }
  }

  write(line: string): void {
    // PLAN.md: "Append JSON lines to server.log."
    const ts = formatLocalTimestamp();
    const jsonEntry = JSON.stringify({ ts, msg: line });
    const displayEntry = `[${ts}] ${line}`;
    try {
      appendFileSync(this.path, jsonEntry + "\n", "utf-8");
      this.#maybeRotate();
    } catch (err) {
      // Can't log to the file we're trying to write — fall back to stderr.
      reportStderr("log append failed", err);
    }
    this.recent.push(displayEntry);
    if (this.recent.length > this.recentCap) {
      this.recent.splice(0, this.recent.length - this.recentCap);
    }
    for (const l of this.listeners) {
      try {
        l(displayEntry);
      } catch (err) {
        // A listener throwing is a bug, not an expected condition.
        // Log it out-of-band so we don't loop through write() again.
        reportStderr("log listener error", err);
      }
    }
  }

  tail(n?: number): string[] {
    if (typeof n !== "number") return this.recent.slice();
    return this.recent.slice(-n);
  }

  onLine(listener: (line: string) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  #maybeRotate(): void {
    try {
      const s = statSync(this.path);
      if (s.size < MAX_BYTES) return;
      if (existsSync(this.rotatedPath)) {
        try {
          unlinkSync(this.rotatedPath);
        } catch (err) {
          reportStderr("could not remove old rotated log", err);
        }
      }
      renameSync(this.path, this.rotatedPath);
    } catch (err) {
      reportStderr("log rotation failed", err);
    }
  }
}
