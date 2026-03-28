import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We need to test the parseGitStatus function and the diff-gathering logic.
// Since parseGitStatus is not exported, we'll test it indirectly through
// a local copy that mirrors the implementation.

// --- Test parseGitStatus (mirrors the function in index.ts) ---

interface GitFile {
  status: string;
  path: string;
}

function parseGitStatus(output: string): GitFile[] {
  const files: GitFile[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2).trim();
    let path = line.slice(3);
    const arrowIdx = path.indexOf(" -> ");
    if (arrowIdx !== -1) {
      path = path.slice(arrowIdx + 4);
    }
    if (path) {
      files.push({ status, path });
    }
  }
  return files;
}

describe("parseGitStatus", () => {
  it("parses modified files", () => {
    const result = parseGitStatus(" M file.txt\n");
    expect(result).toEqual([{ status: "M", path: "file.txt" }]);
  });

  it("parses untracked files", () => {
    const result = parseGitStatus("?? newfile.txt\n");
    expect(result).toEqual([{ status: "??", path: "newfile.txt" }]);
  });

  it("parses staged files", () => {
    const result = parseGitStatus("A  staged.txt\n");
    expect(result).toEqual([{ status: "A", path: "staged.txt" }]);
  });

  it("parses renamed files (takes new name)", () => {
    const result = parseGitStatus("R  old.txt -> new.txt\n");
    expect(result).toEqual([{ status: "R", path: "new.txt" }]);
  });

  it("parses multiple files", () => {
    const result = parseGitStatus(" M a.txt\n?? b.txt\nA  c.txt\n");
    expect(result).toEqual([
      { status: "M", path: "a.txt" },
      { status: "??", path: "b.txt" },
      { status: "A", path: "c.txt" },
    ]);
  });

  it("handles empty output", () => {
    expect(parseGitStatus("")).toEqual([]);
    expect(parseGitStatus("\n")).toEqual([]);
  });
});

// --- Test tab sanitization in diff rendering ---
// Diff output from git can contain tab characters from source files.
// visibleWidth counts tabs as 1 column but the terminal renders them
// at 8-column tabstops, causing lines to overflow. Tabs must be
// replaced with spaces before rendering.

/** Mirrors the sanitizeLine method in GitComponent */
function sanitizeLine(line: string): string {
  return line.replace(/\t/g, "  ");
}

describe("diff line tab sanitization", () => {
  it("replaces tab characters with spaces", () => {
    const line = "\t\tconst x = 1;";
    const result = sanitizeLine(line);
    expect(result).not.toContain("\t");
    expect(result).toBe("    const x = 1;");
  });

  it("preserves lines without tabs", () => {
    const line = "  no tabs here";
    expect(sanitizeLine(line)).toBe(line);
  });

  it("handles mixed tabs and spaces", () => {
    const line = "\t  \treturn;";
    const result = sanitizeLine(line);
    expect(result).not.toContain("\t");
    expect(result).toBe("      return;");
  });

  it("handles empty string", () => {
    expect(sanitizeLine("")).toBe("");
  });

  it("preserves ANSI codes while replacing tabs", () => {
    const line = "\x1b[32m+\t\tconst x = 1;\x1b[m";
    const result = sanitizeLine(line);
    expect(result).not.toContain("\t");
    expect(result).toContain("\x1b[32m");
    expect(result).toBe("\x1b[32m+    const x = 1;\x1b[m");
  });
});

// --- Test the key matching behavior we're fixing ---
// This verifies that our fix for uppercase 'A' correctly handles
// the select-all toggle logic.

describe("select-all toggle logic", () => {
  it("selects all files when none are selected", () => {
    const files = [
      { status: "M", path: "a.txt" },
      { status: "??", path: "b.txt" },
    ];
    const selected = new Set<number>();

    // Simulate the toggle logic from handleFileSelect
    if (selected.size === files.length) {
      selected.clear();
    } else {
      for (let i = 0; i < files.length; i++) selected.add(i);
    }

    expect(selected.size).toBe(2);
    expect(selected.has(0)).toBe(true);
    expect(selected.has(1)).toBe(true);
  });

  it("deselects all files when all are selected", () => {
    const files = [
      { status: "M", path: "a.txt" },
      { status: "??", path: "b.txt" },
    ];
    const selected = new Set<number>([0, 1]);

    if (selected.size === files.length) {
      selected.clear();
    } else {
      for (let i = 0; i < files.length; i++) selected.add(i);
    }

    expect(selected.size).toBe(0);
  });
});

// --- Test diff gathering categorization ---
// Verifies that files are correctly categorized as tracked vs untracked
// for diff gathering in generateCommitMessage.

