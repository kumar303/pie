/**
 * Read the server's on-disk log file and turn it into display lines
 * for the `/vs-code-but-chill logs` viewer.
 *
 * The server writes `{"ts": "...", "msg": "..."}` as newline-delimited
 * JSON to `server.log`. This module is the single source of truth for
 * how the extension surfaces those entries in the TUI: parse each
 * line, format as `[ts] msg`, and gracefully pass through anything
 * unparseable (e.g. a partial write caught mid-flush) so the viewer
 * never goes blank on ragged input.
 */

import { readFileSync, existsSync } from "node:fs";

export interface LogEntryShape {
  ts: unknown;
  msg: unknown;
}

/** True iff `v` is `{ ts: string, msg: string, ... }`. */
export function isLogEntry(v: unknown): v is { ts: string; msg: string } {
  if (!v || typeof v !== "object") return false;
  const o = v as LogEntryShape;
  return typeof o.ts === "string" && typeof o.msg === "string";
}

/**
 * Turn one raw file line into a display string. A well-formed JSON
 * entry renders as `[ts] msg`; anything else is returned verbatim so
 * the user still sees *something* when the file is mid-rotation or
 * was written by an older server version.
 */
export function formatLine(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (isLogEntry(parsed)) return `[${parsed.ts}] ${parsed.msg}`;
  return raw;
}

/**
 * Read the last `maxLines` entries from `path`. Missing file → empty
 * array (the server may not have written anything yet). Caller
 * handles display; we don't throw on a truncated JSON line, just
 * surface the raw text.
 */
export function readLogTail(path: string, maxLines: number): string[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const tail = lines.slice(-maxLines);
  return tail.map(formatLine);
}
