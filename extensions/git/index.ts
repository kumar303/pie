/**
 * Git Interactive Extension
 *
 * Invoke with `/git`. Runs `git status` and shows an interactive UI where you can:
 * - Navigate files with arrow keys
 * - Press Tab to select/deselect multiple files
 * - Press Enter to go to a command textbox with placeholder `git {}`
 * - Type a git command; `{}` is replaced with selected filenames
 * - See a live preview of the expanded command below the textbox
 * - Press Up arrow in the command textbox to recall previous commands
 * - Press Enter to execute the command
 *
 * All errors are reported via notifications.
 */

import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { complete, type UserMessage } from "@mariozechner/pi-ai";
import {
  decodeKittyPrintable,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@mariozechner/pi-tui";

// --- History persistence ---

const HISTORY_DIR = join(homedir(), ".pi", "agent");
const HISTORY_FILE = join(HISTORY_DIR, "git-command-history.json");
const MAX_HISTORY = 100;

function loadHistory(): string[] {
  try {
    if (existsSync(HISTORY_FILE)) {
      const data = JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
      if (Array.isArray(data)) return data.slice(-MAX_HISTORY);
    }
  } catch {}
  return [];
}

function saveHistory(history: string[]): void {
  try {
    mkdirSync(HISTORY_DIR, { recursive: true });
    writeFileSync(
      HISTORY_FILE,
      JSON.stringify(history.slice(-MAX_HISTORY)),
      "utf-8",
    );
  } catch {}
}

// --- Parse git status output ---

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

function statusLabel(status: string): string {
  switch (status) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "??":
      return "untracked";
    case "!!":
      return "ignored";
    case "AM":
      return "added+modified";
    case "MM":
      return "modified²";
    default:
      return status;
  }
}

// --- Untracked file resolution ---

/**
 * Get all untracked files using git, respecting .gitignore.
 * Uses `git ls-files --others --exclude-standard` which is fast
 * (skips ignored directories like node_modules/) and returns
 * individual file paths even for untracked directories.
 */
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

// --- UI State Machine ---

type Phase =
  | "select-files"
  | "enter-command"
  | "result"
  | "diff-viewer"
  | "branch-status";

// --- Main Component ---

class GitComponent implements Component {
  private files: GitFile[];
  private selected: Set<number> = new Set();
  private cursor = 0;
  private scrollOffset = 0;
  private phase: Phase = "select-files";

  // Command text input (self-managed)
  private cmdPrefix = ""; // preceding commands (e.g. "git add ... &&\n"), user cannot edit
  private cmdText = "";
  private cmdCursor = 0;
  private commandHistory: string[];
  private historyIndex = -1;
  private savedDraft = "";

  // Result display
  private resultText = "";
  private resultIsError = false;

  // Branch name
  private branch = "";

  // Commit message generation
  private generatingCommitMsg = false;

  // Diff viewer
  private diffLines: string[] = [];
  private diffScrollOffset = 0;
  private diffFileIndex: { line: number; name: string }[] = []; // file boundaries in diff

  // Filtered diff (active view, respects hideTests toggle)
  private activeDiffLines: string[] = [];
  private activeDiffFileIndex: { line: number; name: string }[] = [];
  private hideTests = false;
  private hideWhitespace = true;
  private hiddenFiles: Set<string> = new Set();
  private diffMode: "working" | "branch" = "working";
  private branchFiles: { path: string; status: string }[] = [];
  private branchBaseName = "";
  private branchStatusLoading = false;
  private showLoadingHint = false;
  private forkPointChild: ReturnType<typeof spawn> | null = null;
  private loadingHintTimer: ReturnType<typeof setTimeout> | null = null;
  private cachedForkPoint: { commit: string; name: string } | null | undefined =
    undefined;
  private disposed = false;

  // Diff viewer prompt pane (split view)
  private diffFocusPane: "diff" | "prompt" = "diff";
  private promptText = "";
  private promptCursor = 0;
  private promptScrollOffset = 0;
  private confirmDiscard = false; // "discard prompt?" y/n confirmation

  // TUI
  private tui: { requestRender: () => void };
  private theme: any;
  private onDone: (promptText?: string) => void;
  private sendPrompt: (text: string) => void;
  private ctx: ExtensionCommandContext;

  // Prompt pane layout (set during render, used by input handlers)
  private promptContentWidth = 0;

  // Caching
  private cachedLines?: string[];
  private cachedWidth?: number;

  constructor(
    files: GitFile[],
    tui: { requestRender: () => void },
    theme: any,
    onDone: (promptText?: string) => void,
    sendPrompt: (text: string) => void,
    ctx: ExtensionCommandContext,
  ) {
    this.files = files;
    this.tui = tui;
    this.theme = theme;
    this.onDone = onDone;
    this.sendPrompt = sendPrompt;
    this.ctx = ctx;
    this.commandHistory = loadHistory();
    this.branch = this.getBranch();

    if (files.length === 0) {
      this.phase = "branch-status";
      this.branchStatusLoading = true;
      this.loadBranchStatusAsync();
    }
  }

  private getBranch(): string {
    try {
      return execSync("git branch --show-current", {
        encoding: "utf-8",
        timeout: 5000,
        cwd: process.cwd(),
      }).trim();
    } catch {
      return "";
    }
  }

  private getRepoRoot(): string {
    try {
      return execSync("git rev-parse --show-toplevel", {
        encoding: "utf-8",
        timeout: 5000,
        cwd: process.cwd(),
      }).trim();
    } catch {
      return process.cwd();
    }
  }

  /**
   * Detect the base (default) branch for the repository.
   * Tries: origin/HEAD symref → existence of main/master branches.
   */
  /**
   * Find the fork-point commit where the current branch diverged.
   * Walks `git log --decorate` looking for the first commit that belongs to
   * another branch (e.g. origin/main), which is the branching point.
   * Returns { commit, name } or null if it can't be determined.
   */
  /** Parse git log output to find the fork point commit. */
  private parseForkPointFromLog(
    log: string,
  ): { commit: string; name: string } | null {
    const currentBranch = this.branch || "";
    for (const line of log.split("\n")) {
      if (!line.trim()) continue;
      const commit = line.slice(0, 40);
      const decoMatch = line.match(/\((.+)\)/);
      if (!decoMatch) continue;
      // Parse decorations like "origin/main, origin/HEAD"
      const refs = decoMatch[1].split(",").map((r) => r.trim());
      for (const ref of refs) {
        // Skip the remote tracking ref for the current branch itself
        if (currentBranch && ref === `origin/${currentBranch}`) continue;
        // Any other remote ref means we've found the fork point
        if (ref.startsWith("origin/")) {
          return { commit, name: ref };
        }
      }
    }
    return null;
  }

  private getForkPoint(): { commit: string; name: string } | null {
    if (this.cachedForkPoint !== undefined) {
      return this.cachedForkPoint;
    }
    try {
      const log = execSync(
        "git log --format=%H%d --decorate=short --decorate-refs=refs/remotes/ --first-parent -n 1000",
        {
          encoding: "utf-8",
          timeout: 10000,
          maxBuffer: 10 * 1024 * 1024,
          cwd: process.cwd(),
        },
      );
      const result = this.parseForkPointFromLog(log);
      this.cachedForkPoint = result;
      return result;
    } catch (err: any) {
      this.ctx.ui.notify(
        `git log failed: ${err.stderr?.trim() || err.message}`,
        "error",
      );
    }
    this.cachedForkPoint = null;
    return null;
  }