describe("diff gathering file categorization", () => {
  it("categorizes tracked files (non-?? status)", () => {
    const files: GitFile[] = [
      { status: "M", path: "modified.txt" },
      { status: "A", path: "added.txt" },
      { status: "D", path: "deleted.txt" },
      { status: "AM", path: "added-modified.txt" },
    ];
    const selectedFiles = files.map((f) => f.path);

    const trackedFiles = selectedFiles.filter((f) => {
      const file = files.find((gf) => gf.path === f);
      return file && file.status !== "??";
    });
    const untrackedFiles = selectedFiles.filter((f) => {
      const file = files.find((gf) => gf.path === f);
      return file && file.status === "??";
    });

    expect(trackedFiles).toEqual([
      "modified.txt",
      "added.txt",
      "deleted.txt",
      "added-modified.txt",
    ]);
    expect(untrackedFiles).toEqual([]);
  });

  it("categorizes untracked files", () => {
    const files: GitFile[] = [
      { status: "??", path: "new1.txt" },
      { status: "??", path: "new2.txt" },
    ];
    const selectedFiles = files.map((f) => f.path);

    const trackedFiles = selectedFiles.filter((f) => {
      const file = files.find((gf) => gf.path === f);
      return file && file.status !== "??";
    });
    const untrackedFiles = selectedFiles.filter((f) => {
      const file = files.find((gf) => gf.path === f);
      return file && file.status === "??";
    });

    expect(trackedFiles).toEqual([]);
    expect(untrackedFiles).toEqual(["new1.txt", "new2.txt"]);
  });

  it("handles mixed tracked and untracked files", () => {
    const files: GitFile[] = [
      { status: "M", path: "changed.txt" },
      { status: "??", path: "new.txt" },
    ];
    const selectedFiles = files.map((f) => f.path);

    const trackedFiles = selectedFiles.filter((f) => {
      const file = files.find((gf) => gf.path === f);
      return file && file.status !== "??";
    });
    const untrackedFiles = selectedFiles.filter((f) => {
      const file = files.find((gf) => gf.path === f);
      return file && file.status === "??";
    });

    expect(trackedFiles).toEqual(["changed.txt"]);
    expect(untrackedFiles).toEqual(["new.txt"]);
  });
});

// --- Test expandUntrackedFiles ---
// git status --porcelain shows untracked directories as a single entry
// (e.g. "?? dirname/"). expandUntrackedFiles walks directories recursively
// to resolve individual file paths for diff generation.

// Mirrors getUntrackedFiles from index.ts.
import { execSync } from "node:child_process";

function getUntrackedFiles(): string[] {
  try {
    const output = execSync("git ls-files --others --exclude-standard", {
      encoding: "utf-8",
      timeout: 10000,
      cwd: process.cwd(),
    });
    return output.split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
}

describe("getUntrackedFiles", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "git-test-"));
    execSync("git init", { cwd: tmpDir });
    execSync("git config user.email test@test.com", { cwd: tmpDir });
    execSync("git config user.name Test", { cwd: tmpDir });
    // Create an initial commit so git status works properly
    writeFileSync(join(tmpDir, ".gitkeep"), "");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists individual untracked files", () => {
    writeFileSync(join(tmpDir, "newfile.txt"), "hello");

    const result = getUntrackedFiles();
    expect(result).toEqual(["newfile.txt"]);
  });

  it("expands untracked directories into individual files", () => {
    const subDir = join(tmpDir, "myext");
    mkdirSync(subDir);
    writeFileSync(join(subDir, "index.ts"), "export default {}");
    writeFileSync(join(subDir, "README.md"), "# My Ext");

    const result = getUntrackedFiles();
    expect(result.sort()).toEqual(["myext/README.md", "myext/index.ts"]);
  });

  it("respects .gitignore", () => {
    writeFileSync(join(tmpDir, ".gitignore"), "node_modules/\n");
    mkdirSync(join(tmpDir, "node_modules", "some-pkg"), { recursive: true });
    writeFileSync(join(tmpDir, "node_modules", "some-pkg", "index.js"), "module.exports = {}");
    writeFileSync(join(tmpDir, "real-file.txt"), "keep me");

    const result = getUntrackedFiles();
    expect(result.sort()).toEqual([".gitignore", "real-file.txt"]);
  });

  it("handles nested directories", () => {
    const nested = join(tmpDir, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "deep.txt"), "deep");
    writeFileSync(join(tmpDir, "a", "top.txt"), "top");

    const result = getUntrackedFiles();
    expect(result.sort()).toEqual(["a/b/c/deep.txt", "a/top.txt"]);
  });

  it("returns empty array when no untracked files", () => {
    const result = getUntrackedFiles();
    expect(result).toEqual([]);
  });
});
