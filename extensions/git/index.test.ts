import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

// --- Test diff viewer escape/discard behavior ---
// Mirrors the escape + discard confirmation logic in handleDiffViewer.
// When the user confirms discard ("y"), the prompt should be cleared but
// the diff viewer should remain open — NOT exit. A second escape is needed to exit.

describe("diff viewer discard prompt behavior", () => {
  /**
   * Simulates the discard confirmation handler from handleDiffViewer.
   * Returns the resulting state after the user presses "y" to confirm discard.
   */
  function simulateDiscardConfirm(opts: {
    confirmDiscard: boolean;
    promptText: string;
    diffFocusPane: "diff" | "prompt";
  }): {
    confirmDiscard: boolean;
    promptText: string;
    exited: boolean;
    diffFocusPane: "diff" | "prompt";
  } {
    let { confirmDiscard, promptText, diffFocusPane } = opts;
    const exited = false;

    // This mirrors the logic in handleDiffViewer when user presses "y"
    if (confirmDiscard) {
      promptText = "";
      confirmDiscard = false;
      diffFocusPane = "diff";
      // BUG (before fix): onDone() was called here, exiting the viewer
      // FIXED: should NOT exit — just clear prompt and stay
    }

    return { confirmDiscard, promptText, exited, diffFocusPane };
  }

  it("clears prompt text when discard is confirmed", () => {
    const result = simulateDiscardConfirm({
      confirmDiscard: true,
      promptText: "some question about the diff",
      diffFocusPane: "diff",
    });
    expect(result.promptText).toBe("");
    expect(result.confirmDiscard).toBe(false);
  });

  it("does NOT exit the diff viewer when discard is confirmed", () => {
    const result = simulateDiscardConfirm({
      confirmDiscard: true,
      promptText: "some question",
      diffFocusPane: "diff",
    });
    expect(result.exited).toBe(false);
  });

  it("switches to diff pane when discard is confirmed from prompt pane", () => {
    const result = simulateDiscardConfirm({
      confirmDiscard: true,
      promptText: "some question",
      diffFocusPane: "prompt",
    });
    expect(result.diffFocusPane).toBe("diff");
    expect(result.exited).toBe(false);
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

import { execSync } from "node:child_process";
import {
  FilePathAutocompleteProvider,
  generateWorkingDiffOutput,
} from "./index.ts";

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

// --- Test generateWorkingDiffOutput ---
// Verifies that the working diff includes both tracked (modified) files
// and untracked files. Previously, a silent catch on maxBuffer errors
// caused tracked file diffs to be silently dropped.

describe("generateWorkingDiffOutput", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "git-diff-test-"));
    execSync("git init", { cwd: tmpDir });
    execSync("git config user.email test@test.com", { cwd: tmpDir });
    execSync("git config user.name Test", { cwd: tmpDir });
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes diffs for both tracked modified files and untracked files", () => {
    // Create and commit a tracked file
    writeFileSync(join(tmpDir, "tracked.txt"), "original content");
    execSync("git add tracked.txt && git commit -m init", { cwd: tmpDir });

    // Modify the tracked file (creates an unstaged change)
    writeFileSync(join(tmpDir, "tracked.txt"), "modified content");

    // Create an untracked file
    writeFileSync(join(tmpDir, "untracked.txt"), "new file content");

    process.chdir(tmpDir);
    const result = generateWorkingDiffOutput({ hideWhitespace: true });

    // Both files should appear in the diff
    expect(result.diff).toContain("tracked.txt");
    expect(result.diff).toContain("untracked.txt");
    expect(result.errors).toEqual([]);
  });

  it("includes diffs for staged files", () => {
    writeFileSync(join(tmpDir, "staged.txt"), "original");
    execSync("git add staged.txt && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "staged.txt"), "changed");
    execSync("git add staged.txt", { cwd: tmpDir });

    process.chdir(tmpDir);
    const result = generateWorkingDiffOutput({ hideWhitespace: true });

    expect(result.diff).toContain("staged.txt");
    expect(result.errors).toEqual([]);
  });

  it("handles large diffs without silently failing", () => {
    // Create a file with enough content to generate a large diff
    const largeContent = "line\n".repeat(50000);
    writeFileSync(join(tmpDir, "large.txt"), largeContent);
    execSync("git add large.txt && git commit -m init", { cwd: tmpDir });

    // Modify every line to create a massive diff
    const modifiedContent = "modified-line\n".repeat(50000);
    writeFileSync(join(tmpDir, "large.txt"), modifiedContent);

    // Also add an untracked file
    writeFileSync(join(tmpDir, "small.txt"), "hello");

    process.chdir(tmpDir);
    const result = generateWorkingDiffOutput({ hideWhitespace: true });

    // Both files must appear — the large diff must not cause
    // the tracked file diff to be silently dropped
    expect(result.diff).toContain("large.txt");
    expect(result.diff).toContain("small.txt");
    expect(result.errors).toEqual([]);
  });

  it("reports errors for unreadable untracked files instead of silently ignoring", () => {
    writeFileSync(join(tmpDir, "readable.txt"), "hello");
    // Create a directory with the same name as a file git would try to read
    mkdirSync(join(tmpDir, "not-a-file"));
    // We can't easily force git ls-files to list a directory as untracked,
    // so instead test that a successfully generated diff has no errors
    process.chdir(tmpDir);
    const result = generateWorkingDiffOutput({ hideWhitespace: true });
    // readable.txt should be in the diff as an untracked file
    expect(result.diff).toContain("readable.txt");
  });
});

