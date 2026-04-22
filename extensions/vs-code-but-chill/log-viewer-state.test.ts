import { describe, it, expect } from "vitest";
import {
  initialState,
  clampOffset,
  applyFollow,
  onNewLine,
  onScrollUp,
  onScrollDown,
  onJumpTop,
  onJumpBottom,
  onPageUp,
  onPageDown,
} from "./log-viewer-state.ts";

const BODY = 10;

describe("log-viewer state machine", () => {
  it("starts in follow mode with zero offset and zero pending", () => {
    const s = initialState();
    expect(s).toEqual({ offset: 0, followMode: true, pendingCount: 0 });
  });

  describe("clampOffset", () => {
    it("clamps to zero for empty buffer", () => {
      const s = { offset: 42, followMode: false, pendingCount: 0 };
      expect(clampOffset(s, 0, BODY).offset).toBe(0);
    });
    it("clamps to max when buffer is smaller than offset", () => {
      const s = { offset: 100, followMode: false, pendingCount: 0 };
      // buffer has 15 lines, body fits 10 → max offset is 5
      expect(clampOffset(s, 15, BODY).offset).toBe(5);
    });
    it("clamps negative to zero", () => {
      const s = { offset: -3, followMode: false, pendingCount: 0 };
      expect(clampOffset(s, 20, BODY).offset).toBe(0);
    });
    it("is a no-op when offset is already in range", () => {
      const s = { offset: 3, followMode: false, pendingCount: 0 };
      expect(clampOffset(s, 20, BODY).offset).toBe(3);
    });
  });

  describe("applyFollow", () => {
    it("pins offset to bottom when follow mode is on", () => {
      const s = { offset: 0, followMode: true, pendingCount: 5 };
      const next = applyFollow(s, 30, BODY);
      expect(next.offset).toBe(20); // 30 lines, body 10 → show lines 20..29
      expect(next.pendingCount).toBe(0);
    });
    it("does not touch offset when follow mode is off", () => {
      const s = { offset: 5, followMode: false, pendingCount: 7 };
      const next = applyFollow(s, 30, BODY);
      expect(next.offset).toBe(5);
      expect(next.pendingCount).toBe(7);
    });
  });

  describe("onNewLine", () => {
    it("leaves state unchanged in follow mode", () => {
      const s = initialState();
      expect(onNewLine(s)).toEqual(s);
    });
    it("increments pendingCount when paused", () => {
      const s = { offset: 3, followMode: false, pendingCount: 2 };
      expect(onNewLine(s).pendingCount).toBe(3);
    });
  });

  describe("onScrollUp", () => {
    it("pauses follow mode and decrements offset", () => {
      const s = { offset: 5, followMode: true, pendingCount: 0 };
      const next = onScrollUp(s);
      expect(next.followMode).toBe(false);
      expect(next.offset).toBe(4);
    });
    it("does not go below zero", () => {
      const s = { offset: 0, followMode: false, pendingCount: 0 };
      expect(onScrollUp(s).offset).toBe(0);
    });
  });

  describe("onScrollDown", () => {
    it("increments offset when not at bottom", () => {
      // buffer 30, body 10 → max is 20. Start at 5.
      const s = { offset: 5, followMode: false, pendingCount: 3 };
      const next = onScrollDown(s, 30, BODY);
      expect(next.offset).toBe(6);
      expect(next.followMode).toBe(false);
      expect(next.pendingCount).toBe(3);
    });
    it("snaps to follow and clears pending when the user hits bottom", () => {
      const s = { offset: 19, followMode: false, pendingCount: 5 };
      const next = onScrollDown(s, 30, BODY);
      expect(next.offset).toBe(20);
      expect(next.followMode).toBe(true);
      expect(next.pendingCount).toBe(0);
    });
  });

  describe("onPageUp", () => {
    it("pauses follow and scrolls up by the body height", () => {
      const s = { offset: 18, followMode: true, pendingCount: 0 };
      const next = onPageUp(s, BODY);
      expect(next.offset).toBe(8);
      expect(next.followMode).toBe(false);
    });
    it("clamps to zero when a page up would go past the top", () => {
      const s = { offset: 3, followMode: false, pendingCount: 0 };
      expect(onPageUp(s, BODY).offset).toBe(0);
    });
  });

  describe("onPageDown", () => {
    it("scrolls down by the body height without touching follow state when not at bottom", () => {
      const s = { offset: 2, followMode: false, pendingCount: 4 };
      const next = onPageDown(s, 100, BODY);
      expect(next.offset).toBe(12);
      expect(next.followMode).toBe(false);
      // Pending is preserved while still paused.
      expect(next.pendingCount).toBe(4);
    });
    it("snaps back to follow mode and clears pending on reaching the bottom", () => {
      // buffer 30, body 10 → max offset 20. Offset 15 + page → 25 > max.
      const s = { offset: 15, followMode: false, pendingCount: 7 };
      const next = onPageDown(s, 30, BODY);
      expect(next.offset).toBe(20);
      expect(next.followMode).toBe(true);
      expect(next.pendingCount).toBe(0);
    });
  });

  describe("onJumpTop", () => {
    it("pauses follow and sets offset to zero", () => {
      const s = { offset: 18, followMode: true, pendingCount: 0 };
      const next = onJumpTop(s);
      expect(next.offset).toBe(0);
      expect(next.followMode).toBe(false);
    });
  });

  describe("onJumpBottom", () => {
    it("resumes follow and jumps to the last body-window", () => {
      const s = { offset: 0, followMode: false, pendingCount: 12 };
      const next = onJumpBottom(s, 30, BODY);
      expect(next.offset).toBe(20);
      expect(next.followMode).toBe(true);
      expect(next.pendingCount).toBe(0);
    });
    it("handles buffers smaller than body", () => {
      const s = { offset: 0, followMode: false, pendingCount: 3 };
      const next = onJumpBottom(s, 4, BODY);
      expect(next.offset).toBe(0);
      expect(next.followMode).toBe(true);
    });
  });

  describe("end-to-end follow → pause → resume sequence", () => {
    it("buffers pending while paused and drops them on G", () => {
      let s = initialState();
      // 20 lines arrive while in follow mode → pending stays 0
      for (let i = 0; i < 20; i++) s = onNewLine(s);
      expect(s.pendingCount).toBe(0);

      // User presses up → paused, offset decremented from 0 with follow's pin
      s = applyFollow(s, 20, BODY); // pin at 10
      s = onScrollUp(s);
      expect(s.followMode).toBe(false);
      expect(s.offset).toBe(9);

      // 5 new lines while paused
      for (let i = 0; i < 5; i++) s = onNewLine(s);
      expect(s.pendingCount).toBe(5);
      expect(s.offset).toBe(9); // unchanged

      // User presses G → back to follow, pending cleared, pinned to bottom
      // of the now 25-line buffer
      s = onJumpBottom(s, 25, BODY);
      expect(s.followMode).toBe(true);
      expect(s.pendingCount).toBe(0);
      expect(s.offset).toBe(15);
    });
  });
});
