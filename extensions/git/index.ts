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
} from "@earendil-works/pi-coding-agent";
import { complete, type UserMessage } from "@earendil-works/pi-ai";
import {
  Editor,
  Input,
  type EditorTheme,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

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
  } catch {
    // History file may not exist or be corrupted
  }
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
  } catch {
    // Best-effort persistence
  }
}

// --- Parse git status output ---

export interface GitFile {
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
  | "branch-status"
  | "confirm-branch-check"
  | "log-list";

interface GitLogEntry {
  hash: string;
  shortHash: string;
  subject: string;
}

interface CommitStats {
  additions: number;
  deletions: number;
  files: string[];
}

interface DiffSourceLine {
  file: string;
  line: number;
  prefix: "+" | "-" | " ";
  text: string;
}

// --- Main Component ---

export class GitComponent implements Component {
  private files: GitFile[];
  private selected: Set<number> = new Set();
  private cursor = 0;
  private scrollOffset = 0;
  private phase: Phase = "select-files";

  // Command text input (self-managed)
  private cmdPrefix = ""; // preceding commands (e.g. "git add ... &&\n"), user cannot edit
  private commandInput = new Input();
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
  private diffSourceLines: (DiffSourceLine | undefined)[] = [];
  private diffScrollOffset = 0;
  private diffCursorIndex = 0;
  private diffFileIndex: { line: number; name: string }[] = []; // file boundaries in diff
  private diffChunkIndex: number[] = []; // chunk (hunk) boundaries (delta only)

  // Filtered diff (active view, respects hideTests toggle)
  private activeDiffLines: string[] = [];
  private activeDiffSourceLines: (DiffSourceLine | undefined)[] = [];
  private activeDiffFileIndex: { line: number; name: string }[] = [];
  private activeDiffChunkIndex: number[] = [];
  private visualSelectionAnchor: number | null = null;
  private visualSelectionEnd: number | null = null;
  private hideTests = false;
  private hideWhitespace = true;
  private hiddenFiles: Set<string> = new Set();
  private diffMode: "working" | "branch" | "commit" = "working";
  private commitDiffHash = "";
  private logEntries: GitLogEntry[] = [];
  private logCursor = 0;
  private logScrollOffset = 0;
  private logReturnPhase: "select-files" | "confirm-branch-check" =
    "confirm-branch-check";
  private commitStatsCache = new Map<string, CommitStats>();
  private selectedCommitStats: CommitStats = {
    additions: 0,
    deletions: 0,
    files: [],
  };
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
  private confirmDiscard = false; // "discard prompt?" y/n confirmation
  private promptEditor!: Editor;
  private promptHistory: string[] = [];

  // TUI
  private tui: TUI;
  private theme: any;
  private onDone: (promptText?: string) => void;
  private sendPrompt: (text: string) => void;
  private queueFollowUp: (text: string) => void;
  private ctx: ExtensionCommandContext;

  // Caching
  private cachedLines?: string[];
  private cachedWidth?: number;

  constructor(opts: {
    files: GitFile[];
    tui: TUI;
    theme: any;
    onDone: (promptText?: string) => void;
    sendPrompt: (text: string) => void;
    queueFollowUp: (text: string) => void;
    ctx: ExtensionCommandContext;
  }) {
    this.files = opts.files;
    this.tui = opts.tui;
    this.theme = opts.theme;
    this.onDone = opts.onDone;
    this.sendPrompt = opts.sendPrompt;
    this.queueFollowUp = opts.queueFollowUp;
    this.ctx = opts.ctx;
    this.commandHistory = loadHistory();
    this.branch = this.getBranch();
    this.initPromptEditor();

    if (this.files.length === 0) {
      this.phase = "confirm-branch-check";
    }
  }

  private initPromptEditor(): void {
    const editorTheme: EditorTheme = {
      borderColor: (s: string) => this.theme.fg("accent", s),
      selectList: {
        selectedPrefix: (s: string) => this.theme.fg("accent", s),
        selectedText: (s: string) => this.theme.fg("accent", s),
        description: (s: string) => this.theme.fg("dim", s),
        scrollInfo: (s: string) => this.theme.fg("dim", s),
        noMatch: (s: string) => this.theme.fg("dim", s),
      },
    };
    this.promptEditor = new Editor(this.tui, editorTheme, { paddingX: 0 });
    this.promptEditor.focused = false;
    this.promptEditor.onSubmit = (text: string) => {
      this.submitPrompt(text);
    };
    this.promptEditor.setAutocompleteProvider(
      new FilePathAutocompleteProvider(),
    );
  }

  /** Process and send the prompt text, expanding placeholders. */
  private submitPrompt(
    raw: string,
    mode: "immediate" | "followUp" = "immediate",
  ): void {
    const text = raw.trim();
    if (!text) return;
    if (mode === "followUp") {
      this.queueFollowUp(text);
    } else {
      this.sendPrompt(text);
    }
    this.promptEditor.addToHistory(raw.trim());
    this.promptHistory.push(raw.trim());
    this.promptEditor.setText("");
    this.invalidate();
    this.tui.requestRender();
  }

  /** Get the current prompt text from the editor. */
  private getPromptText(): string {
    return this.promptEditor.getText();
  }

