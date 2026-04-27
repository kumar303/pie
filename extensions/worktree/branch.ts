/**
 * Validation for git branch names with the additional
 * constraint that the name has to be usable as a directory
 * name on disk (worktrees live in real filesystem paths).
 */

/**
 * Returns `null` when the branch name is acceptable, otherwise
 * a human-readable error string.
 *
 * Rules combine git's
 * (https://git-scm.com/docs/git-check-ref-format) restrictions
 * with filesystem safety: no spaces, no slashes-only-empty,
 * no path-traversal, etc.
 */
export function validateBranchName(name: string): string | null {
  if (!name) return "Branch name cannot be empty";
  if (name === "@") return "Branch name cannot be '@'";
  if (/\s/.test(name)) return "Branch name cannot contain spaces";
  if (/[~^:?*[\\]/.test(name))
    return "Branch name contains invalid characters (~, ^, :, ?, *, [, or \\)";
  // Reject control characters (incl. DEL).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name))
    return "Branch name cannot contain control characters";
  if (name.includes("..")) return "Branch name cannot contain '..'";
  if (name.includes("@{")) return "Branch name cannot contain '@{'";
  if (name.includes("//")) return "Branch name cannot contain '//'";
  if (name.startsWith("-")) return "Branch name cannot start with '-'";
  if (name.startsWith(".")) return "Branch name cannot start with '.'";
  if (name.startsWith("/")) return "Branch name cannot start with '/'";
  if (name.endsWith("/")) return "Branch name cannot end with '/'";
  if (name.endsWith(".")) return "Branch name cannot end with '.'";
  if (name.endsWith(".lock")) return "Branch name cannot end with '.lock'";
  return null;
}