  /** Non-blocking fork point detection using spawn. */
  private getForkPointAsync(): Promise<{
    commit: string;
    name: string;
  } | null> {
    if (this.cachedForkPoint !== undefined) {
      return Promise.resolve(this.cachedForkPoint);
    }

    return new Promise((resolve) => {
      const child = spawn(
        "git",
        [
          "log",
          "--format=%H%d",
          "--decorate=short",
          "--decorate-refs=refs/remotes/",
          "--first-parent",
          "-n",
          "1000",
        ],
        {
          cwd: process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      this.forkPointChild = child;

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const killTimer = setTimeout(() => {
        child.kill();
        this.cachedForkPoint = null;
        resolve(null);
      }, 10000);

      child.on("close", (code) => {
        clearTimeout(killTimer);
        this.forkPointChild = null;

        if (code !== 0 && code !== null) {
          if (!this.disposed) {
            this.ctx.ui.notify(`git log failed: ${stderr.trim()}`, "error");
          }
          this.cachedForkPoint = null;
          resolve(null);
          return;
        }

        const result = this.parseForkPointFromLog(stdout);
        this.cachedForkPoint = result;
        resolve(result);
      });

      child.on("error", (err) => {
        clearTimeout(killTimer);
        this.forkPointChild = null;
        if (!this.disposed) {
          this.ctx.ui.notify(`git log failed: ${err.message}`, "error");
        }
        this.cachedForkPoint = null;
        resolve(null);
      });
    });
  }

  private getSelectedFiles(): string[] {
    return [...this.selected].sort().map((i) => this.files[i].path);
  }

  /** Build a command prefix to `git add` any selected untracked files. */
  private buildUntrackedPrefix(): string {
    const untrackedSelected = this.getSelectedFiles().filter((f) => {
      const file = this.files.find((gf) => gf.path === f);
      return file && file.status === "??";
    });
    if (untrackedSelected.length === 0) return "";
    const quoted = untrackedSelected
      .map((f) => `"${f.replace(/"/g, '\\"')}"`)
      .join(" ");
    return `git add ${quoted} &&\\\n`;
  }

  private async generateCommitMessage(): Promise<void> {
    if (!this.ctx.model) {
      this.ctx.ui.notify(
        "No model selected — cannot generate commit message",
        "error",
      );
      return;
    }

    // Ensure files are selected (auto-select cursor if none)
    if (this.selected.size === 0) {
      this.selected.add(this.cursor);
    }

    const selectedFiles = this.getSelectedFiles();

    // Gather diff for tracked files and content for untracked (selected) files
    let diffParts: string[] = [];
    const diffErrors: string[] = [];

    // Staged + unstaged diff for tracked selected files
    const trackedFiles = selectedFiles.filter((f) => {
      const file = this.files.find((gf) => gf.path === f);
      return file && file.status !== "??";
    });
    const untrackedSelectedPaths = selectedFiles.filter((f) => {
      const file = this.files.find((gf) => gf.path === f);
      return file && file.status === "??";
    });
    // Resolve selected untracked paths (which may be directories) to individual files
    const allUntracked = getUntrackedFiles();
    const untrackedFiles = allUntracked.filter((f) =>
      untrackedSelectedPaths.some((sel) => f === sel || f.startsWith(sel)),
    );

    if (trackedFiles.length > 0) {
      const quotedTracked = trackedFiles
        .map((f) => `"${f.replace(/"/g, '\\"')}"`)
        .join(" ");
      // Get both staged and unstaged diffs
      try {
        const staged = execSync(`git diff --cached -- ${quotedTracked}`, {
          encoding: "utf-8",
          timeout: 10000,
          cwd: process.cwd(),
        }).trim();
        if (staged) diffParts.push(staged);
      } catch (err: any) {
        diffErrors.push(
          `git diff --cached failed: ${err.stderr?.trim() || err.message}`,
        );
      }
      try {
        const unstaged = execSync(`git diff -- ${quotedTracked}`, {
          encoding: "utf-8",
          timeout: 10000,
          cwd: process.cwd(),
        }).trim();
        if (unstaged) diffParts.push(unstaged);
      } catch (err: any) {
        diffErrors.push(
          `git diff failed: ${err.stderr?.trim() || err.message}`,
        );
      }
    }

    // For untracked files, show their content as a pseudo-diff
    for (const f of untrackedFiles) {
      try {
        const content = readFileSync(f, "utf-8");
        const lines = content
          .split("\n")
          .map((l) => `+${l}`)
          .join("\n");
        diffParts.push(
          `diff --git a/${f} b/${f}\nnew file\n--- /dev/null\n+++ b/${f}\n${lines}`,
        );
      } catch (err: any) {
        diffErrors.push(`Failed to read ${f}: ${err.message}`);
      }
    }

    if (diffParts.length === 0) {
      const detail =
        diffErrors.length > 0
          ? `No diff found for selected files (${diffErrors.join("; ")})`
          : `No diff found for ${selectedFiles.length} selected file(s)`;
      this.ctx.ui.notify(detail, "error");
      return;
    }

    // Truncate diff to avoid blowing context
    let diff = diffParts.join("\n");
    const MAX_DIFF_CHARS = 20000;
    if (diff.length > MAX_DIFF_CHARS) {
      diff = diff.slice(0, MAX_DIFF_CHARS) + "\n... (diff truncated)";
    }

    this.generatingCommitMsg = true;
    this.invalidate();
    this.tui.requestRender();

    try {
      const auth = await this.ctx.modelRegistry.getApiKeyAndHeaders(
        this.ctx.model,
      );
      if (!auth.ok) throw new Error((auth as { error: string }).error);
      const userMessage: UserMessage = {
        role: "user",
        content: [
          {
            type: "text",
            text: `Here is the git diff for the files being committed:\n\n${diff}`,
          },
        ],
        timestamp: Date.now(),
      };

      const response = await complete(
        this.ctx.model,
        {
          systemPrompt:
            "You are a commit message generator. Given a git diff, write a single-line commit message. " +
            "Output ONLY the commit message text — no quotes, no prefixes, no explanation, no body, no bullet points. " +
            "The entire message must be one line, max 72 characters. " +
            "Use conventional commit style (e.g. feat:, fix:, refactor:, docs:, chore:) when appropriate. " +
            "IMPORTANT: Your output must NEVER contain the literal string '{}'. Avoid curly braces entirely.",
          messages: [userMessage],
        },
        { apiKey: auth.apiKey, headers: auth.headers },
      );

      const commitMsg = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim()
        // Strip any {} that might have slipped through
        .replace(/\{\}/g, "");

      if (!commitMsg) {
        this.ctx.ui.notify("LLM returned empty commit message", "error");
        this.generatingCommitMsg = false;
        this.invalidate();
        this.tui.requestRender();
        return;
      }

      // Collapse to single line (the command input is single-line) and escape for shell
      const singleLine = commitMsg
        .replace(/\r?\n/g, " ")
        .replace(/\s{2,}/g, " ");
      const escapedMsg = singleLine.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const cmd = `git commit -m "${escapedMsg}" {}`;
      this.cmdPrefix = this.buildUntrackedPrefix();
      this.phase = "enter-command";
      this.cmdSetValue(cmd, cmd.length); // cursor at end so user can review
      this.historyIndex = -1;
      this.savedDraft = cmd;
    } catch (err: any) {
      this.ctx.ui.notify(
        `Commit message generation failed: ${err.message || "Unknown error"}`,
        "error",
      );
    }

    this.generatingCommitMsg = false;
    this.invalidate();
    this.tui.requestRender();
  }

  private expandCommand(template: string): string {
    const files = this.getSelectedFiles();
    const quoted = files.map((f) => `"${f.replace(/"/g, '\\"')}"`).join(" ");
    return template.replace(/\{\}/g, quoted);
  }

  /** Return the full command string (prefix + user command) with {} expanded. */
  private getFullExpandedCommand(): string {
    const expandedCmd = this.expandCommand(this.cmdText);
    if (!this.cmdPrefix) return expandedCmd;
    return this.cmdPrefix + expandedCmd;
  }

  /**
   * Check if a command would require an interactive terminal (e.g. opening $EDITOR).
   * These commands can't run with piped stdio and would hang the UI.
   */
  private isInteractiveCommand(cmd: string): string | null {
    // Normalize: collapse whitespace, strip leading env vars
    const normalized = cmd.replace(/\s+/g, " ").trim();

    // git commit without -m / --message / -F / --file (opens $EDITOR)
    if (
      /\bgit\s+commit\b/.test(normalized) &&
      !/\s-m\s|\s--message[\s=]|\s-F\s|\s--file[\s=]|\s--allow-empty-message\b/.test(
        normalized,
      )
    ) {
      return "git commit opens $EDITOR which requires an interactive terminal. Use -m \"message\" instead, or use the 'c' shortcut to generate a commit message.";
    }

    // git rebase -i / --interactive
    if (
      /\bgit\s+rebase\b/.test(normalized) &&
      /\s-i\b|\s--interactive\b/.test(normalized)
    ) {
      return "Interactive rebase opens $EDITOR which requires an interactive terminal.";
    }

    // git merge/tag without -m (may open $EDITOR)
    if (
      /\bgit\s+(merge|tag)\b/.test(normalized) &&
      !/\s-m\s|\s--message[\s=]/.test(normalized) &&
      !/--no-edit\b/.test(normalized)
    ) {
      return `This command may open $EDITOR. Add -m "message" or --no-edit to run non-interactively.`;
    }

    return null;
  }

  private executeCommand(): void {
    const template = this.cmdText.trim();
    if (!template) return;

    const expanded = this.getFullExpandedCommand();

    // Block commands that need an interactive terminal
    const interactiveWarning = this.isInteractiveCommand(expanded);
    if (interactiveWarning) {
      this.resultText = interactiveWarning;
      this.resultIsError = true;
      this.phase = "result";
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Save user command to history (dedup); prefix is regenerated from selection
    const idx = this.commandHistory.indexOf(template);
    if (idx !== -1) this.commandHistory.splice(idx, 1);
    this.commandHistory.push(template);
    saveHistory(this.commandHistory);

    try {
      const output = execSync(expanded, {
        encoding: "utf-8",
        timeout: 30000,
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.resultText = output.trim() || "(no output)";
      this.resultIsError = false;
    } catch (err: any) {
      if (err.killed && err.signal === "SIGTERM") {
        this.resultText = "Command timed out after 30 seconds.";
      } else {
        this.resultText =
          err.stderr?.trim() ||
          err.stdout?.trim() ||
          err.message ||
          "Unknown error";
      }
      this.resultIsError = true;
    }

    if (!this.resultIsError) {
      // Success: show output via notification and exit back to pi prompt
      if (this.resultText && this.resultText !== "(no output)") {
        this.ctx.ui.notify(this.resultText, "info");
      }
      this.onDone();
      return;
    }

    this.phase = "result";
    this.historyIndex = -1;
    this.invalidate();
    this.tui.requestRender();
  }

  // Map for shift+key → character (symbols produced by shift+number etc.)
  /**
   * Extract a printable character from raw input data.
   * Uses decodeKittyPrintable for Kitty protocol (handles shift+symbols
   * like `:` correctly), then falls back to raw single-byte printable.
   */
  private dataToPrintable(rawData: string): string | undefined {
    // Kitty protocol: decode shifted characters (e.g. shift+; → :)
    const kittyChar = decodeKittyPrintable(rawData);
    if (kittyChar) return kittyChar;

    // Legacy terminal: raw single printable byte
    if (rawData.length === 1) {
      const code = rawData.charCodeAt(0);
      if (code >= 32 && code <= 126) return rawData;
    }

    return undefined;
  }

  // --- Command text input helpers ---

  private cmdInsert(ch: string): void {
    this.cmdText =
      this.cmdText.slice(0, this.cmdCursor) +
      ch +
      this.cmdText.slice(this.cmdCursor);
    this.cmdCursor += ch.length;
  }

  private cmdBackspace(): void {
    if (this.cmdCursor > 0) {
      this.cmdText =
        this.cmdText.slice(0, this.cmdCursor - 1) +
        this.cmdText.slice(this.cmdCursor);
      this.cmdCursor--;
    }
  }

  private cmdDelete(): void {
    if (this.cmdCursor < this.cmdText.length) {
      this.cmdText =
        this.cmdText.slice(0, this.cmdCursor) +
        this.cmdText.slice(this.cmdCursor + 1);
    }
  }

  private cmdSetValue(value: string, cursorPos?: number): void {
    this.cmdText = value;
    this.cmdCursor = cursorPos !== undefined ? cursorPos : value.length;
  }

  /** Find the start of the previous word boundary (for Option+Left / word-backward). */
  private wordBoundaryLeft(pos: number): number {
    let i = pos;
    // Skip whitespace to the left
    while (i > 0 && /\s/.test(this.cmdText[i - 1])) i--;
    // Skip word chars to the left
    while (i > 0 && /\S/.test(this.cmdText[i - 1])) i--;
    return i;
  }

  /** Find the end of the next word boundary (for Option+Right / word-forward). */
  private wordBoundaryRight(pos: number): number {
    let i = pos;
    const len = this.cmdText.length;
    // Skip whitespace to the right
    while (i < len && /\s/.test(this.cmdText[i])) i++;
    // Skip word chars to the right
    while (i < len && /\S/.test(this.cmdText[i])) i++;
    return i;
  }

  // --- Input handling ---

  handleInput(data: string): void {
    if (this.phase === "select-files") {
      this.handleFileSelect(data);
    } else if (this.phase === "enter-command") {
      this.handleCommandInput(data);
    } else if (this.phase === "result") {
      this.handleResult(data);
    } else if (this.phase === "diff-viewer") {
      this.handleDiffViewer(data);
    } else if (this.phase === "branch-status") {
      this.handleBranchStatus(data);
    }
  }

  private handleFileSelect(data: string): void {
    // Block all input while generating commit message (except escape)
    if (this.generatingCommitMsg) {
      if (matchesKey(data, Key.escape)) {
        this.onDone();
      }
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.onDone();
      return;
    }
    if (matchesKey(data, Key.up)) {
      if (this.cursor > 0) this.cursor--;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (this.cursor < this.files.length - 1) this.cursor++;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      if (this.selected.has(this.cursor)) {
        this.selected.delete(this.cursor);
      } else {
        this.selected.add(this.cursor);
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.selected.size === 0) {
        this.selected.add(this.cursor);
      }
      this.cmdPrefix = this.buildUntrackedPrefix();
      this.phase = "enter-command";
      this.cmdSetValue("git {}", 4); // cursor just before {}
      this.historyIndex = -1;
      this.savedDraft = "git {}";
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    // 'a' to select/deselect all
    if (matchesKey(data, "a")) {
      if (this.selected.size === this.files.length) {
        this.selected.clear();
      } else {
        for (let i = 0; i < this.files.length; i++) this.selected.add(i);
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    // 'u' to unselect all
    if (matchesKey(data, "u")) {
      this.selected.clear();
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    // 'c' to generate commit message and enter command mode
    if (matchesKey(data, "c")) {
      if (this.generatingCommitMsg) return; // prevent double-fire
      this.generateCommitMessage();
      return;
    }
    // 'd' to show full diff of all changes
    if (matchesKey(data, "d")) {
      this.openDiffViewer();
      return;
    }
    // 'b' to show branch diff (all commits compared to base branch)
    if (matchesKey(data, "b")) {
      this.openBranchDiffViewer();
      return;
    }
  }

  private handleBranchStatus(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      this.cancelLoading();
      this.onDone();
      return;
    }
    if (this.branchStatusLoading) return; // ignore other input while loading
    if (matchesKey(data, "b")) {
      this.openBranchDiffViewer();
      return;
    }
    // j/k or arrow keys to scroll
    if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
      if (this.cursor < this.branchFiles.length - 1) {
        this.cursor++;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
      if (this.cursor > 0) {
        this.cursor--;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }
  }

  private handleCommandInput(data: string): void {
    // Escape → back to file selection
    if (matchesKey(data, Key.escape)) {
      this.phase = "select-files";
      this.cmdPrefix = "";
      this.historyIndex = -1;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Enter → execute
    if (matchesKey(data, Key.enter)) {
      this.executeCommand();
      return;
    }

    // Up arrow → history
    if (matchesKey(data, Key.up)) {
      if (this.commandHistory.length === 0) return;
      if (this.historyIndex === -1) {
        this.savedDraft = this.cmdText;
        this.historyIndex = this.commandHistory.length - 1;
      } else if (this.historyIndex > 0) {
        this.historyIndex--;
      }
      this.cmdSetValue(this.commandHistory[this.historyIndex]);
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Down arrow → history forward
    if (matchesKey(data, Key.down)) {
      if (this.historyIndex === -1) return;
      if (this.historyIndex < this.commandHistory.length - 1) {
        this.historyIndex++;
        this.cmdSetValue(this.commandHistory[this.historyIndex]);
      } else {
        this.historyIndex = -1;
        this.cmdSetValue(this.savedDraft);
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Alt+Left / Option+Left → word backward
    if (matchesKey(data, Key.alt("left"))) {
      this.cmdCursor = this.wordBoundaryLeft(this.cmdCursor);
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Alt+Right / Option+Right → word forward
    if (matchesKey(data, Key.alt("right"))) {
      this.cmdCursor = this.wordBoundaryRight(this.cmdCursor);
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Left arrow
    if (matchesKey(data, Key.left)) {
      if (this.cmdCursor > 0) this.cmdCursor--;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Right arrow
    if (matchesKey(data, Key.right)) {
      if (this.cmdCursor < this.cmdText.length) this.cmdCursor++;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Home / Cmd+Left
    if (matchesKey(data, Key.home) || matchesKey(data, Key.ctrl("a"))) {
      this.cmdCursor = 0;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // End / Cmd+Right
    if (matchesKey(data, Key.end) || matchesKey(data, Key.ctrl("e"))) {
      this.cmdCursor = this.cmdText.length;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Backspace
    if (matchesKey(data, Key.backspace)) {
      this.cmdBackspace();
      this.historyIndex = -1;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Delete
    if (matchesKey(data, Key.delete)) {
      this.cmdDelete();
      this.historyIndex = -1;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Kill to end of line (Ctrl+K)
    if (matchesKey(data, Key.ctrl("k"))) {
      this.cmdText = this.cmdText.slice(0, this.cmdCursor);
      this.historyIndex = -1;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Kill to start of line (Ctrl+U)
    if (matchesKey(data, Key.ctrl("u"))) {
      this.cmdText = this.cmdText.slice(this.cmdCursor);
      this.cmdCursor = 0;
      this.historyIndex = -1;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Delete word backward (Alt+Backspace / Alt+Delete / Ctrl+W)
    if (
      matchesKey(data, Key.alt("backspace")) ||
      matchesKey(data, Key.alt("delete")) ||
      matchesKey(data, Key.ctrl("w"))
    ) {
      const newPos = this.wordBoundaryLeft(this.cmdCursor);
      this.cmdText =
        this.cmdText.slice(0, newPos) + this.cmdText.slice(this.cmdCursor);
      this.cmdCursor = newPos;
      this.historyIndex = -1;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Bracketed paste: terminal wraps pasted content in \x1b[200~ ... \x1b[201~
    if (data.includes("\x1b[200~")) {
      const pasteContent = data
        .replace(/\x1b\[200~/g, "")
        .replace(/\x1b\[201~/g, "");
      if (pasteContent) {
        // Command input is single-line, strip newlines
        const cleaned = pasteContent.replace(/\r?\n/g, " ");
        this.cmdInsert(cleaned);
        this.historyIndex = -1;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    // Printable character input
    const ch = this.dataToPrintable(data);
    if (ch) {
      this.cmdInsert(ch);
      this.historyIndex = -1;
      this.invalidate();
      this.tui.requestRender();
    }
  }

  private handleResult(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
      this.refreshStatus();
      return;
    }
  }

  /** Recompute activeDiffLines/activeDiffFileIndex based on hideTests toggle and manually hidden files. */
  private recomputeActiveDiff(): void {
    if (
      (!this.hideTests && this.hiddenFiles.size === 0) ||
      this.diffFileIndex.length === 0
    ) {
      this.activeDiffLines = this.diffLines;
      this.activeDiffFileIndex = this.diffFileIndex;
      return;
    }

    // Build sections: each file runs from its header line to the line before the next file
    const sections: { name: string; startLine: number; endLine: number }[] = [];
    for (let i = 0; i < this.diffFileIndex.length; i++) {
      const start = this.diffFileIndex[i].line;
      const end =
        i + 1 < this.diffFileIndex.length
          ? this.diffFileIndex[i + 1].line
          : this.diffLines.length;
      sections.push({
        name: this.diffFileIndex[i].name,
        startLine: start,
        endLine: end,
      });
    }

    // Include any preamble lines before the first file header
    const filteredLines: string[] = [];
    const filteredFileIndex: { line: number; name: string }[] = [];

    const firstFileStart =
      sections.length > 0 ? sections[0].startLine : this.diffLines.length;
    for (let i = 0; i < firstFileStart; i++) {
      filteredLines.push(this.diffLines[i]);
    }

    const testPattern = /test/i;
    for (const section of sections) {
      // Skip test files when hideTests is active
      if (this.hideTests && testPattern.test(section.name)) continue;
      // Skip manually hidden files
      if (this.hiddenFiles.has(section.name)) continue;
      filteredFileIndex.push({
        line: filteredLines.length,
        name: section.name,
      });
      for (let i = section.startLine; i < section.endLine; i++) {
        filteredLines.push(this.diffLines[i]);
      }
    }

    this.activeDiffLines = filteredLines;
    this.activeDiffFileIndex = filteredFileIndex;
  }

  /** Set up diff viewer state from raw diff output and switch to diff phase. */
  private showDiff(diffOutput: string, emptyMessage: string): void {
    if (!diffOutput.trim()) {
      this.ctx.ui.notify(emptyMessage, "info");
      return;
    }

    this.diffLines = diffOutput.split("\n");
    this.diffScrollOffset = 0;
    this.diffFocusPane = "diff";
    this.promptScrollOffset = 0;
    this.confirmDiscard = false;

    // Build file index from diff output - parse "diff --git a/... b/..." lines
    // Strip ANSI codes for matching since diff output is colorized
    this.diffFileIndex = [];
    for (let i = 0; i < this.diffLines.length; i++) {
      const stripped = this.diffLines[i].replace(/\x1b\[[0-9;]*m/g, "");
      const match = stripped.match(/^diff --git a\/(.+?) b\/(.+)/);
      if (match) {
        this.diffFileIndex.push({ line: i, name: match[2] });
      }
    }

    this.recomputeActiveDiff();
    this.phase = "diff-viewer";
    this.invalidate();
    this.tui.requestRender();
  }

  /** Generate the diff output for the working tree (staged + unstaged + untracked). */
  private generateWorkingDiff(): string {
    let diffOutput = "";
    const wsFlag = this.hideWhitespace ? " -w" : "";

    // Show full diff of all changes (staged + unstaged), like `git diff`
    try {
      const staged = execSync(`git diff --color --cached${wsFlag}`, {
        encoding: "utf-8",
        timeout: 10000,
        cwd: process.cwd(),
      });
      if (staged) diffOutput += staged;
    } catch {}
    try {
      const unstaged = execSync(`git diff --color${wsFlag}`, {
        encoding: "utf-8",
        timeout: 10000,
        cwd: process.cwd(),
      });
      if (unstaged) diffOutput += (diffOutput ? "\n" : "") + unstaged;
    } catch {}

    // Include untracked files as pseudo-diffs
    const untrackedFiles = getUntrackedFiles();

    for (const f of untrackedFiles) {
      try {
        const content = readFileSync(f, "utf-8");
        const header =
          `\x1b[1mdiff --git a/${f} b/${f}\x1b[m\n` +
          `\x1b[1mnew file\x1b[m\n` +
          `\x1b[1m--- /dev/null\x1b[m\n` +
          `\x1b[1m+++ b/${f}\x1b[m\n`;
        const coloredLines = content
          .split("\n")
          .map((l) => `\x1b[32m+${l}\x1b[m`)
          .join("\n");
        diffOutput += (diffOutput ? "\n" : "") + header + coloredLines;
      } catch {}
    }

    return diffOutput;
  }

  /** Generate the diff output for the branch (compared to fork point). */
  private generateBranchDiff(): string | null {
    const forkPoint = this.getForkPoint();
    if (!forkPoint) {
      this.ctx.ui.notify(
        "Could not find fork point — no remote branch found in git log",
        "error",
      );
      return null;
    }

    const wsFlag = this.hideWhitespace ? " -w" : "";
    try {
      return execSync(`git diff --color${wsFlag} ${forkPoint.commit}...HEAD`, {
        encoding: "utf-8",
        timeout: 10000,
        cwd: process.cwd(),
      });
    } catch (err: any) {
      this.ctx.ui.notify(
        `Branch diff failed: ${err.stderr?.trim() || err.message}`,
        "error",
      );
      return null;
    }
  }

  /** Load the list of files changed on this branch compared to the fork point. */
  /** The phase to return to when leaving a sub-view (diff-viewer, result, etc.). */
  private get homePhase(): Phase {
    return this.files.length === 0 ? "branch-status" : "select-files";
  }

  /** Load branch status asynchronously (non-blocking git log). */
  private loadBranchStatusAsync(): void {
    this.loadingHintTimer = setTimeout(() => {
      if (this.disposed) return;
      this.showLoadingHint = true;
      this.invalidate();
      this.tui.requestRender();
    }, 1000);

    this.getForkPointAsync().then((forkPoint) => {
      if (this.loadingHintTimer) {
        clearTimeout(this.loadingHintTimer);
        this.loadingHintTimer = null;
      }

      if (this.disposed) return;

      this.branchStatusLoading = false;
      this.showLoadingHint = false;

      if (!forkPoint) {
        this.branchFiles = [];
        this.branchBaseName = "";
      } else {
        this.branchBaseName = forkPoint.name;
        try {
          const output = execSync(
            `git diff --name-status ${forkPoint.commit}...HEAD`,
            { encoding: "utf-8", timeout: 10000, cwd: process.cwd() },
          );
          this.branchFiles = output
            .split("\n")
            .filter((l) => l.trim())
            .map((line) => {
              const status = line.slice(0, 1).trim();
              const path = line.slice(1).trim();
              return { path, status };
            });
        } catch {
          this.branchFiles = [];
        }
      }

      this.invalidate();
      this.tui.requestRender();
    });
  }

  /** Cancel any pending async loading (e.g. when user quits). */
  private cancelLoading(): void {
    this.disposed = true;
    if (this.forkPointChild) {
      this.forkPointChild.kill();
      this.forkPointChild = null;
    }
    if (this.loadingHintTimer) {
      clearTimeout(this.loadingHintTimer);
      this.loadingHintTimer = null;
    }
  }

  private openDiffViewer(): void {
    this.diffMode = "working";
    const diffOutput = this.generateWorkingDiff();
    this.showDiff(diffOutput, "No diff to show");
  }

  private openBranchDiffViewer(): void {
    this.diffMode = "branch";
    const diffOutput = this.generateBranchDiff();
    if (diffOutput === null) return;
    this.showDiff(diffOutput, `No diff compared to base branch`);
  }

  /** Re-run the current diff (e.g. after toggling whitespace). */
  private refreshDiffViewer(): void {
    let diffOutput: string | null;
    if (this.diffMode === "branch") {
      diffOutput = this.generateBranchDiff();
      if (diffOutput === null) return;
    } else {
      diffOutput = this.generateWorkingDiff();
    }
    // Preserve scroll position as much as possible
    const prevScroll = this.diffScrollOffset;
    this.showDiff(diffOutput, "No diff to show");
    this.diffScrollOffset = Math.min(
      prevScroll,
      Math.max(0, this.activeDiffLines.length - 1),
    );
    this.invalidate();
    this.tui.requestRender();
  }

  private handleDiffViewer(data: string): void {
    // Handle y/n confirmation for discarding prompt
    if (this.confirmDiscard) {
      if (matchesKey(data, "y")) {
        this.promptText = "";
        this.promptCursor = 0;
        this.promptScrollOffset = 0;
        this.confirmDiscard = false;
        this.onDone();
      } else if (matchesKey(data, "n") || matchesKey(data, Key.escape)) {
        this.confirmDiscard = false;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    // Tab: switch focus between diff and prompt panes
    if (matchesKey(data, Key.tab)) {
      this.diffFocusPane = this.diffFocusPane === "diff" ? "prompt" : "diff";
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Escape: exit extension (with confirmation if prompt has text)
    if (matchesKey(data, Key.escape)) {
      if (this.promptText.trim()) {
        this.confirmDiscard = true;
        this.invalidate();
        this.tui.requestRender();
      } else {
        this.onDone();
      }
      return;
    }
    // 'q' only quits when diff pane is focused (not when typing in prompt)
    if (matchesKey(data, "q") && this.diffFocusPane === "diff") {
      if (this.promptText.trim()) {
        this.confirmDiscard = true;
        this.invalidate();
        this.tui.requestRender();
      } else {
        this.onDone();
      }
      return;
    }

    if (this.diffFocusPane === "diff") {
      this.handleDiffPaneInput(data);
    } else {
      this.handlePromptPaneInput(data);
    }
  }

  private handleDiffPaneInput(data: string): void {
    // d = scroll down half page
    if (matchesKey(data, "d")) {
      const maxScroll = Math.max(
        0,
        this.activeDiffLines.length - Math.max(5, 30),
      );
      this.diffScrollOffset = Math.min(this.diffScrollOffset + 10, maxScroll);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    // u = scroll up half page
    if (matchesKey(data, "u")) {
      this.diffScrollOffset = Math.max(0, this.diffScrollOffset - 10);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    // g = go to top
    if (matchesKey(data, "g")) {
      this.diffScrollOffset = 0;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    // G = go to bottom (align last line with bottom of pane)
    if (matchesKey(data, Key.shift("g"))) {
      const availableLines = Math.max(5, 30);
      this.diffScrollOffset = Math.max(
        0,
        this.activeDiffLines.length - availableLines,
      );
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    // Arrow keys / j/k for single line scroll
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      const maxScroll = Math.max(
        0,
        this.activeDiffLines.length - Math.max(5, 30),
      );
      this.diffScrollOffset = Math.min(this.diffScrollOffset + 1, maxScroll);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.diffScrollOffset = Math.max(0, this.diffScrollOffset - 1);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    // f = jump to next file
    if (matchesKey(data, "f")) {
      for (const entry of this.activeDiffFileIndex) {
        if (entry.line > this.diffScrollOffset) {
          this.diffScrollOffset = entry.line;
          this.invalidate();
          this.tui.requestRender();
          return;
        }
      }
      return;
    }
    // F = jump to previous file
    if (matchesKey(data, Key.shift("f"))) {
      for (let i = this.activeDiffFileIndex.length - 1; i >= 0; i--) {
        if (this.activeDiffFileIndex[i].line < this.diffScrollOffset) {
          this.diffScrollOffset = this.activeDiffFileIndex[i].line;
          this.invalidate();
          this.tui.requestRender();
          return;
        }
      }
      return;
    }
    // t = toggle hiding test files
    if (matchesKey(data, "t")) {
      this.hideTests = !this.hideTests;
      this.recomputeActiveDiff();
      this.diffScrollOffset = 0;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    // w = toggle hiding whitespace changes
    if (matchesKey(data, "w")) {
      this.hideWhitespace = !this.hideWhitespace;
      this.refreshDiffViewer();
      return;
    }
    // h = hide current file from diff view
    if (matchesKey(data, "h")) {
      const file = this.currentDiffFile();
      if (!file) {
        this.ctx.ui.notify("No file at current scroll position", "error");
        return;
      }
      this.hiddenFiles.add(file);
      this.recomputeActiveDiff();
      // Clamp scroll offset after removing lines
      this.diffScrollOffset = Math.min(
        this.diffScrollOffset,
        Math.max(0, this.activeDiffLines.length - 1),
      );
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    // H = unhide all manually hidden files
    if (matchesKey(data, Key.shift("h"))) {
      if (this.hiddenFiles.size === 0) return;
      this.hiddenFiles.clear();
      this.recomputeActiveDiff();
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    // e = open current diff file in $EDITOR
    if (matchesKey(data, "e")) {
      const file = this.currentDiffFile();
      if (!file) {
        this.ctx.ui.notify("No file at current scroll position", "error");
        return;
      }
      const editor = process.env.EDITOR || "vi";
      const absolutePath = resolve(this.getRepoRoot(), file);
      try {
        // On macOS, GUI editors like `code` (VS Code) can't connect to the
        // running instance via their CLI because VSCODE_IPC_HOOK_CLI isn't
        // available in pi's process environment. Use `open -a` to reliably
        // open files in GUI editors via macOS Launch Services.
        // For terminal editors (vim, nano, etc.), fall back to direct spawn.
        const editorAppMap: Record<string, string> = {
          code: "Visual Studio Code",
          "code-insiders": "Visual Studio Code - Insiders",
          codium: "VSCodium",
          cursor: "Cursor",
          zed: "Zed",
          subl: "Sublime Text",
          atom: "Atom",
        };
        const editorBase = editor.split("/").pop() || editor;
        const macApp =
          process.platform === "darwin" ? editorAppMap[editorBase] : undefined;

        let result;
        if (macApp) {
          result = spawnSync("/usr/bin/open", ["-a", macApp, absolutePath], {
            cwd: process.cwd(),
            stdio: ["pipe", "pipe", "pipe"],
            encoding: "utf-8",
            timeout: 10000,
          });
        } else {
          result = spawnSync(editor, [absolutePath], {
            cwd: process.cwd(),
            env: process.env,
            stdio: "inherit",
            timeout: 10000,
          });
        }
        if (result.error) {
          this.ctx.ui.notify(
            `Failed to open ${file}: ${result.error.message}`,
            "error",
          );
        } else if (result.status !== null && result.status !== 0) {
          const detail =
            ((result.stderr || result.stdout || "") as string).trim() ||
            `exit ${result.status}`;
          this.ctx.ui.notify(`Failed to open ${file}: ${detail}`, "error");
        }
      } catch (err: any) {
        this.ctx.ui.notify(`Failed to open ${file}: ${err.message}`, "error");
      }
      return;
    }
    // p = print current file path into prompt
    if (matchesKey(data, "p")) {
      const file = this.currentDiffFile();
      if (!file) {
        this.ctx.ui.notify("No file at current scroll position", "error");
        return;
      }
      const prefix = this.promptText.trim() ? "\n\n" : "";
      const insertion = prefix + "\n\n" + file;
      this.promptText =
        this.promptText.slice(0, this.promptCursor) +
        insertion +
        this.promptText.slice(this.promptCursor);
      this.promptCursor += prefix.length;
      this.diffFocusPane = "prompt";
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    // x = explain current file's changes (inserts placeholder replaced on send)
    if (matchesKey(data, "x")) {
      const file = this.currentDiffFile();
      if (!file) {
        this.ctx.ui.notify("No file at current scroll position", "error");
        return;
      }
      const prefix = this.promptText.trim() ? "\n\n" : "";
      const preamble = prefix + "Explain these changes:";
      const insertion = preamble + "\n\n${__current_file_diff__}";
      this.promptText =
        this.promptText.slice(0, this.promptCursor) +
        insertion +
        this.promptText.slice(this.promptCursor);
      this.promptCursor += preamble.length;
      this.diffFocusPane = "prompt";
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    // X = explain entire visible diff (inserts placeholder replaced on send)
    if (matchesKey(data, Key.shift("x"))) {
      const prefix = this.promptText.trim() ? "\n\n" : "";
      const preamble = prefix + "Explain these changes:";
      const insertion = preamble + "\n\n${__current_diff__}";
      this.promptText =
        this.promptText.slice(0, this.promptCursor) +
        insertion +
        this.promptText.slice(this.promptCursor);
      this.promptCursor += preamble.length;
      this.diffFocusPane = "prompt";
      this.invalidate();
      this.tui.requestRender();
      return;
    }
  }

  private handlePromptPaneInput(data: string): void {
    // Enter: send prompt to pi in background and clear, staying in diff viewer
    // If the character before the cursor is '\', replace it with a newline instead
    if (matchesKey(data, Key.enter)) {
      if (
        this.promptCursor > 0 &&
        this.promptText[this.promptCursor - 1] === "\\"
      ) {
        // Replace trailing backslash with newline
        this.promptText =
          this.promptText.slice(0, this.promptCursor - 1) +
          "\n" +
          this.promptText.slice(this.promptCursor);
        // cursor stays at same position (backslash replaced by newline)
        this.invalidate();
        this.tui.requestRender();
      } else if (this.promptText.trim()) {
        // Replace diff placeholders before sending
        let text = this.promptText.trim();
        if (text.includes("${__current_file_diff__}")) {
          const file = this.currentDiffFile();
          const fileDiff = file ? this.getFileDiff(file) : "(no file selected)";
          text = text.split("${__current_file_diff__}").join(fileDiff);
        }
        if (text.includes("${__current_diff__}")) {
          text = text
            .split("${__current_diff__}")
            .join(this.getActiveDiffText());
        }
        this.sendPrompt(text);
        this.promptText = "";
        this.promptCursor = 0;
        this.promptScrollOffset = 0;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    // Option+Left: move cursor to previous word boundary
    if (matchesKey(data, Key.alt("left"))) {
      this.promptCursor = this.promptWordBoundaryLeft(this.promptCursor);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    // Option+Right: move cursor to next word boundary
    if (matchesKey(data, Key.alt("right"))) {
      this.promptCursor = this.promptWordBoundaryRight(this.promptCursor);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    // Option+Delete (alt+backspace): delete previous word
    // On macOS, option+delete sends \x17 (same as Ctrl+W) in legacy mode
    if (matchesKey(data, Key.alt("backspace")) || data === "\x17") {
      const boundary = this.promptWordBoundaryLeft(this.promptCursor);
      if (boundary < this.promptCursor) {
        this.promptText =
          this.promptText.slice(0, boundary) +
          this.promptText.slice(this.promptCursor);
        this.promptCursor = boundary;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    // Arrow keys for cursor movement
    if (matchesKey(data, Key.left)) {
      if (this.promptCursor > 0) this.promptCursor--;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.right)) {
      if (this.promptCursor < this.promptText.length) this.promptCursor++;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up)) {
      // Move cursor up one visual (word-wrapped) line
      const contentWidth = this.promptContentWidth;
      if (contentWidth <= 0) return;
      const { wrapMap } = this.buildPromptWrapMap(contentWidth);
      const { line, col } = this.promptCursorInWrapMap(wrapMap);
      if (line > 0) {
        const prevLine = wrapMap[line - 1];
        const newCol = Math.min(col, prevLine.length);
        this.promptCursor = prevLine.textOffset + newCol;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.down)) {
      // Move cursor down one visual (word-wrapped) line
      const contentWidth = this.promptContentWidth;
      if (contentWidth <= 0) return;
      const { wrapMap } = this.buildPromptWrapMap(contentWidth);
      const { line, col } = this.promptCursorInWrapMap(wrapMap);
      if (line < wrapMap.length - 1) {
        const nextLine = wrapMap[line + 1];
        const newCol = Math.min(col, nextLine.length);
        this.promptCursor = nextLine.textOffset + newCol;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    // Home / Ctrl+A
    if (matchesKey(data, Key.home) || matchesKey(data, Key.ctrl("a"))) {
      // Move to start of current line
      const { line } = this.promptCursorPosition();
      const lines = this.promptText.split("\n");
      let newPos = 0;
      for (let i = 0; i < line; i++) newPos += lines[i].length + 1;
      this.promptCursor = newPos;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // End / Ctrl+E
    if (matchesKey(data, Key.end) || matchesKey(data, Key.ctrl("e"))) {
      const { line } = this.promptCursorPosition();
      const lines = this.promptText.split("\n");
      let newPos = 0;
      for (let i = 0; i < line; i++) newPos += lines[i].length + 1;
      newPos += lines[line].length;
      this.promptCursor = newPos;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Backspace
    if (matchesKey(data, Key.backspace)) {
      if (this.promptCursor > 0) {
        this.promptText =
          this.promptText.slice(0, this.promptCursor - 1) +
          this.promptText.slice(this.promptCursor);
        this.promptCursor--;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    // Delete
    if (matchesKey(data, Key.delete)) {
      if (this.promptCursor < this.promptText.length) {
        this.promptText =
          this.promptText.slice(0, this.promptCursor) +
          this.promptText.slice(this.promptCursor + 1);
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    // Kill to end of line (Ctrl+K)
    if (matchesKey(data, Key.ctrl("k"))) {
      const { line, col } = this.promptCursorPosition();
      const lines = this.promptText.split("\n");
      const lineEnd = lines[line].length;
      if (col < lineEnd) {
        // Kill to end of line
        let pos = this.promptCursor;
        let endPos = pos + (lineEnd - col);
        this.promptText =
          this.promptText.slice(0, pos) + this.promptText.slice(endPos);
      } else if (this.promptCursor < this.promptText.length) {
        // At end of line: join with next line (delete the newline)
        this.promptText =
          this.promptText.slice(0, this.promptCursor) +
          this.promptText.slice(this.promptCursor + 1);
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Bracketed paste: terminal wraps pasted content in \x1b[200~ ... \x1b[201~
    if (data.includes("\x1b[200~")) {
      const pasteContent = data
        .replace(/\x1b\[200~/g, "")
        .replace(/\x1b\[201~/g, "");
      if (pasteContent) {
        this.promptText =
          this.promptText.slice(0, this.promptCursor) +
          pasteContent +
          this.promptText.slice(this.promptCursor);
        this.promptCursor += pasteContent.length;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    // Printable character input
    const ch = this.dataToPrintable(data);
    if (ch) {
      this.promptText =
        this.promptText.slice(0, this.promptCursor) +
        ch +
        this.promptText.slice(this.promptCursor);
      this.promptCursor += ch.length;
      this.invalidate();
      this.tui.requestRender();
    }
  }

  /** Get the current file name based on diff scroll position */
  private currentDiffFile(): string {
    let name = "";
    for (const entry of this.activeDiffFileIndex) {
      if (entry.line <= this.diffScrollOffset) {
        name = entry.name;
      } else {
        break;
      }
    }
    return name;
  }

  /** Get the diff lines for a specific file from the active (filtered) diff. */
  private getFileDiff(fileName: string): string {
    // Find the file's section in the active diff
    let startLine = -1;
    let endLine = this.activeDiffLines.length;
    for (let i = 0; i < this.activeDiffFileIndex.length; i++) {
      if (this.activeDiffFileIndex[i].name === fileName) {
        startLine = this.activeDiffFileIndex[i].line;
        endLine =
          i + 1 < this.activeDiffFileIndex.length
            ? this.activeDiffFileIndex[i + 1].line
            : this.activeDiffLines.length;
        break;
      }
    }
    if (startLine < 0) return "";
    return this.activeDiffLines
      .slice(startLine, endLine)
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
      .join("\n");
  }

  /** Get the entire active (filtered) diff as plain text. */
  private getActiveDiffText(): string {
    return this.activeDiffLines
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
      .join("\n");
  }

  /** Get line/col of the prompt cursor (logical lines, split by \n) */
  private promptCursorPosition(): { line: number; col: number } {
    const before = this.promptText.slice(0, this.promptCursor);
    const lines = before.split("\n");
    return { line: lines.length - 1, col: lines[lines.length - 1].length };
  }

  /** Build the wrap map for the prompt text given content width.
   *  Each entry maps a visual (wrapped) line to a range in the original text. */
  private buildPromptWrapMap(contentWidth: number): {
    wrappedLines: string[];
    wrapMap: { textOffset: number; length: number }[];
  } {
    const wrappedLines: string[] = [];
    const wrapMap: { textOffset: number; length: number }[] = [];

    if (this.promptText.length === 0) {
      wrappedLines.push("");
      wrapMap.push({ textOffset: 0, length: 0 });
      return { wrappedLines, wrapMap };
    }

    const rawLines = this.promptText.split("\n");
    let textOffset = 0;
    for (const rawLine of rawLines) {
      if (rawLine.length <= contentWidth) {
        wrappedLines.push(rawLine);
        wrapMap.push({ textOffset, length: rawLine.length });
      } else {
        // Word-wrap long lines
        let pos = 0;
        while (pos < rawLine.length) {
          let end = pos + contentWidth;
          if (end >= rawLine.length) {
            end = rawLine.length;
          } else {
            // Try to break at a word boundary
            let breakAt = end;
            while (breakAt > pos && rawLine[breakAt] !== " ") breakAt--;
            if (breakAt > pos) {
              end = breakAt + 1; // include the space at end of this line
            }
            // else: no word boundary found, hard break at contentWidth
          }
          const segment = rawLine.slice(pos, end);
          wrappedLines.push(segment);
          wrapMap.push({
            textOffset: textOffset + pos,
            length: segment.length,
          });
          pos = end;
        }
      }
      textOffset += rawLine.length + 1; // +1 for \n
    }

    return { wrappedLines, wrapMap };
  }

  /** Find the cursor's position in wrapped visual lines */
  private promptCursorInWrapMap(
    wrapMap: { textOffset: number; length: number }[],
  ): { line: number; col: number } {
    let remaining = this.promptCursor;
    for (let i = 0; i < wrapMap.length; i++) {
      const { length } = wrapMap[i];
      if (remaining <= length || i === wrapMap.length - 1) {
        return { line: i, col: Math.min(remaining, length) };
      }
      remaining -= length;
      // If this visual line ends at a newline in the original text, consume it
      const lineEndOffset = wrapMap[i].textOffset + length;
      if (
        lineEndOffset < this.promptText.length &&
        this.promptText[lineEndOffset] === "\n"
      ) {
        remaining--;
      }
    }
    return { line: 0, col: 0 };
  }

  /** Find previous word boundary (for option+left / option+delete) */
  private promptWordBoundaryLeft(pos: number): number {
    if (pos <= 0) return 0;
    let i = pos - 1;
    // Skip whitespace/punctuation
    while (i > 0 && !/\w/.test(this.promptText[i])) i--;
    // Skip word chars
    while (i > 0 && /\w/.test(this.promptText[i - 1])) i--;
    return i;
  }

  /** Find next word boundary (for option+right) */
  private promptWordBoundaryRight(pos: number): number {
    const len = this.promptText.length;
    if (pos >= len) return len;
    let i = pos;
    // Skip word chars
    while (i < len && /\w/.test(this.promptText[i])) i++;
    // Skip whitespace/punctuation
    while (i < len && !/\w/.test(this.promptText[i])) i++;
    return i;
  }

  private refreshStatus(): void {
    this.branch = this.getBranch();
    try {
      const output = execSync("git status --porcelain", {
        encoding: "utf-8",
        timeout: 10000,
        cwd: process.cwd(),
      });
      this.files = parseGitStatus(output);
      if (this.files.length === 0) {
        this.onDone();
        return;
      }
    } catch {}
    this.selected.clear();
    this.cursor = 0;
    this.scrollOffset = 0;
    this.cmdPrefix = "";
    this.phase = this.homePhase;
    this.invalidate();
    this.tui.requestRender();
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const theme = this.theme;
    const lines: string[] = [];

    // Title
    const branchInfo = this.branch
      ? theme.fg("muted", ` on `) + theme.fg("text", this.branch)
      : "";
    lines.push(
      theme.fg("accent", theme.bold("  Git Interactive")) + branchInfo,
    );
    lines.push(theme.fg("dim", "─".repeat(width)));

    if (this.phase === "select-files") {
      lines.push(...this.renderFileList(width));
      if (this.generatingCommitMsg) {
        lines.push(theme.fg("dim", "─".repeat(width)));
        lines.push(theme.fg("accent", "  ⏳ Generating commit message..."));
      } else {
        lines.push(theme.fg("dim", "─".repeat(width)));
        lines.push(
          truncateToWidth(
            theme.fg(
              "dim",
              "  ↑↓ navigate • tab select • a all • u unselect • d diff • b branch diff • c commit • enter confirm • esc quit",
            ),
            width,
          ),
        );
      }
    } else if (this.phase === "enter-command") {
      // Show selected files summary
      const selectedFiles = this.getSelectedFiles();
      lines.push(
        theme.fg("muted", `  Selected ${selectedFiles.length} file(s):`),
      );
      for (const f of selectedFiles.slice(0, 5)) {
        const file = this.files.find((gf) => gf.path === f);
        const suffix = file ? ` (${statusLabel(file.status)})` : "";
        lines.push(
          truncateToWidth(
            theme.fg("dim", `    ${f}`) + theme.fg("muted", suffix),
            width,
          ),
        );
      }
      if (selectedFiles.length > 5) {
        lines.push(
          theme.fg("dim", `    ... and ${selectedFiles.length - 5} more`),
        );
      }
      lines.push("");

      // Command input (self-rendered)
      lines.push(theme.fg("accent", "  Command:"));
      // Show prefix lines (read-only) above the editable input
      if (this.cmdPrefix) {
        for (const prefixLine of this.cmdPrefix.split("\n")) {
          if (prefixLine) {
            lines.push(
              truncateToWidth(theme.fg("dim", `  ${prefixLine}`), width),
            );
          }
        }
      }
      lines.push("  " + this.renderCommandInput(width - 4));
      lines.push("");

      // Preview
      const expanded = this.getFullExpandedCommand();
      lines.push(theme.fg("muted", "  Preview:"));
      // Split on actual newlines first, then wrap each line for width
      const expandedLines = expanded.split("\n");
      for (let li = 0; li < expandedLines.length; li++) {
        const prefix = li === 0 ? "  $ " : "  ";
        const wrapped = this.wrapText(prefix + expandedLines[li], width);
        for (const pl of wrapped) {
          lines.push(theme.fg("dim", pl));
        }
      }

      lines.push(theme.fg("dim", "─".repeat(width)));
      lines.push(theme.fg("dim", "  enter run • esc back • ↑ history"));
    } else if (this.phase === "result") {
      const color = this.resultIsError ? "error" : "success";
      lines.push(
        theme.fg(
          color,
          this.resultIsError ? "  ✗ Command failed:" : "  ✓ Output:",
        ),
      );
      lines.push("");
      const resultLines = this.resultText.split("\n");
      const showLines = resultLines.slice(0, 20);
      for (const rl of showLines) {
        lines.push(
          truncateToWidth(
            theme.fg(
              this.resultIsError ? "error" : "text",
              `  ${this.sanitizeLine(rl)}`,
            ),
            width,
          ),
        );
      }
      if (resultLines.length > 20) {
        lines.push(
          theme.fg("dim", `  ... ${resultLines.length - 20} more lines`),
        );
      }
      lines.push("");
      lines.push(theme.fg("dim", "─".repeat(width)));
      lines.push(theme.fg("dim", "  enter/esc continue"));
    } else if (this.phase === "branch-status") {
      lines.push(...this.renderBranchStatus(width));
      lines.push(theme.fg("dim", "─".repeat(width)));
      lines.push(
        truncateToWidth(
          theme.fg(
            "dim",
            this.branchStatusLoading
              ? "  esc quit"
              : "  ↑↓ navigate • b branch diff • esc quit",
          ),
          width,
        ),
      );
    } else if (this.phase === "diff-viewer") {
      // Split pane: left = diff, right = prompt editor
      const dividerWidth = 1; // │ character
      const promptPaneWidth = Math.max(30, Math.floor(width * 0.35));
      const diffPaneWidth = width - promptPaneWidth - dividerWidth;
      const availableLines = Math.max(5, 30);

      // Pane headers with focus indication
      const diffFocused = this.diffFocusPane === "diff";
      const currentFile = this.currentDiffFile();
      const fileLabel = currentFile ? ` │ ${currentFile}` : "";
      const testsHiddenLabel = this.hideTests
        ? theme.fg("warning", " (tests hidden)")
        : "";
      const wsHiddenLabel = this.hideWhitespace
        ? theme.fg("warning", " (ws hidden)")
        : "";
      const filesHiddenLabel =
        this.hiddenFiles.size > 0
          ? theme.fg("warning", ` (files hidden: ${this.hiddenFiles.size})`)
          : "";
      const diffHeader = diffFocused
        ? theme.fg("accent", theme.bold(" ▶ Diff")) +
          testsHiddenLabel +
          wsHiddenLabel +
          filesHiddenLabel +
          theme.fg("muted", fileLabel)
        : theme.fg("dim", "   Diff") +
          testsHiddenLabel +
          wsHiddenLabel +
          filesHiddenLabel +
          theme.fg("dim", fileLabel);
      const promptHeader = !diffFocused
        ? theme.fg("accent", theme.bold(" ▶ Prompt"))
        : theme.fg("dim", "   Prompt");

      const diffHeaderPadded = truncateToWidth(diffHeader, diffPaneWidth);
      const promptHeaderPadded = truncateToWidth(promptHeader, promptPaneWidth);
      lines.push(diffHeaderPadded + theme.fg("dim", "│") + promptHeaderPadded);

      const diffBorderChar = diffFocused ? "═" : "─";
      const promptBorderChar = !diffFocused ? "═" : "─";
      lines.push(
        theme.fg(
          diffFocused ? "accent" : "dim",
          diffBorderChar.repeat(diffPaneWidth),
        ) +
          theme.fg("dim", "│") +
          theme.fg(
            !diffFocused ? "accent" : "dim",
            promptBorderChar.repeat(promptPaneWidth),
          ),
      );

      // Build diff lines for left pane
      const total = this.activeDiffLines.length;
      const diffEnd = Math.min(this.diffScrollOffset + availableLines, total);
      const leftLines: string[] = [];
      for (let i = this.diffScrollOffset; i < diffEnd; i++) {
        leftLines.push(
          truncateToWidth(
            " " + this.sanitizeLine(this.activeDiffLines[i]),
            diffPaneWidth,
          ),
        );
      }
      // Pad diff pane
      for (let i = leftLines.length; i < availableLines; i++) {
        leftLines.push("");
      }

      // Build prompt lines for right pane with word wrapping
      const promptContentWidth = promptPaneWidth - 1; // 1 char left margin
      this.promptContentWidth = promptContentWidth; // cache for input handlers

      const { wrappedLines, wrapMap } =
        this.buildPromptWrapMap(promptContentWidth);
      const { line: cursorWrappedLine, col: cursorWrappedCol } =
        this.promptCursorInWrapMap(wrapMap);

      // Ensure scroll keeps cursor visible
      if (cursorWrappedLine < this.promptScrollOffset) {
        this.promptScrollOffset = cursorWrappedLine;
      } else if (
        cursorWrappedLine >=
        this.promptScrollOffset + availableLines
      ) {
        this.promptScrollOffset = cursorWrappedLine - availableLines + 1;
      }

      const rightLines: string[] = [];
      const promptEnd = Math.min(
        this.promptScrollOffset + availableLines,
        wrappedLines.length,
      );

      for (let i = this.promptScrollOffset; i < promptEnd; i++) {
        let lineText = wrappedLines[i];
        if (!diffFocused && i === cursorWrappedLine) {
          // Render cursor on this line
          const col = cursorWrappedCol;
          const before = lineText.slice(0, col);
          const atCursor = col < lineText.length ? lineText[col] : " ";
          const after = col < lineText.length ? lineText.slice(col + 1) : "";
          const cursorChar = `\x1b[7m${atCursor}\x1b[27m`;
          lineText = before + cursorChar + after;
        }
        rightLines.push(truncateToWidth(" " + lineText, promptPaneWidth));
      }

      // If prompt is empty and we're in prompt focus, show placeholder
      if (this.promptText === "" && !diffFocused) {
        rightLines[0] = truncateToWidth(
          " " +
            theme.fg("dim", "Prompt pi for changes...") +
            `\x1b[7m \x1b[27m`,
          promptPaneWidth,
        );
      } else if (this.promptText === "" && diffFocused) {
        rightLines[0] = truncateToWidth(
          " " + theme.fg("dim", "Prompt pi for changes..."),
          promptPaneWidth,
        );
      }

      // Pad prompt pane
      for (let i = rightLines.length; i < availableLines; i++) {
        rightLines.push("");
      }

      // Combine left and right panes line by line
      for (let i = 0; i < availableLines; i++) {
        const leftRaw = leftLines[i] || "";
        const rightRaw = rightLines[i] || "";
        // Pad left pane to exact width (accounting for ANSI codes)
        const leftVis = visibleWidth(leftRaw);
        const leftPadded =
          leftRaw + " ".repeat(Math.max(0, diffPaneWidth - leftVis));
        const rightVis = visibleWidth(rightRaw);
        const rightPadded =
          rightRaw + " ".repeat(Math.max(0, promptPaneWidth - rightVis));
        lines.push(leftPadded + theme.fg("dim", "│") + rightPadded);
      }

      const position =
        total > 0
          ? `${this.diffScrollOffset + 1}-${diffEnd} of ${total}`
          : "empty";
      lines.push(theme.fg("dim", "─".repeat(width)));
      const hideTestsHint = this.hideTests ? "t show tests" : "t hide tests";
      const hideWsHint = this.hideWhitespace ? "w show ws" : "w hide ws";
      const hideFileHint =
        this.hiddenFiles.size > 0
          ? "h hide file · H unhide all"
          : "h hide file";
      const helpLeft = diffFocused
        ? `d↓ u↑ · g/G top/bottom · j/k scroll · f/F next/prev file · e edit · p path · x explain file · X explain diff · ${hideTestsHint} · ${hideWsHint} · ${hideFileHint}`
        : `editing prompt (\\+enter=newline)`;
      const helpRight = this.promptText.trim()
        ? `tab switch pane · enter send · esc back`
        : `tab switch pane · esc back`;
      lines.push(
        truncateToWidth(
          theme.fg("dim", `  ${helpLeft}  │  ${helpRight}  ${position}`),
          width,
        ),
      );

      // Confirmation dialog overlay
      if (this.confirmDiscard) {
        lines.push("");
        lines.push(
          theme.fg("accent", theme.bold("  Discard prompt and exit?")) +
            theme.fg("dim", "  (y)es / (n)o"),
        );
      }
    }

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  private renderCommandInput(availableWidth: number): string {
    const prompt = "> ";
    const w = availableWidth - prompt.length;
    if (w <= 0) return prompt;

    const text = this.cmdText;
    const cur = this.cmdCursor;

    // Determine visible window with horizontal scrolling
    let visStart = 0;
    let visCursor = cur;

    if (text.length <= w) {
      // Everything fits
      visStart = 0;
    } else {
      const half = Math.floor(w / 2);
      if (cur < half) {
        visStart = 0;
      } else if (cur > text.length - half) {
        visStart = text.length - w;
      } else {
        visStart = cur - half;
      }
      visCursor = cur - visStart;
    }

    const visText = text.slice(visStart, visStart + w);
    const before = visText.slice(0, visCursor);
    const atCursor = visCursor < visText.length ? visText[visCursor] : " ";
    const after =
      visCursor < visText.length ? visText.slice(visCursor + 1) : "";

    // Inverse video for cursor
    const cursorChar = `\x1b[7m${atCursor}\x1b[27m`;
    const padding = " ".repeat(
      Math.max(0, w - visText.length - (visCursor >= visText.length ? 1 : 0)),
    );

    return prompt + before + cursorChar + after + padding;
  }

  /** Replace tab characters with spaces to prevent terminal width miscounting. */
  private sanitizeLine(line: string): string {
    return line.replace(/\t/g, "  ");
  }

  private wrapText(text: string, maxWidth: number): string[] {
    if (text.length <= maxWidth) return [text];
    const lines: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      lines.push(remaining.slice(0, maxWidth));
      remaining = remaining.slice(maxWidth);
    }
    return lines;
  }

  private renderBranchStatus(width: number): string[] {
    const lines: string[] = [];
    const theme = this.theme;

    if (this.branchStatusLoading) {
      if (this.showLoadingHint) {
        lines.push(theme.fg("muted", "  Loading branch status..."));
      }
      return lines;
    }

    if (this.branchFiles.length === 0) {
      lines.push(theme.fg("muted", "  No changes on this branch"));
      return lines;
    }

    const baseLabel = this.branchBaseName || "base";
    lines.push(
      theme.fg(
        "muted",
        `  ${this.branchFiles.length} file(s) changed compared to ${baseLabel}:`,
      ),
    );
    lines.push("");

    const maxVisible = Math.min(this.branchFiles.length, 20);

    if (this.cursor < this.scrollOffset) {
      this.scrollOffset = this.cursor;
    } else if (this.cursor >= this.scrollOffset + maxVisible) {
      this.scrollOffset = this.cursor - maxVisible + 1;
    }

    const end = Math.min(
      this.scrollOffset + maxVisible,
      this.branchFiles.length,
    );

    for (let i = this.scrollOffset; i < end; i++) {
      const file = this.branchFiles[i];
      const isCursor = i === this.cursor;
      const pointer = isCursor ? "▸" : " ";
      const statusStr = statusLabel(file.status);

      let line: string;
      if (isCursor) {
        line =
          theme.fg(
            "accent",
            `  ${pointer} ${truncateToWidth(file.path, width - 20)} `,
          ) + theme.fg("muted", `(${statusStr})`);
      } else {
        line =
          theme.fg(
            "dim",
            `  ${pointer} ${truncateToWidth(file.path, width - 20)} `,
          ) + theme.fg("dim", `(${statusStr})`);
      }
      lines.push(truncateToWidth(line, width));
    }

    if (this.branchFiles.length > maxVisible) {
      lines.push(
        theme.fg(
          "dim",
          `  ${this.scrollOffset + 1}-${end} of ${this.branchFiles.length}`,
        ),
      );
    }

    return lines;
  }

  private renderFileList(width: number): string[] {
    const lines: string[] = [];
    const maxVisible = Math.min(this.files.length, 20);

    if (this.cursor < this.scrollOffset) {
      this.scrollOffset = this.cursor;
    } else if (this.cursor >= this.scrollOffset + maxVisible) {
      this.scrollOffset = this.cursor - maxVisible + 1;
    }

    const end = Math.min(this.scrollOffset + maxVisible, this.files.length);

    for (let i = this.scrollOffset; i < end; i++) {
      const file = this.files[i];
      const isCursor = i === this.cursor;
      const isSelected = this.selected.has(i);

      const checkbox = isSelected ? "◉" : "○";
      const pointer = isCursor ? "▸" : " ";
      const statusStr = statusLabel(file.status);

      let line: string;
      if (isCursor) {
        line =
          this.theme.fg(
            "accent",
            `  ${pointer} ${checkbox} ${truncateToWidth(file.path, width - 20)} `,
          ) + this.theme.fg("muted", `(${statusStr})`);
      } else if (isSelected) {
        line =
          this.theme.fg(
            "text",
            `  ${pointer} ${checkbox} ${truncateToWidth(file.path, width - 20)} `,
          ) + this.theme.fg("muted", `(${statusStr})`);
      } else {
        line =
          this.theme.fg(
            "dim",
            `  ${pointer} ${checkbox} ${truncateToWidth(file.path, width - 20)} `,
          ) + this.theme.fg("dim", `(${statusStr})`);
      }

      lines.push(truncateToWidth(line, width));
    }

    if (this.files.length > maxVisible) {
      lines.push(
        this.theme.fg(
          "dim",
          `  ${this.scrollOffset + 1}-${end} of ${this.files.length}`,
        ),
      );
    }

    return lines;
  }
}

// --- Extension entry point ---

export default function (pi: ExtensionAPI) {
  pi.registerCommand("git", {
    description: "Interactive git file selector and command runner",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Git interactive requires TUI mode", "error");
        return;
      }

      let output: string;
      try {
        output = execSync("git status --porcelain", {
          encoding: "utf-8",
          timeout: 10000,
          cwd: process.cwd(),
        });
      } catch (err: any) {
        ctx.ui.notify(
          `git status failed: ${err.stderr?.trim() || err.message}`,
          "error",
        );
        return;
      }

      const files = parseGitStatus(output);

      const promptText = await ctx.ui.custom<string | undefined>(
        (tui, theme, _kb, done) => {
          // Clear stale lines when switching from tall phases (diff viewer) to shorter ones
          (tui as any).setClearOnShrink(true);
          const component = new GitComponent(
            files,
            tui,
            theme,
            (prompt?: string) => done(prompt),
            (text: string) => pi.sendUserMessage(text, { deliverAs: "steer" }),
            ctx,
          );
          return {
            render: (w: number) => component.render(w),
            invalidate: () => component.invalidate(),
            handleInput: (data: string) => {
              component.handleInput(data);
            },
          };
        },
      );
    },
  });
}