  /** Insert text into the prompt editor at the cursor. */
  private insertIntoPrompt(text: string): void {
    this.promptEditor.insertTextAtCursor(text);
    this.diffFocusPane = "prompt";
    this.promptEditor.focused = true;
    this.invalidate();
    this.tui.requestRender();
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

  private getDefaultBranchForkPoint(): {
    commit: string;
    name: string;
  } | null {
    const errors: { attempt: string; detail: string }[] = [];
    const candidates: string[] = [];
    const recordError = (attempt: string, err: any): void => {
      errors.push({
        attempt,
        detail: err.stderr?.toString().trim() || err.message || String(err),
      });
    };

    try {
      const commonDir = execSync(
        "git rev-parse --path-format=absolute --git-common-dir",
        {
          encoding: "utf-8",
          timeout: 5000,
          cwd: process.cwd(),
        },
      ).trim();
      const statePath = join(commonDir, ".gs", "state.json");
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      if (state.version !== 1) {
        throw new Error(
          `Unsupported GitStream state version: ${state.version}`,
        );
      }
      const parent = state.branches?.[this.branch]?.parent;
      if (!parent) {
        throw new Error(`No GitStream parent recorded for ${this.branch}`);
      }
      const trunk = state.trunks?.[parent];
      candidates.push(
        trunk?.remote && trunk?.target
          ? `${trunk.remote}/${trunk.target}`
          : parent,
      );
    } catch (err: any) {
      recordError("GitStream .gs/state.json", err);
    }

    try {
      const originHead = execSync(
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD",
        {
          encoding: "utf-8",
          timeout: 5000,
          cwd: process.cwd(),
        },
      ).trim();
      if (originHead) candidates.push(originHead);
    } catch (err: any) {
      recordError(
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD",
        err,
      );
    }

    candidates.push("origin/main", "origin/master", "main", "master");
    for (const candidate of [...new Set(candidates)]) {
      const attempt = `git rev-parse --verify --quiet ${candidate}`;
      try {
        execSync(
          `git rev-parse --verify --quiet ${shellQuote(`${candidate}^{commit}`)}`,
          {
            encoding: "utf-8",
            timeout: 5000,
            cwd: process.cwd(),
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        const commit = execSync(
          `git merge-base HEAD ${shellQuote(candidate)}`,
          {
            encoding: "utf-8",
            timeout: 10000,
            cwd: process.cwd(),
          },
        ).trim();
        if (commit) return { commit, name: candidate };
        errors.push({ attempt, detail: "git merge-base returned no commit" });
      } catch (err: any) {
        recordError(attempt, err);
      }
    }

    const errorDetails = errors
      .map((error) => `${error.attempt}: ${error.detail}`)
      .join("\n");
    this.ctx.ui.notify(
      `Could not determine default branch. Attempts:\n${errorDetails || "No errors were reported."}`,
      "error",
    );
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
      const result =
        this.parseForkPointFromLog(log) ?? this.getDefaultBranchForkPoint();
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

        const result =
          this.parseForkPointFromLog(stdout) ??
          this.getDefaultBranchForkPoint();
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
    const diffParts: string[] = [];
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
          maxBuffer: DIFF_MAX_BUFFER,
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
          maxBuffer: DIFF_MAX_BUFFER,
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
        const contentLines = content.split("\n");
        const lines = contentLines.map((l) => `+${l}`).join("\n");
        const hunkHeader = `@@ -0,0 +1,${contentLines.length} @@`;
        diffParts.push(
          `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n${hunkHeader}\n${lines}`,
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
    const expandedCmd = this.expandCommand(this.commandInput.getValue());
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
    const template = this.commandInput.getValue().trim();
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

  private cmdSetValue(value: string, cursorPos = value.length): void {
    const input = new Input();
    const position = Math.max(0, Math.min(cursorPos, value.length));
    if (position > 0) {
      input.handleInput(`\x1b[200~${value.slice(0, position)}\x1b[201~`);
    }
    input.setValue(value);
    input.focused = true;
    this.commandInput = input;
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
    } else if (this.phase === "confirm-branch-check") {
      this.handleConfirmBranchCheck(data);
    } else if (this.phase === "branch-status") {
      this.handleBranchStatus(data);
    } else if (this.phase === "log-list") {
      this.handleLogList(data);
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
    // 'l' to show recent commits
    if (matchesKey(data, "l")) {
      this.openLogList();
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

  private handleConfirmBranchCheck(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      this.onDone();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.phase = "branch-status";
      this.branchStatusLoading = true;
      this.loadBranchStatusAsync();
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "l")) {
      this.openLogList();
      return;
    }
  }

  private handleLogList(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.logReturnPhase === "select-files") {
        this.phase = "select-files";
        this.invalidate();
        this.tui.requestRender();
      } else {
        this.onDone();
      }
      return;
    }
    if (matchesKey(data, "q")) {
      this.onDone();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveLogCursor(1);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveLogCursor(-1);
      return;
    }
    if (matchesKey(data, "d")) {
      this.moveLogCursor(10);
      return;
    }
    if (matchesKey(data, "u")) {
      this.moveLogCursor(-10);
      return;
    }
    if (matchesKey(data, "g")) {
      this.moveLogCursor(-this.logCursor);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const entry = this.logEntries[this.logCursor];
      if (entry) this.openCommitDiffViewer(entry.hash);
    }
  }

  private moveLogCursor(delta: number): void {
    const max = Math.max(0, this.logEntries.length - 1);
    const next = Math.max(0, Math.min(this.logCursor + delta, max));
    if (next === this.logCursor) return;
    this.logCursor = next;
    this.loadSelectedCommitStats();
    this.invalidate();
    this.tui.requestRender();
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
    if (matchesKey(data, Key.down)) {
      if (this.cursor < this.branchFiles.length - 1) {
        this.cursor++;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.up)) {
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
        this.savedDraft = this.commandInput.getValue();
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

    const previousValue = this.commandInput.getValue();
    this.commandInput.handleInput(data);
    if (this.commandInput.getValue() !== previousValue) {
      this.historyIndex = -1;
    }
    this.invalidate();
    this.tui.requestRender();
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
      this.activeDiffSourceLines = this.diffSourceLines;
      this.activeDiffFileIndex = this.diffFileIndex;
      this.activeDiffChunkIndex = this.diffChunkIndex;
      this.clearVisualSelection();
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
    const filteredSourceLines: (DiffSourceLine | undefined)[] = [];
    const filteredFileIndex: { line: number; name: string }[] = [];

    const firstFileStart =
      sections.length > 0 ? sections[0].startLine : this.diffLines.length;
    for (let i = 0; i < firstFileStart; i++) {
      filteredLines.push(this.diffLines[i]);
      filteredSourceLines.push(this.diffSourceLines[i]);
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
        filteredSourceLines.push(this.diffSourceLines[i]);
      }
    }

    this.activeDiffLines = filteredLines;
    this.activeDiffSourceLines = filteredSourceLines;
    this.activeDiffFileIndex = filteredFileIndex;
    this.clearVisualSelection();

    this.activeDiffChunkIndex = remapChunkIndex(
      this.diffChunkIndex,
      sections,
      firstFileStart,
      { hideTests: this.hideTests, hiddenFiles: this.hiddenFiles },
    );
  }

  /** Set up diff viewer state from raw diff output and switch to diff phase.
   *  When a pre-built fileIndex is provided (e.g. from delta-processed output),
   *  it is used directly instead of parsing "diff --git" lines from the output.
   */
  private showDiff(
    diffOutput: string,
    emptyMessage: string,
    fileIndex?: { line: number; name: string }[],
    chunkIndex?: number[],
    sourceLines?: (DiffSourceLine | undefined)[],
  ): void {
    if (!diffOutput.trim()) {
      this.ctx.ui.notify(emptyMessage, "info");
      return;
    }

    this.diffLines = diffOutput.split("\n");
    this.diffSourceLines = sourceLines ?? buildDiffSourceLines(diffOutput);
    this.diffFocusPane = "diff";
    this.clearVisualSelection();
    this.promptEditor.setText("");
    this.promptEditor.focused = false;
    this.confirmDiscard = false;

    if (fileIndex) {
      this.diffFileIndex = fileIndex;
    } else {
      // Build file index from diff output - parse "diff --git a/... b/..." lines
      // Strip ANSI codes for matching since diff output is colorized
      this.diffFileIndex = [];
      for (let i = 0; i < this.diffLines.length; i++) {
        // eslint-disable-next-line no-control-regex
        const stripped = this.diffLines[i].replace(/\x1b\[[0-9;]*m/g, "");
        const match = stripped.match(/^diff --git a\/(.+?) b\/(.+)/);
        if (match) {
          this.diffFileIndex.push({ line: i, name: match[2] });
        }
      }
    }

    this.diffChunkIndex = chunkIndex ?? [];

    this.recomputeActiveDiff();
    this.diffScrollOffset = initialDiffScrollOffset(this.activeDiffFileIndex);
    this.diffCursorIndex = this.diffScrollOffset;
    this.phase = "diff-viewer";
    this.invalidate();
    this.tui.requestRender();
  }

  /** Generate the diff output for the working tree (staged + unstaged + untracked). */
  private generateWorkingDiff(): {
    diff: string;
    fileIndex: { line: number; name: string }[];
    chunkIndex: number[];
    sourceLines: (DiffSourceLine | undefined)[];
  } {
    const result = generateWorkingDiffOutput({
      hideWhitespace: this.hideWhitespace,
    });
    for (const error of result.errors) {
      this.ctx.ui.notify(error, "error");
    }
    return {
      diff: result.diff,
      fileIndex: result.fileIndex,
      chunkIndex: result.chunkIndex,
      sourceLines: result.sourceLines,
    };
  }

  /** Generate the patch applied by one commit. */
  private generateCommitDiff(commit: string): {
    diff: string;
    fileIndex: { line: number; name: string }[];
    chunkIndex: number[];
    sourceLines: (DiffSourceLine | undefined)[];
  } | null {
    const wsFlag = this.hideWhitespace ? " -w" : "";
    const useDelta = isDeltaAvailable();
    const colorFlag = useDelta ? "" : " --color";
    try {
      let output = execSync(
        `git show${colorFlag}${wsFlag} --format= --patch --no-ext-diff ${commit}`,
        {
          encoding: "utf-8",
          timeout: 10000,
          maxBuffer: DIFF_MAX_BUFFER,
          cwd: process.cwd(),
        },
      );
      const fileIndex = buildFileIndex(output);
      const rawOutput = output;
      let sourceLines = buildDiffSourceLines(rawOutput);
      let chunkIndex: number[] = [];
      if (useDelta) {
        const delta = pipeThroughDelta(output, { forceAvailable: true });
        if (delta.error) this.ctx.ui.notify(delta.error, "error");
        output = delta.text;
        remapFileIndex(fileIndex, output);
        sourceLines = mapSourceLinesToTransformed(rawOutput, output);
        chunkIndex = buildChunkIndex(output.split("\n"));
      }
      return { diff: output, fileIndex, chunkIndex, sourceLines };
    } catch (err: any) {
      this.ctx.ui.notify(
        `Commit diff failed: ${err.stderr?.trim() || err.message}`,
        "error",
      );
      return null;
    }
  }

  /** Generate the diff output for the branch (compared to fork point). */
  private generateBranchDiff(): {
    diff: string;
    fileIndex: { line: number; name: string }[];
    chunkIndex: number[];
    sourceLines: (DiffSourceLine | undefined)[];
  } | null {
    const forkPoint = this.getForkPoint();
    if (!forkPoint) {
      this.ctx.ui.notify(
        "Could not find fork point — no remote branch found in git log",
        "error",
      );
      return null;
    }

    const wsFlag = this.hideWhitespace ? " -w" : "";
    const useDelta = isDeltaAvailable();
    const colorFlag = useDelta ? "" : " --color";
    try {
      let output = execSync(
        `git diff${colorFlag}${wsFlag} ${forkPoint.commit}...HEAD`,
        {
          encoding: "utf-8",
          timeout: 10000,
          maxBuffer: DIFF_MAX_BUFFER,
          cwd: process.cwd(),
        },
      );
      const fileIndex = buildFileIndex(output);
      const rawOutput = output;
      let sourceLines = buildDiffSourceLines(rawOutput);
      let chunkIndex: number[] = [];
      if (useDelta) {
        const delta = pipeThroughDelta(output, { forceAvailable: true });
        if (delta.error) {
          this.ctx.ui.notify(delta.error, "error");
        }
        output = delta.text;
        remapFileIndex(fileIndex, output);
        sourceLines = mapSourceLinesToTransformed(rawOutput, output);
        chunkIndex = buildChunkIndex(output.split("\n"));
      }
      return { diff: output, fileIndex, chunkIndex, sourceLines };
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
    return this.files.length === 0 ? "confirm-branch-check" : "select-files";
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

  private loadSelectedCommitStats(): void {
    const entry = this.logEntries[this.logCursor];
    if (!entry) {
      this.selectedCommitStats = { additions: 0, deletions: 0, files: [] };
      return;
    }
    const cached = this.commitStatsCache.get(entry.hash);
    if (cached) {
      this.selectedCommitStats = cached;
      return;
    }

    try {
      const output = execSync(
        `git show --numstat --format= --no-renames -z ${entry.hash}`,
        {
          encoding: "utf-8",
          timeout: 10000,
          maxBuffer: 10 * 1024 * 1024,
          cwd: process.cwd(),
        },
      );
      const stats: CommitStats = { additions: 0, deletions: 0, files: [] };
      for (const rawRecord of output.split("\0")) {
        const record = rawRecord.replace(/^\n+/, "");
        if (!record) continue;
        const firstTab = record.indexOf("\t");
        const secondTab = record.indexOf("\t", firstTab + 1);
        if (firstTab === -1 || secondTab === -1) continue;
        const additions = Number.parseInt(record.slice(0, firstTab), 10);
        const deletions = Number.parseInt(
          record.slice(firstTab + 1, secondTab),
          10,
        );
        if (!Number.isNaN(additions)) stats.additions += additions;
        if (!Number.isNaN(deletions)) stats.deletions += deletions;
        stats.files.push(record.slice(secondTab + 1));
      }
      this.commitStatsCache.set(entry.hash, stats);
      this.selectedCommitStats = stats;
    } catch (err: any) {
      this.selectedCommitStats = { additions: 0, deletions: 0, files: [] };
      this.ctx.ui.notify(
        `Commit stats failed: ${err.stderr?.trim() || err.message}`,
        "error",
      );
    }
  }

  private openLogList(): void {
    try {
      const output = execSync("git log -n 100 --format=%H%x09%h%x09%s", {
        encoding: "utf-8",
        timeout: 10000,
        maxBuffer: 10 * 1024 * 1024,
        cwd: process.cwd(),
      });
      this.logEntries = output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash = "", shortHash = "", ...subjectParts] = line.split("\t");
          return { hash, shortHash, subject: subjectParts.join("\t") };
        })
        .filter((entry) => entry.hash && entry.shortHash);
      if (this.logEntries.length === 0) {
        this.ctx.ui.notify("No commits to show", "info");
        return;
      }
      this.logCursor = 0;
      this.logScrollOffset = 0;
      this.loadSelectedCommitStats();
      this.logReturnPhase =
        this.phase === "select-files" ? "select-files" : "confirm-branch-check";
      this.phase = "log-list";
      this.invalidate();
      this.tui.requestRender();
    } catch (err: any) {
      this.ctx.ui.notify(
        `git log failed: ${err.stderr?.trim() || err.message}`,
        "error",
      );
    }
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
    const result = this.generateWorkingDiff();
    this.showDiff(
      result.diff,
      "No diff to show",
      result.fileIndex,
      result.chunkIndex,
      result.sourceLines,
    );
  }

  private openBranchDiffViewer(): void {
    this.diffMode = "branch";
    const result = this.generateBranchDiff();
    if (result === null) return;
    this.showDiff(
      result.diff,
      `No diff compared to base branch`,
      result.fileIndex,
      result.chunkIndex,
      result.sourceLines,
    );
  }

  private openCommitDiffViewer(commit: string): void {
    this.diffMode = "commit";
    this.commitDiffHash = commit;
    this.hiddenFiles.clear();
    const result = this.generateCommitDiff(commit);
    if (result === null) return;
    this.showDiff(
      result.diff,
      "No patch for this commit",
      result.fileIndex,
      result.chunkIndex,
      result.sourceLines,
    );
  }

  /** Re-run the current diff (e.g. after toggling whitespace). */
  private refreshDiffViewer(): void {
    let result: {
      diff: string;
      fileIndex: { line: number; name: string }[];
      chunkIndex: number[];
      sourceLines: (DiffSourceLine | undefined)[];
    } | null;
    if (this.diffMode === "branch") {
      result = this.generateBranchDiff();
      if (result === null) return;
    } else if (this.diffMode === "commit") {
      result = this.generateCommitDiff(this.commitDiffHash);
      if (result === null) return;
    } else {
      result = this.generateWorkingDiff();
    }
    // Preserve scroll position as much as possible
    const prevScroll = this.diffScrollOffset;
    const prevCursorRow = this.diffCursorIndex - prevScroll;
    this.showDiff(
      result.diff,
      "No diff to show",
      result.fileIndex,
      result.chunkIndex,
      result.sourceLines,
    );
    this.diffScrollOffset = Math.min(
      prevScroll,
      Math.max(0, this.activeDiffLines.length - 1),
    );
    this.diffCursorIndex = Math.min(
      this.diffScrollOffset + prevCursorRow,
      Math.max(0, this.activeDiffLines.length - 1),
    );
    this.invalidate();
    this.tui.requestRender();
  }

  private handleDiffViewer(data: string): void {
    // Handle y/n confirmation for discarding prompt
    if (this.confirmDiscard) {
      if (matchesKey(data, "y")) {
        this.promptEditor.setText("");
        this.confirmDiscard = false;
        this.diffFocusPane = "diff";
        this.promptEditor.focused = false;
        this.invalidate();
        this.tui.requestRender();
      } else if (matchesKey(data, "n") || matchesKey(data, Key.escape)) {
        this.confirmDiscard = false;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    if (this.visualSelectionAnchor !== null) {
      if (matchesKey(data, Key.escape)) {
        this.clearVisualSelection();
        this.invalidate();
        this.tui.requestRender();
      } else if (matchesKey(data, Key.up)) {
        this.extendVisualSelection(-1);
      } else if (matchesKey(data, Key.down)) {
        this.extendVisualSelection(1);
      } else if (matchesKey(data, "p")) {
        this.insertVisualSelectionIntoPrompt();
      }
      return;
    }

    // Tab: switch focus to prompt when in diff pane
    if (matchesKey(data, Key.tab) && this.diffFocusPane === "diff") {
      this.diffFocusPane = "prompt";
      this.promptEditor.focused = true;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Escape: if in prompt pane, switch back to diff; otherwise exit
    if (matchesKey(data, Key.escape)) {
      if (this.diffFocusPane === "prompt") {
        // If the Editor is showing autocomplete, let it handle Escape first
        if (this.promptEditor.isShowingAutocomplete()) {
          this.promptEditor.handleInput(data);
          this.invalidate();
          this.tui.requestRender();
          return;
        }
        this.diffFocusPane = "diff";
        this.promptEditor.focused = false;
        this.invalidate();
        this.tui.requestRender();
      } else if (this.getPromptText().trim()) {
        this.confirmDiscard = true;
        this.invalidate();
        this.tui.requestRender();
      } else if (this.diffMode === "commit") {
        this.phase = "log-list";
        this.invalidate();
        this.tui.requestRender();
      } else {
        this.onDone();
      }
      return;
    }
    // 'q' only quits when diff pane is focused (not when typing in prompt)
    if (matchesKey(data, "q") && this.diffFocusPane === "diff") {
      if (this.getPromptText().trim()) {
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
      // Ctrl+C in prompt pane: clear text and switch back to diff
      if (matchesKey(data, Key.ctrl("c"))) {
        this.promptEditor.setText("");
        this.diffFocusPane = "diff";
        this.promptEditor.focused = false;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      // Alt+Enter: queue prompt as follow-up instead of sending immediately
      if (matchesKey(data, Key.alt("enter"))) {
        const text = this.getPromptText();
        if (text.trim()) {
          this.submitPrompt(text, "followUp");
        }
        return;
      }
      // Delegate to the native Editor for all prompt input
      this.promptEditor.handleInput(data);
      this.invalidate();
      this.tui.requestRender();
    }
  }

  private handleDiffPaneInput(data: string): void {
    // v = select source lines for a prompt
    if (matchesKey(data, "v")) {
      this.startVisualSelection();
      return;
    }
    // d = scroll down half page
    if (matchesKey(data, "d")) {
      this.scrollDiffBy(10);
      return;
    }
    // u = scroll up half page
    if (matchesKey(data, "u")) {
      this.scrollDiffBy(-10);
      return;
    }
    // g = go to top (first file)
    if (matchesKey(data, "g")) {
      this.jumpDiffTo(initialDiffScrollOffset(this.activeDiffFileIndex));
      return;
    }
    // G = go to bottom (align last line with bottom of pane)
    if (matchesKey(data, Key.shift("g"))) {
      const availableLines = Math.max(5, 30);
      this.jumpDiffTo(
        Math.max(0, this.activeDiffLines.length - availableLines),
      );
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveDiffCursor(1);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveDiffCursor(-1);
      return;
    }
    // f = jump to next file
    if (matchesKey(data, "f")) {
      for (const entry of this.activeDiffFileIndex) {
        if (entry.line > this.diffCursorIndex) {
          this.jumpDiffTo(entry.line);
          return;
        }
      }
      return;
    }
    // F = jump to previous file
    if (matchesKey(data, Key.shift("f"))) {
      for (let i = this.activeDiffFileIndex.length - 1; i >= 0; i--) {
        if (this.activeDiffFileIndex[i].line < this.diffCursorIndex) {
          this.jumpDiffTo(this.activeDiffFileIndex[i].line);
          return;
        }
      }
      return;
    }
    // c = jump to next chunk (delta only)
    if (matchesKey(data, "c")) {
      for (const line of this.activeDiffChunkIndex) {
        if (line > this.diffCursorIndex) {
          this.jumpDiffTo(line);
          return;
        }
      }
      return;
    }
    // C = jump to previous chunk (delta only)
    if (matchesKey(data, Key.shift("c"))) {
      for (let i = this.activeDiffChunkIndex.length - 1; i >= 0; i--) {
        if (this.activeDiffChunkIndex[i] < this.diffCursorIndex) {
          this.jumpDiffTo(this.activeDiffChunkIndex[i]);
          return;
        }
      }
      return;
    }
    // t = toggle hiding test files
    if (matchesKey(data, "t")) {
      this.hideTests = !this.hideTests;
      this.recomputeActiveDiff();
      this.diffScrollOffset = initialDiffScrollOffset(this.activeDiffFileIndex);
      this.diffCursorIndex = this.diffScrollOffset;
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
      this.diffCursorIndex = this.diffScrollOffset;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    // H = unhide all manually hidden files
    if (matchesKey(data, Key.shift("h"))) {
      if (this.hiddenFiles.size === 0) return;
      this.hiddenFiles.clear();
      this.recomputeActiveDiff();
      this.diffCursorIndex = this.diffScrollOffset;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    // e = open current diff file in $PIE_GIT_EDITOR or $EDITOR
    if (matchesKey(data, "e")) {
      const file = this.currentDiffFile();
      if (!file) {
        this.ctx.ui.notify("No file at current scroll position", "error");
        return;
      }
      const editor = process.env.PIE_GIT_EDITOR || process.env.EDITOR || "vi";
      const absolutePath = resolve(this.getRepoRoot(), file);
      try {
        const command = `${editor} ${shellQuote(absolutePath)}`;
        const result = spawnSync("/bin/bash", ["-c", command], {
          cwd: process.cwd(),
          env: process.env,
          stdio: "inherit",
          timeout: 10000,
        });
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
      const sep = this.getPromptText().trim() ? "\n\n" : "";
      this.insertIntoPrompt(sep + file + "\n\n");
      return;
    }
  }

  private jumpDiffTo(index: number): void {
    const firstLine = initialDiffScrollOffset(this.activeDiffFileIndex);
    const lastLine = Math.max(firstLine, this.activeDiffLines.length - 1);
    const availableLines = Math.max(5, 30);
    const maxScroll = Math.max(
      firstLine,
      this.activeDiffLines.length - availableLines,
    );
    this.diffCursorIndex = Math.max(firstLine, Math.min(index, lastLine));
    this.diffScrollOffset = Math.min(this.diffCursorIndex, maxScroll);
    this.invalidate();
    this.tui.requestRender();
  }

  private scrollDiffBy(delta: number): void {
    const firstLine = initialDiffScrollOffset(this.activeDiffFileIndex);
    const availableLines = Math.max(5, 30);
    const maxScroll = Math.max(
      firstLine,
      this.activeDiffLines.length - availableLines,
    );
    const cursorRow = this.diffCursorIndex - this.diffScrollOffset;
    const nextScroll = Math.max(
      firstLine,
      Math.min(this.diffScrollOffset + delta, maxScroll),
    );
    if (nextScroll === this.diffScrollOffset) return;
    this.diffScrollOffset = nextScroll;
    this.diffCursorIndex = Math.min(
      nextScroll + cursorRow,
      Math.max(0, this.activeDiffLines.length - 1),
    );
    this.invalidate();
    this.tui.requestRender();
  }

  private moveDiffCursor(direction: -1 | 1): void {
    const firstLine = initialDiffScrollOffset(this.activeDiffFileIndex);
    const lastLine = Math.max(firstLine, this.activeDiffLines.length - 1);
    const next = Math.max(
      firstLine,
      Math.min(this.diffCursorIndex + direction, lastLine),
    );
    if (next === this.diffCursorIndex) return;
    this.diffCursorIndex = next;
    const availableLines = Math.max(5, 30);
    if (next < this.diffScrollOffset) {
      this.diffScrollOffset = next;
    } else if (next >= this.diffScrollOffset + availableLines) {
      this.diffScrollOffset = next - availableLines + 1;
    }
    this.invalidate();
    this.tui.requestRender();
  }

  private startVisualSelection(): void {
    const currentFile = this.currentDiffFile();
    let lineIndex = this.activeDiffSourceLines.findIndex(
      (line, index) =>
        index >= this.diffCursorIndex &&
        line !== undefined &&
        (!currentFile || line.file === currentFile),
    );
    if (lineIndex === -1) {
      for (let index = this.diffCursorIndex - 1; index >= 0; index--) {
        const line = this.activeDiffSourceLines[index];
        if (line && (!currentFile || line.file === currentFile)) {
          lineIndex = index;
          break;
        }
      }
    }
    if (lineIndex === -1) {
      this.ctx.ui.notify("No source line at current diff position", "error");
      return;
    }
    this.diffCursorIndex = lineIndex;
    this.visualSelectionAnchor = lineIndex;
    this.visualSelectionEnd = lineIndex;
    this.invalidate();
    this.tui.requestRender();
  }

  private clearVisualSelection(): void {
    this.visualSelectionAnchor = null;
    this.visualSelectionEnd = null;
  }

  private extendVisualSelection(direction: -1 | 1): void {
    if (
      this.visualSelectionAnchor === null ||
      this.visualSelectionEnd === null
    ) {
      return;
    }
    const current = this.activeDiffSourceLines[this.visualSelectionEnd];
    if (!current) return;
    for (
      let index = this.visualSelectionEnd + direction;
      index >= 0 && index < this.activeDiffSourceLines.length;
      index += direction
    ) {
      const line = this.activeDiffSourceLines[index];
      if (!line) continue;
      if (line.file !== current.file) return;
      this.visualSelectionEnd = index;
      this.diffCursorIndex = index;
      const availableLines = Math.max(5, 30);
      if (index < this.diffScrollOffset) {
        this.diffScrollOffset = index;
      } else if (index >= this.diffScrollOffset + availableLines) {
        this.diffScrollOffset = index - availableLines + 1;
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }
  }

  private selectedSourceLines(): DiffSourceLine[] {
    if (
      this.visualSelectionAnchor === null ||
      this.visualSelectionEnd === null
    ) {
      return [];
    }
    const start = Math.min(this.visualSelectionAnchor, this.visualSelectionEnd);
    const end = Math.max(this.visualSelectionAnchor, this.visualSelectionEnd);
    return this.activeDiffSourceLines
      .slice(start, end + 1)
      .filter((line): line is DiffSourceLine => line !== undefined);
  }

  private insertVisualSelectionIntoPrompt(): void {
    const selected = this.selectedSourceLines();
    if (selected.length === 0) return;
    const firstLine = Math.min(...selected.map((line) => line.line));
    const lastLine = Math.max(...selected.map((line) => line.line));
    const lineRange =
      firstLine === lastLine ? `${firstLine}` : `${firstLine}-${lastLine}`;
    const quote = selected
      .map((line) => `> ${line.prefix}${line.text}`)
      .join("\n");
    const sep = this.getPromptText().trim() ? "\n\n" : "";
    this.clearVisualSelection();
    this.insertIntoPrompt(
      `${sep}${selected[0].file}:${lineRange}\n${quote}\n\n`,
    );
  }

  private isDiffLineSelected(index: number): boolean {
    if (
      this.visualSelectionAnchor === null ||
      this.visualSelectionEnd === null
    ) {
      return false;
    }
    return (
      index >= Math.min(this.visualSelectionAnchor, this.visualSelectionEnd) &&
      index <= Math.max(this.visualSelectionAnchor, this.visualSelectionEnd) &&
      this.activeDiffSourceLines[index] !== undefined
    );
  }

  /** Get the current file name based on the diff cursor position. */
  private currentDiffFile(): string {
    let name = "";
    for (const entry of this.activeDiffFileIndex) {
      if (entry.line <= this.diffCursorIndex) {
        name = entry.name;
      } else {
        break;
      }
    }
    return name;
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
    } catch (err: any) {
      if (err.code === "ENOBUFS") {
        const detail = err.stderr?.trim() || err.message;
        this.ctx.ui.notify(
          `Too many changed files for /git to display. ${detail}`,
          "error",
        );
        this.onDone();
        return;
      }
      const detail = err.stderr?.trim() || err.message;
      this.ctx.ui.notify(`git status failed: ${detail}`, "error");
    }
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
    // Don't use cache in diff-viewer phase — the embedded Editor can
    // update asynchronously (e.g. autocomplete results arriving).
    if (
      this.cachedLines &&
      this.cachedWidth === width &&
      this.phase !== "diff-viewer"
    ) {
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
              "  ↑↓ navigate • l log • tab select • a all • u unselect • d diff • b branch diff • c commit • enter confirm • esc quit",
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
      this.commandInput.focused = true;
      lines.push("  " + this.commandInput.render(width - 2)[0]);
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
              `  ${sanitizeLine(rl)}`,
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
    } else if (this.phase === "confirm-branch-check") {
      lines.push("");
      lines.push(theme.fg("muted", "  No uncommitted changes."));
      lines.push(
        theme.fg("muted", "  Check branch status? This may take a moment."),
      );
      lines.push("");
      lines.push(theme.fg("dim", "─".repeat(width)));
      lines.push(
        theme.fg("dim", "  enter check branch status • l log • esc quit"),
      );
    } else if (this.phase === "log-list") {
      lines.push(...this.renderLogList(width));
      lines.push(theme.fg("dim", "─".repeat(width)));
      const escapeHint =
        this.logReturnPhase === "select-files" ? "esc back" : "esc quit";
      lines.push(
        theme.fg(
          "dim",
          `  ↑↓ navigate • d/u page • g top • enter diff • ${escapeHint}`,
        ),
      );
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
      const visualSelectionLabel =
        this.visualSelectionAnchor !== null
          ? theme.fg("accent", " (Visual selection)")
          : "";
      const diffHeader = diffFocused
        ? theme.fg("accent", theme.bold(" ▶ Diff")) +
          visualSelectionLabel +
          testsHiddenLabel +
          wsHiddenLabel +
          filesHiddenLabel +
          theme.fg("muted", fileLabel)
        : theme.fg("dim", "   Diff") +
          visualSelectionLabel +
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
        const marker = this.isDiffLineSelected(i)
          ? theme.fg("accent", "▌")
          : i === this.diffCursorIndex
            ? theme.fg(diffFocused ? "accent" : "dim", "▶")
            : " ";
        leftLines.push(
          truncateToWidth(
            marker + sanitizeLine(this.activeDiffLines[i]),
            diffPaneWidth,
          ),
        );
      }
      // Pad diff pane
      for (let i = leftLines.length; i < availableLines; i++) {
        leftLines.push("");
      }

      // Build prompt lines using the native Editor component
      this.promptEditor.focused = this.diffFocusPane === "prompt";
      const editorRendered = this.promptEditor.render(promptPaneWidth);
      // Strip the Editor's own top/bottom border lines — the split pane has its own
      const editorContent = editorRendered.slice(1, -1);
      const rightLines: string[] = [];

      // If prompt is empty and diff pane is focused, show placeholder;
      // otherwise show the Editor (which renders the cursor)
      if (this.getPromptText() === "" && diffFocused) {
        const placeholder = theme.fg("dim", "Prompt pi for changes...");
        rightLines.push(truncateToWidth(" " + placeholder, promptPaneWidth));
      } else {
        for (
          let i = 0;
          i < Math.min(editorContent.length, availableLines);
          i++
        ) {
          rightLines.push(truncateToWidth(editorContent[i], promptPaneWidth));
        }
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
      let legend: string;
      if (diffFocused) {
        if (this.visualSelectionAnchor !== null) {
          legend = `  Visual selection · ↑↓ extend · p prompt · esc cancel  ${position}`;
        } else {
          const chunkHint =
            this.activeDiffChunkIndex.length > 0
              ? " · c/C next/prev chunk"
              : "";
          const helpLeft = `v select · d↓ u↑ · g/G top/bottom · f/F next/prev file${chunkHint} · e edit · p prompt · ${hideTestsHint} · ${hideWsHint} · ${hideFileHint}`;
          const escapeHint =
            this.diffMode === "commit" ? "esc back" : "esc quit";
          legend = `  ${helpLeft}  │  tab prompt · ${escapeHint}  ${position}`;
        }
      } else {
        const hints = `enter send · opt+enter follow-up · \\+enter newline · tab complete · ↑↓ history · ^C clear · esc back`;
        legend = `  ${hints}`;
      }
      lines.push(truncateToWidth(theme.fg("dim", legend), width));

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

  private renderLogList(width: number): string[] {
    const rowCount = 20;
    const panelWidth = Math.min(
      Math.max(24, Math.floor(width * 0.35)),
      Math.max(1, width - 21),
    );
    const listWidth = Math.max(1, width - panelWidth - 1);

    if (this.logCursor < this.logScrollOffset) {
      this.logScrollOffset = this.logCursor;
    } else if (this.logCursor >= this.logScrollOffset + rowCount) {
      this.logScrollOffset = this.logCursor - rowCount + 1;
    }

    const leftLines: string[] = [];
    const end = Math.min(
      this.logScrollOffset + rowCount,
      this.logEntries.length,
    );
    for (let i = this.logScrollOffset; i < end; i++) {
      const entry = this.logEntries[i];
      const selected = i === this.logCursor;
      const pointer = selected ? "▸" : " ";
      const text = `  ${pointer} ${entry.shortHash} ${sanitizeLine(entry.subject)}`;
      leftLines.push(
        truncateToWidth(
          this.theme.fg(selected ? "accent" : "dim", text),
          listWidth,
        ),
      );
    }
    while (leftLines.length < rowCount) leftLines.push("");

    const stats = this.selectedCommitStats;
    const rightLines = [
      this.theme.fg("accent", this.theme.bold("  Commit changes")),
      "  " +
        this.theme.fg("success", `+${stats.additions}`) +
        " " +
        this.theme.fg("error", `-${stats.deletions}`),
      "",
      this.theme.fg("muted", `  Files changed (${stats.files.length})`),
    ];
    const maxFileRows = rowCount - rightLines.length;
    const shownFileCount =
      stats.files.length > maxFileRows ? maxFileRows - 1 : stats.files.length;
    for (const file of stats.files.slice(0, shownFileCount)) {
      rightLines.push(this.theme.fg("dim", `  ${sanitizeLine(file)}`));
    }
    if (shownFileCount < stats.files.length) {
      rightLines.push(this.theme.fg("dim", "  [more files...]"));
    }
    while (rightLines.length < rowCount) rightLines.push("");

    const lines: string[] = [];
    for (let i = 0; i < rowCount; i++) {
      const left = truncateToWidth(leftLines[i], listWidth);
      const right = truncateToWidth(rightLines[i], panelWidth);
      const leftPadded =
        left + " ".repeat(Math.max(0, listWidth - visibleWidth(left)));
      lines.push(leftPadded + this.theme.fg("dim", "│") + right);
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

// --- Diff source line mapping ---

function stripTerminalStyles(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function buildDiffSourceLines(rawDiff: string): (DiffSourceLine | undefined)[] {
  const lines = rawDiff.split("\n");
  const sourceLines: (DiffSourceLine | undefined)[] = new Array(lines.length);
  let file = "";
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (let index = 0; index < lines.length; index++) {
    const line = stripTerminalStyles(lines[index]);
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      file = fileMatch[2];
      inHunk = false;
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = Number.parseInt(hunkMatch[1], 10);
      newLine = Number.parseInt(hunkMatch[2], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk || !file) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      sourceLines[index] = {
        file,
        line: newLine,
        prefix: "+",
        text: line.slice(1),
      };
      newLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      sourceLines[index] = {
        file,
        line: oldLine,
        prefix: "-",
        text: line.slice(1),
      };
      oldLine++;
    } else if (line.startsWith(" ")) {
      sourceLines[index] = {
        file,
        line: newLine,
        prefix: " ",
        text: line.slice(1),
      };
      oldLine++;
      newLine++;
    } else if (!line.startsWith("\\")) {
      inHunk = false;
    }
  }

  return sourceLines;
}

function mapSourceLinesToTransformed(
  rawDiff: string,
  transformedDiff: string,
): (DiffSourceLine | undefined)[] {
  const rawSourceLines = buildDiffSourceLines(rawDiff).filter(
    (line): line is DiffSourceLine => line !== undefined,
  );
  const transformedLines = transformedDiff.split("\n");
  const normalized = transformedLines.map((line) =>
    sanitizeLine(stripTerminalStyles(line)).trimEnd(),
  );
  const mapped: (DiffSourceLine | undefined)[] = new Array(
    transformedLines.length,
  );
  let transformedIndex = 0;

  const findLine = (text: string, start: number): number => {
    const target = sanitizeLine(text).trimEnd();
    for (let index = start; index < normalized.length; index++) {
      if (
        normalized[index] === target ||
        (target.length > 0 && normalized[index].endsWith(target))
      ) {
        return index;
      }
    }
    return -1;
  };

  for (let index = 0; index < rawSourceLines.length; index++) {
    const sourceLine = rawSourceLines[index];
    if (sourceLine.text.trimEnd() !== "") {
      const match = findLine(sourceLine.text, transformedIndex);
      if (match !== -1) {
        mapped[match] = sourceLine;
        transformedIndex = match + 1;
      }
      continue;
    }

    let runEnd = index;
    while (
      runEnd + 1 < rawSourceLines.length &&
      rawSourceLines[runEnd + 1].text.trimEnd() === ""
    ) {
      runEnd++;
    }
    const runLength = runEnd - index + 1;
    const nextSourceLine = rawSourceLines[runEnd + 1];
    const nextMatch = nextSourceLine
      ? findLine(nextSourceLine.text, transformedIndex)
      : normalized.length;
    const searchEnd = nextMatch === -1 ? normalized.length : nextMatch;
    const blankMatches: number[] = [];
    for (let candidate = transformedIndex; candidate < searchEnd; candidate++) {
      if (normalized[candidate] === "") blankMatches.push(candidate);
    }
    const selectedMatches = blankMatches.slice(-runLength);
    for (let offset = 0; offset < selectedMatches.length; offset++) {
      mapped[selectedMatches[offset]] = rawSourceLines[index + offset];
    }
    if (selectedMatches.length > 0) {
      transformedIndex = selectedMatches[selectedMatches.length - 1] + 1;
    }
    index = runEnd;
  }

  return mapped;
}

// --- Delta integration ---

let _deltaAvailable: boolean | undefined;

/**
 * Check if the `delta` command is available on the PATH.
 * Result is cached for the lifetime of the process.
 */
export function isDeltaAvailable(): boolean {
  if (_deltaAvailable === undefined) {
    try {
      execSync("which delta", {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      _deltaAvailable = true;
    } catch {
      _deltaAvailable = false;
    }
  }
  return _deltaAvailable;
}

/**
 * Pipe raw diff text through `delta` for syntax-highlighted output.
 * Falls back to returning the input unchanged if delta is unavailable or fails.
 *
 * @param diffText - Raw or colorized diff text
 * @param opts.forceAvailable - Override the delta availability check
 */
export function pipeThroughDelta(
  diffText: string,
  opts?: { forceAvailable?: boolean; deltaCommand?: string },
): { text: string; error?: string } {
  const available = opts?.forceAvailable ?? isDeltaAvailable();
  if (!available) return { text: diffText };

  const cmd = opts?.deltaCommand ?? "delta --paging=never";
  try {
    return {
      text: execSync(cmd, {
        input: diffText,
        encoding: "utf-8",
        timeout: 15000,
        maxBuffer: DIFF_MAX_BUFFER,
        cwd: process.cwd(),
      }),
    };
  } catch (err: any) {
    const detail = err.stderr?.trim() || err.message;
    return {
      text: diffText,
      error: `delta failed: ${detail}`,
    };
  }
}

/**
 * Build a file index from raw diff output by parsing "diff --git a/... b/..." lines.
 */
export function buildFileIndex(
  rawDiff: string,
): { line: number; name: string }[] {
  const index: { line: number; name: string }[] = [];
  const lines = rawDiff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // eslint-disable-next-line no-control-regex
    const stripped = lines[i].replace(/\x1b\[[0-9;]*m/g, "");
    const match = stripped.match(/^diff --git a\/(.+?) b\/(.+)/);
    if (match) {
      index.push({ line: i, name: match[2] });
    }
  }
  return index;
}

/**
 * After delta transforms the diff, remap file index line numbers.
 * Delta replaces "diff --git" headers with styled lines containing the file name.
 * We search for each file name in the delta output to find new positions.
 */
export function remapFileIndex(
  fileIndex: { line: number; name: string }[],
  deltaOutput: string,
): void {
  const lines = deltaOutput.split("\n");
  // For each file, find the first line in delta output containing the file name
  // that hasn't been claimed by a previous file. Delta preserves file order.
  let searchFrom = 0;
  for (const entry of fileIndex) {
    for (let i = searchFrom; i < lines.length; i++) {
      // Strip ANSI codes and non-ASCII decorations for matching
      /* eslint-disable no-control-regex */
      const stripped = lines[i]
        .replace(/\x1b\[[0-9;]*m/g, "")
        .replace(/[^\x20-\x7e]/g, "")
        .trim();
      /* eslint-enable no-control-regex */
      if (stripped.includes(entry.name)) {
        entry.line = i;
        searchFrom = i + 1;
        break;
      }
    }
  }
}

/**
 * Remap chunk indices when sections are filtered (e.g. hideTests, hiddenFiles).
 * Chunks that fall within excluded sections are dropped; surviving ones get
 * new line numbers matching the filtered output.
 */
export function remapChunkIndex(
  chunkIndex: number[],
  sections: { name: string; startLine: number; endLine: number }[],
  preambleEnd: number,
  opts: { hideTests: boolean; hiddenFiles: Set<string> },
): number[] {
  if (chunkIndex.length === 0) return [];
  const testPattern = /test/i;
  const lineMap = new Map<number, number>();
  let filteredIdx = preambleEnd; // preamble lines are 1:1
  for (const section of sections) {
    if (opts.hideTests && testPattern.test(section.name)) continue;
    if (opts.hiddenFiles.has(section.name)) continue;
    for (let i = section.startLine; i < section.endLine; i++) {
      lineMap.set(i, filteredIdx);
      filteredIdx++;
    }
  }
  const result: number[] = [];
  for (const chunkLine of chunkIndex) {
    const mapped = lineMap.get(chunkLine);
    if (mapped !== undefined) {
      result.push(mapped);
    }
  }
  return result;
}

/**
 * Compute the initial scroll offset for the diff viewer so that it starts
 * at the first file header.  When delta adds preamble lines before the
 * first file, this ensures the file is selected from the start (so `e`
 * works and `f` advances to the *second* file).
 */
export function initialDiffScrollOffset(
  fileIndex: { line: number; name: string }[],
): number {
  if (fileIndex.length === 0) return 0;
  return fileIndex[0].line;
}

/**
 * Build a chunk index from delta-processed diff output.
 * Delta renders @@ hunk headers as a 3-line box:
 *   ─────────────────┐   (top border with ┐)
 *   • 10: class Foo { │  (bullet + line number)
 *   ─────────────────┘   (bottom border with ┘)
 *
 * We detect the bullet line (• followed by a number and colon) and return
 * the line index of the top border (one line above) so scrolling lands
 * at the start of the box.
 */
export function buildChunkIndex(lines: string[]): number[] {
  const index: number[] = [];
  /* eslint-disable no-control-regex */
  const bulletPattern = /^\u2022 \d+:/;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (bulletPattern.test(stripped) && i > 0) {
      // The top border is the line before the bullet line
      index.push(i - 1);
    }
  }
  /* eslint-enable no-control-regex */
  return index;
}

// --- Exported diff generation (used by tests) ---

const DIFF_MAX_BUFFER = 50 * 1024 * 1024; // 50 MB

/**
 * Generate the diff output for the working tree (staged + unstaged + untracked).
 * Exported for testing.
 *
 * When `useDelta` is true (default: auto-detected), diff output is piped
 * through the `delta` command for syntax highlighting.
 */
export function generateWorkingDiffOutput(opts: {
  hideWhitespace: boolean;
  useDelta?: boolean;
}): {
  diff: string;
  errors: string[];
  fileIndex: { line: number; name: string }[];
  chunkIndex: number[];
  sourceLines: (DiffSourceLine | undefined)[];
} {
  const useDelta = opts.useDelta ?? isDeltaAvailable();
  let diffOutput = "";
  const errors: string[] = [];
  const wsFlag = opts.hideWhitespace ? " -w" : "";
  // When using delta, omit --color so delta handles all coloring
  const colorFlag = useDelta ? "" : " --color";

  // Show full diff of all changes (staged + unstaged), like `git diff`
  try {
    const staged = execSync(`git diff${colorFlag} --cached${wsFlag}`, {
      encoding: "utf-8",
      timeout: 10000,
      maxBuffer: DIFF_MAX_BUFFER,
      cwd: process.cwd(),
    });
    if (staged) diffOutput += staged;
  } catch (err: any) {
    const detail = err.stderr?.trim() || err.message;
    if (detail) errors.push(`git diff --cached failed: ${detail}`);
  }
  try {
    const unstaged = execSync(`git diff${colorFlag}${wsFlag}`, {
      encoding: "utf-8",
      timeout: 10000,
      maxBuffer: DIFF_MAX_BUFFER,
      cwd: process.cwd(),
    });
    if (unstaged) diffOutput += (diffOutput ? "\n" : "") + unstaged;
  } catch (err: any) {
    const detail = err.stderr?.trim() || err.message;
    if (detail) errors.push(`git diff failed: ${detail}`);
  }

  // Include untracked files as pseudo-diffs
  const untrackedFiles = getUntrackedFiles();

  for (const f of untrackedFiles) {
    try {
      const content = readFileSync(f, "utf-8");
      const contentLines = content.split("\n");
      const lineCount = contentLines.length;
      const hunkHeader = `@@ -0,0 +1,${lineCount} @@`;
      if (useDelta) {
        // Raw diff format for delta to colorize
        const header =
          `diff --git a/${f} b/${f}\n` +
          `new file mode 100644\n` +
          `--- /dev/null\n` +
          `+++ b/${f}\n` +
          `${hunkHeader}\n`;
        const rawLines = contentLines.map((l) => `+${l}`).join("\n");
        diffOutput += (diffOutput ? "\n" : "") + header + rawLines;
      } else {
        const header =
          `\x1b[1mdiff --git a/${f} b/${f}\x1b[m\n` +
          `\x1b[1mnew file mode 100644\x1b[m\n` +
          `\x1b[1m--- /dev/null\x1b[m\n` +
          `\x1b[1m+++ b/${f}\x1b[m\n` +
          `\x1b[36m${hunkHeader}\x1b[m\n`;
        const coloredLines = contentLines
          .map((l) => `\x1b[32m+${l}\x1b[m`)
          .join("\n");
        diffOutput += (diffOutput ? "\n" : "") + header + coloredLines;
      }
    } catch (err: any) {
      errors.push(`Failed to read ${f}: ${err.message}`);
    }
  }

  // Build indices from the raw diff before delta transforms the output.
  const fileIndex = buildFileIndex(diffOutput);
  const rawDiffOutput = diffOutput;
  let sourceLines = buildDiffSourceLines(rawDiffOutput);

  // Pipe the entire diff through delta for syntax highlighting
  let chunkIndex: number[] = [];
  if (useDelta) {
    const delta = pipeThroughDelta(diffOutput, { forceAvailable: true });
    if (delta.error) {
      errors.push(delta.error);
    }
    diffOutput = delta.text;
    sourceLines = mapSourceLinesToTransformed(rawDiffOutput, diffOutput);
    // Rebuild line positions: delta changes line count, so find each file
    // name in the delta output. Delta renders file names in its headers.
    remapFileIndex(fileIndex, diffOutput);
    chunkIndex = buildChunkIndex(diffOutput.split("\n"));
  }

  return { diff: diffOutput, errors, fileIndex, chunkIndex, sourceLines };
}

// --- File path autocomplete provider ---

export class FilePathAutocompleteProvider implements AutocompleteProvider {
  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    _options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    // Extract the word at cursor that looks like a file path
    const line = lines[cursorLine] || "";
    const before = line.slice(0, cursorCol);
    // Match a path-like prefix: starts after whitespace or start of line
    const match = before.match(/(?:^|\s)([\w.@\-/][\w.@\-/]*)$/);
    if (!match) return null;
    const prefix = match[1];
    if (prefix.length < 2) return null;
    // Strip leading ./ — git ls-files returns paths without it
    const strippedPrefix = prefix.replace(/^\.\//, "");

    try {
      const escaped = strippedPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const output = execSync(
        `git ls-files --cached --others --exclude-standard 2>/dev/null | grep -i "^${escaped}" | head -20`,
        { encoding: "utf-8", timeout: 3000, cwd: process.cwd() },
      );
      const matches = output.split("\n").filter((f) => f.trim());
      if (matches.length === 0) return null;
      return {
        prefix,
        items: matches.slice(0, 20).map((f) => ({
          value: f,
          label: f,
        })),
      };
    } catch {
      return null;
    }
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const line = lines[cursorLine] || "";
    const prefixStart = cursorCol - prefix.length;
    const newLine =
      line.slice(0, prefixStart) + item.value + line.slice(cursorCol);
    const newLines = [...lines];
    newLines[cursorLine] = newLine;
    return {
      lines: newLines,
      cursorLine,
      cursorCol: prefixStart + item.value.length,
    };
  }
}

// --- Extension entry point ---

/**
 * Replace hard tabs with two spaces so visibleWidth math stays
 * correct for the diff viewer (tabs render as variable widths in
 * terminals; without normalization, lines overflow the pane).
 * Exported for unit testing.
 */
export function sanitizeLine(line: string): string {
  return line.replace(/\t/g, "  ");
}

/**
 * The narrow subset of `ExtensionAPI` this extension uses. Declared here
 * (rather than in tests) so any drift between the real wiring and a
 * test mock is caught at compile time: if the extension starts using a
 * new pi method, this type widens and any mock that doesn't implement
 * it stops compiling.
 */
export type GitPi = Pick<ExtensionAPI, "registerCommand" | "sendUserMessage">;

export default function (pi: GitPi) {
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
        const detail = err.stderr?.trim() || err.message;
        const msg =
          err.code === "ENOBUFS"
            ? `Too many changed files for /git to display. ${detail}`
            : `git status failed: ${detail}`;
        ctx.ui.notify(msg, "error");
        return;
      }

      const files = parseGitStatus(output);

      await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
        // Clear stale lines when switching from tall phases (diff viewer) to shorter ones
        (tui as any).setClearOnShrink(true);
        const component = new GitComponent({
          files,
          tui,
          theme,
          onDone: (prompt?: string) => done(prompt),
          sendPrompt: (text: string) =>
            pi.sendUserMessage(text, { deliverAs: "steer" }),
          queueFollowUp: (text: string) =>
            pi.sendUserMessage(text, { deliverAs: "followUp" }),
          ctx,
        });
        return {
          render: (w: number) => component.render(w),
          invalidate: () => component.invalidate(),
          handleInput: (data: string) => {
            component.handleInput(data);
          },
        };
      });
    },
  });
}
