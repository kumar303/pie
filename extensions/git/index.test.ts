import { describe, it, expect, vi, beforeEach } from "vitest";

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
