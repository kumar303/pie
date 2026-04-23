import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseExthostPidFromRendererLog,
  parseWorkspaceStorageIdFromExthostLog,
  parseWorkspaceFolderPath,
  findLatestSessionDir,
  resolveTsserverWorkspacePath,
} from "./vscode-workspace-index.ts";

describe("parseExthostPidFromRendererLog", () => {
  it("extracts the pid from 'Started local extension host with pid NNN.'", () => {
    const log = [
      "2026-04-23 15:20:28.400 [info] some other line",
      "2026-04-23 15:20:28.419 [info] Started local extension host with pid 23993.",
      "2026-04-23 15:20:28.500 [info] yet another",
    ].join("\n");
    expect(parseExthostPidFromRendererLog(log)).toBe(23993);
  });

  it("returns null when no match", () => {
    expect(parseExthostPidFromRendererLog("nothing here")).toBeNull();
  });
});

describe("parseWorkspaceStorageIdFromExthostLog", () => {
  it("extracts the 32-char MD5 after workspaceStorage/", () => {
    const log = [
      "2026-04-23 15:20:28.977 [info] Skipping acquiring lock for /Users/x/Library/Application Support/Code/User/workspaceStorage/9d54702b1eb78b63cd1e6ccc5e0fefd4.",
      "2026-04-23 15:20:29.561 [info] later line",
    ].join("\n");
    expect(parseWorkspaceStorageIdFromExthostLog(log)).toBe(
      "9d54702b1eb78b63cd1e6ccc5e0fefd4",
    );
  });

  it("returns null when no workspaceStorage reference is present", () => {
    expect(parseWorkspaceStorageIdFromExthostLog("hello world")).toBeNull();
  });

  it("only matches full 32-hex IDs", () => {
    // 31 chars should not match
    const log = "workspaceStorage/9d54702b1eb78b63cd1e6ccc5e0fed1 bogus";
    expect(parseWorkspaceStorageIdFromExthostLog(log)).toBeNull();
  });
});

describe("parseWorkspaceFolderPath", () => {
  it("decodes the folder URI into a filesystem path", () => {
    const json = JSON.stringify({
      folder: "file:///Users/kumar/src/github.com/kumar303/pie",
    });
    expect(parseWorkspaceFolderPath(json)).toBe(
      "/Users/kumar/src/github.com/kumar303/pie",
    );
  });

  it("URL-decodes percent escapes (e.g. spaces)", () => {
    const json = JSON.stringify({
      folder: "file:///Users/kumar/My%20Project",
    });
    expect(parseWorkspaceFolderPath(json)).toBe("/Users/kumar/My Project");
  });

  it("returns null when folder is not file://", () => {
    const json = JSON.stringify({ folder: "vscode-remote://ssh/foo" });
    expect(parseWorkspaceFolderPath(json)).toBeNull();
  });

  it("returns null for invalid json", () => {
    expect(parseWorkspaceFolderPath("{")).toBeNull();
  });

  it("returns null when folder field is absent", () => {
    expect(parseWorkspaceFolderPath(JSON.stringify({ other: "x" }))).toBeNull();
  });
});

describe("findLatestSessionDir + resolveTsserverWorkspacePath (integration)", () => {
  let root: string;
  let logsDir: string;
  let storageDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vscbc-test-"));
    logsDir = join(root, "logs");
    storageDir = join(root, "workspaceStorage");
    mkdirSync(logsDir);
    mkdirSync(storageDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("findLatestSessionDir returns the most recently modified session dir", async () => {
    // Name sort is unreliable: VS Code sometimes reuses an older-named
    // session dir on restart, so the fs mtime is authoritative.
    const older = join(logsDir, "20260422T211936");
    const newer = join(logsDir, "20260422T161310");
    mkdirSync(older);
    // Backdate `older` so `newer` wins by mtime.
    const { utimesSync } = await import("node:fs");
    utimesSync(older, new Date(2020, 0, 1), new Date(2020, 0, 1));
    mkdirSync(newer);
    mkdirSync(join(logsDir, "other"));
    expect(findLatestSessionDir(logsDir)).toBe(newer);
  });

  it("findLatestSessionDir returns null when none match", () => {
    mkdirSync(join(logsDir, "misc"));
    expect(findLatestSessionDir(logsDir)).toBeNull();
  });

  it("resolveTsserverWorkspacePath returns the workspace folder path end-to-end", () => {
    const session = join(logsDir, "20260422T161310");
    const win = join(session, "window9");
    mkdirSync(win, { recursive: true });
    mkdirSync(join(win, "exthost"), { recursive: true });
    writeFileSync(
      join(win, "renderer.log"),
      "2026-04-23 15:20:28.419 [info] Started local extension host with pid 23993.\n",
    );
    writeFileSync(
      join(win, "exthost", "exthost.log"),
      "2026-04-23 15:20:28.977 [info] Skipping acquiring lock for /tmp/workspaceStorage/9d54702b1eb78b63cd1e6ccc5e0fefd4.\n",
    );
    const md5Dir = join(storageDir, "9d54702b1eb78b63cd1e6ccc5e0fefd4");
    mkdirSync(md5Dir);
    writeFileSync(
      join(md5Dir, "workspace.json"),
      JSON.stringify({
        folder: "file:///Users/kumar/src/github.com/kumar303/pie",
      }),
    );

    const result = resolveTsserverWorkspacePath({
      exthostPid: 23993,
      logsRoot: logsDir,
      workspaceStorageRoot: storageDir,
    });
    expect(result).toBe("/Users/kumar/src/github.com/kumar303/pie");
  });

  it("resolveTsserverWorkspacePath returns null when no window matches", () => {
    const session = join(logsDir, "20260422T161310");
    mkdirSync(join(session, "window1"), { recursive: true });
    writeFileSync(
      join(session, "window1", "renderer.log"),
      "Started local extension host with pid 99999.\n",
    );
    expect(
      resolveTsserverWorkspacePath({
        exthostPid: 23993,
        logsRoot: logsDir,
        workspaceStorageRoot: storageDir,
      }),
    ).toBeNull();
  });

  it("resolveTsserverWorkspacePath returns null when workspace.json is missing", () => {
    const session = join(logsDir, "20260422T161310");
    const win = join(session, "window1");
    mkdirSync(join(win, "exthost"), { recursive: true });
    writeFileSync(
      join(win, "renderer.log"),
      "Started local extension host with pid 23993.\n",
    );
    writeFileSync(
      join(win, "exthost", "exthost.log"),
      "workspaceStorage/abcdef0123456789abcdef0123456789.\n",
    );
    expect(
      resolveTsserverWorkspacePath({
        exthostPid: 23993,
        logsRoot: logsDir,
        workspaceStorageRoot: storageDir,
      }),
    ).toBeNull();
  });
});
