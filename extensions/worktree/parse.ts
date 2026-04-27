/**
 * Slash-command argument parsing for `/worktree`.
 */

import { validateBranchName } from "./branch.js";

export type WorktreeParseResult =
  | { kind: "usage" }
  | { kind: "config" }
  | { kind: "add"; repo: string; branch: string }
  | { kind: "remove"; repo: string; branch: string }
  | { kind: "invalid"; reason: string };

export function parseWorktreeArgs(input: string): WorktreeParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "usage" };
  if (trimmed === "help") return { kind: "usage" };
  if (trimmed === "config") return { kind: "config" };

  const parts = trimmed.split(/\s+/);
  const sub = parts[0];

  if (sub === "add" || sub === "remove") {
    if (parts.length < 3) {
      return {
        kind: "invalid",
        reason: `Usage: /worktree ${sub} <repo> <branch>`,
      };
    }
    if (parts.length > 3) {
      return {
        kind: "invalid",
        reason: `Usage: /worktree ${sub} <repo> <branch> (got extra arguments)`,
      };
    }
    const [, repo, branch] = parts;
    const branchError = validateBranchName(branch);
    if (branchError) return { kind: "invalid", reason: branchError };
    return { kind: sub, repo, branch };
  }

  return {
    kind: "invalid",
    reason: `Unknown subcommand: ${sub}. See /worktree help.`,
  };
}

/** Subcommands available for autocompletion. */
export const SUBCOMMANDS = ["help", "config", "add", "remove"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];
