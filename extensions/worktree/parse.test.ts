/**
 * Edge-case unit tests for argument parsing. Last-resort unit
 * tests covering the parse-result discriminant; the more
 * semantically interesting cases (real commands run end to
 * end) live in the integration suite.
 */

import { describe, it, expect } from "vitest";
import { parseWorktreeArgs } from "./parse.js";

describe("parseWorktreeArgs", () => {
  it("treats empty input as usage", () => {
    expect(parseWorktreeArgs("")).toEqual({ kind: "usage" });
    expect(parseWorktreeArgs("   ")).toEqual({ kind: "usage" });
  });

  it("treats `help` as usage", () => {
    expect(parseWorktreeArgs("help")).toEqual({ kind: "usage" });
    expect(parseWorktreeArgs("  help  ")).toEqual({ kind: "usage" });
  });

  it("returns config for `config`", () => {
    expect(parseWorktreeArgs("config")).toEqual({ kind: "config" });
  });

  it("parses add and remove", () => {
    expect(parseWorktreeArgs("add pie feat")).toEqual({
      kind: "add",
      repo: "pie",
      branch: "feat",
    });
    expect(parseWorktreeArgs("remove pie feat")).toEqual({
      kind: "remove",
      repo: "pie",
      branch: "feat",
    });
  });

  it("collapses extra whitespace", () => {
    expect(parseWorktreeArgs("  add   pie    feat ")).toEqual({
      kind: "add",
      repo: "pie",
      branch: "feat",
    });
  });

  it("rejects add/remove without enough args", () => {
    expect(parseWorktreeArgs("add")).toEqual({
      kind: "invalid",
      reason: expect.stringContaining("Usage: /worktree add"),
    });
    expect(parseWorktreeArgs("add pie")).toEqual({
      kind: "invalid",
      reason: expect.stringContaining("Usage: /worktree add"),
    });
    expect(parseWorktreeArgs("remove pie")).toEqual({
      kind: "invalid",
      reason: expect.stringContaining("Usage: /worktree remove"),
    });
  });

  it("rejects too many args", () => {
    const r = parseWorktreeArgs("add pie feat extra");
    expect(r.kind).toBe("invalid");
  });

  it("rejects an invalid branch name", () => {
    const r = parseWorktreeArgs("add pie bad..branch");
    expect(r).toEqual({
      kind: "invalid",
      reason: expect.stringMatching(/'\.\.'/),
    });
  });

  it("rejects unknown subcommands", () => {
    expect(parseWorktreeArgs("frob")).toEqual({
      kind: "invalid",
      reason: expect.stringContaining("Unknown subcommand"),
    });
  });
});
