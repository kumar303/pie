import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatLine, readLogTail, isLogEntry } from "./log-file-reader.ts";

describe("formatLine", () => {
  it("renders well-formed JSON entries as [ts] msg", () => {
    const raw = JSON.stringify({
      ts: "2026-04-23T10:00:00.000Z",
      msg: "hello world",
    });
    expect(formatLine(raw)).toBe("[2026-04-23T10:00:00.000Z] hello world");
  });

  it("passes through lines that aren't valid JSON", () => {
    // Partial writes or legacy lines still show something meaningful.
    expect(formatLine("half-written{")).toBe("half-written{");
  });

  it("passes through JSON that's missing the ts/msg shape", () => {
    // A JSON object without the right fields is better shown raw than
    // silently dropped.
    const raw = JSON.stringify({ hello: "world" });
    expect(formatLine(raw)).toBe(raw);
  });
});

describe("isLogEntry", () => {
  it("accepts { ts:string, msg:string }", () => {
    expect(isLogEntry({ ts: "x", msg: "y" })).toBe(true);
  });
  it("rejects wrong shapes", () => {
    expect(isLogEntry(null)).toBe(false);
    expect(isLogEntry(42)).toBe(false);
    expect(isLogEntry({ ts: 1, msg: "y" })).toBe(false);
    expect(isLogEntry({ ts: "x" })).toBe(false);
  });
});

describe("readLogTail", () => {
  it("returns an empty array if the file does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "vscbc-logread-"));
    try {
      expect(readLogTail(join(dir, "nope.log"), 10)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns only the last N entries, formatted", () => {
    const dir = mkdtempSync(join(tmpdir(), "vscbc-logread-"));
    const path = join(dir, "server.log");
    try {
      const lines = Array.from({ length: 5 }, (_, i) =>
        JSON.stringify({ ts: `t${i}`, msg: `m${i}` }),
      );
      writeFileSync(path, lines.join("\n") + "\n");
      const out = readLogTail(path, 3);
      expect(out).toEqual(["[t2] m2", "[t3] m3", "[t4] m4"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives a ragged final line (mid-rotation write)", () => {
    // A partial JSON write shouldn't make the whole tail blank.
    const dir = mkdtempSync(join(tmpdir(), "vscbc-logread-"));
    const path = join(dir, "server.log");
    try {
      writeFileSync(
        path,
        [
          JSON.stringify({ ts: "t0", msg: "good" }),
          '{"ts":"t1","msg":"almost',
        ].join("\n") + "\n",
      );
      const out = readLogTail(path, 10);
      expect(out[0]).toBe("[t0] good");
      // Raw passthrough keeps the user informed.
      expect(out[1]).toContain("almost");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