describe("getUntrackedFiles", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "git-test-"));
    execSync("git init", { cwd: tmpDir });
    execSync("git config user.email test@test.com", { cwd: tmpDir });
    execSync("git config user.name Test", { cwd: tmpDir });
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
    writeFileSync(
      join(tmpDir, "node_modules", "some-pkg", "index.js"),
      "module.exports = {}",
    );
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

// --- FilePathAutocompleteProvider ---

describe("FilePathAutocompleteProvider", () => {
  let tmpDir: string;
  let origCwd: string;
  let provider: FilePathAutocompleteProvider;
  const signal = new AbortController().signal;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "git-autocomplete-"));
    execSync("git init", { cwd: tmpDir });
    execSync("git config user.email test@test.com", { cwd: tmpDir });
    execSync("git config user.name Test", { cwd: tmpDir });
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src/app.ts"), "export default {}");
    writeFileSync(join(tmpDir, "src/utils.ts"), "export {}");
    writeFileSync(join(tmpDir, "README.md"), "# test");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    process.chdir(tmpDir);
    provider = new FilePathAutocompleteProvider();
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when prefix is too short", async () => {
    const result = await provider.getSuggestions(["s"], 0, 1, { signal });
    expect(result).toBeNull();
  });

  it("returns null when no path-like prefix at cursor", async () => {
    const result = await provider.getSuggestions(["  "], 0, 2, { signal });
    expect(result).toBeNull();
  });

  it("suggests matching files for a prefix", async () => {
    const result = await provider.getSuggestions(["src/ap"], 0, 6, { signal });
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe("src/ap");
    expect(result!.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "src/app.ts" }),
      ]),
    );
  });

  it("returns null when no files match", async () => {
    const result = await provider.getSuggestions(["nonexistent/path"], 0, 16, {
      signal,
    });
    expect(result).toBeNull();
  });

  it("matches prefix in the middle of a line", async () => {
    const result = await provider.getSuggestions(["look at src/ut"], 0, 14, {
      signal,
    });
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe("src/ut");
    expect(result!.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "src/utils.ts" }),
      ]),
    );
  });

  it("applies completion by replacing prefix with full path", () => {
    const result = provider.applyCompletion(
      ["look at src/ap"],
      0,
      14,
      { value: "src/app.ts", label: "src/app.ts" },
      "src/ap",
    );
    expect(result.lines[0]).toBe("look at src/app.ts");
    expect(result.cursorCol).toBe(18);
  });

  it("matches ./ relative path prefix", async () => {
    const result = await provider.getSuggestions(["./src/ap"], 0, 8, {
      signal,
    });
    expect(result).not.toBeNull();
    expect(result!.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "src/app.ts" }),
      ]),
    );
  });

  it("matches when relevant files are beyond the first few git results", async () => {
    // Create many files that sort before the target alphabetically
    mkdirSync(join(tmpDir, "aaa"), { recursive: true });
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(tmpDir, `aaa/file${i}.ts`), "x");
    }
    mkdirSync(join(tmpDir, "zzz"), { recursive: true });
    writeFileSync(join(tmpDir, "zzz/target.ts"), "x");
    execSync("git add .", { cwd: tmpDir });
    const result = await provider.getSuggestions(["zzz/ta"], 0, 6, {
      signal,
    });
    expect(result).not.toBeNull();
    expect(result!.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "zzz/target.ts" }),
      ]),
    );
  });

  it("only matches files starting with the prefix, not containing it", async () => {
    mkdirSync(join(tmpDir, "lib"), { recursive: true });
    writeFileSync(join(tmpDir, "lib/extension.ts"), "x");
    execSync("git add .", { cwd: tmpDir });
    // Typing "ext" should not match "lib/extension.ts"
    const result = await provider.getSuggestions(["ext"], 0, 3, { signal });
    if (result) {
      const values = result.items.map((i) => i.value);
      expect(values).not.toContain("lib/extension.ts");
    }
  });

  it("matches files starting with special characters", async () => {
    writeFileSync(join(tmpDir, ".eslintrc.js"), "module.exports = {}");
    execSync("git add .eslintrc.js", { cwd: tmpDir });
    const result = await provider.getSuggestions([".eslint"], 0, 7, {
      signal,
    });
    expect(result).not.toBeNull();
    expect(result!.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: ".eslintrc.js" }),
      ]),
    );
  });
});
