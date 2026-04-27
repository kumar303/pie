/**
 * Edge-case unit tests for branch name validation. Last-resort
 * unit tests (per AGENTS.md): no integration test can observe
 * each invalid form more cleanly than calling the validator
 * directly.
 */

import { describe, it, expect } from "vitest";
import { validateBranchName } from "./branch.js";

describe("validateBranchName", () => {
  it("accepts simple names", () => {
    expect(validateBranchName("feat")).toBeNull();
    expect(validateBranchName("feat/sub")).toBeNull();
    expect(validateBranchName("feat-1.2")).toBeNull();
  });

  it.each([
    ["", /empty/i],
    ["@", /'@'/],
    ["with space", /space/i],
    ["weird~thing", /invalid characters/i],
    ["bad..thing", /'\.\.'/],
    ["x@{y", /'@\{'/],
    ["a//b", /'\/\/'/],
    ["-leading", /start with '-'/],
    [".leading", /start with '\.'/],
    ["/leading", /start with '\/'/],
    ["trailing/", /end with '\/'/],
    ["trailing.", /end with '\.'/],
    ["foo.lock", /\.lock/],
    ["bad?", /invalid characters/i],
    ["bad\nthing", /space|control/i],
    ["bad\tthing", /space|control/i],
    ["bad\u0001thing", /control/i],
  ])("rejects %j", (name, pattern) => {
    expect(validateBranchName(name)).toMatch(pattern);
  });
});
