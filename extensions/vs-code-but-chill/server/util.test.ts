import { describe, it, expect } from "vitest";
import { createLineFramer } from "./util.ts";

describe("createLineFramer", () => {
  it("splits on newline and drops blank lines", () => {
    const f = createLineFramer();
    expect(f("a\nb\n")).toEqual(["a", "b"]);
  });

  it("buffers across chunks until a newline arrives", () => {
    const f = createLineFramer();
    expect(f("partial")).toEqual([]);
    expect(f(" line\n")).toEqual(["partial line"]);
  });

  it("handles multiple newlines in a single chunk", () => {
    const f = createLineFramer();
    expect(f("one\ntwo\nthree\n")).toEqual(["one", "two", "three"]);
  });

  it("keeps trailing content after the last newline for the next call", () => {
    const f = createLineFramer();
    expect(f("done\npart")).toEqual(["done"]);
    expect(f("ial\n")).toEqual(["partial"]);
  });

  it("drops whitespace-only lines", () => {
    const f = createLineFramer();
    expect(f("a\n   \nb\n")).toEqual(["a", "b"]);
  });
});
