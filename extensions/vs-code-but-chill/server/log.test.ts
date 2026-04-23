import { describe, it, expect } from "vitest";
import { formatLocalTimestamp } from "./log.ts";

describe("formatLocalTimestamp", () => {
  it("renders the local time with timezone offset", () => {
    const ts = formatLocalTimestamp(new Date("2026-04-23T22:05:10.566Z"));
    expect(ts).toMatch(
      /^2026-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/,
    );
    // Must NOT end in `Z` (that would mean UTC).
    expect(ts.endsWith("Z")).toBe(false);
  });

  it("uses local hour-of-day, not UTC hour-of-day", () => {
    const d = new Date("2026-04-23T22:05:10.566Z");
    const ts = formatLocalTimestamp(d);
    const localHour = String(d.getHours()).padStart(2, "0");
    // The hour segment is chars 11..13.
    expect(ts.slice(11, 13)).toBe(localHour);
  });
});
