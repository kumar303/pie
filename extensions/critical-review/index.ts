/**
 * Critical Review Extension
 *
 * Perform a critical code review with specialist sub agents,
 * filtered for review quality.
 *
 * Usage:
 *   /critical-review            Start a review
 *   /critical-review -fix       Implement suggested fixes
 *   /critical-review -fix-loop  Fix and re-review in a loop
 *   /critical-review -watch     Open the log viewer
 *   /critical-review -abort     Abort ongoing review
 *   /critical-review -help      Show usage
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Text,
  Editor,
  type EditorTheme,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  fuzzyFilter,
} from "@earendil-works/pi-tui";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { copyToClipboard } from "./clipboard.js";
import { fileURLToPath } from "node:url";

// ── Types ────────────────────────────────────────────────────────────

type SimpleKind = "help" | "watch" | "abort" | "fix" | "fix-loop" | "review";

export type ParseResult =
  | { kind: SimpleKind }
  | { kind: "invalid"; reason: string };

export interface ReviewerConfig {
  name: string;
  description: string;
  tools: string[];
  systemPrompt: string;
  filePath: string;
  canEditCode: boolean;
}

export interface ReviewIssue {
  file: string;
  line: number;
  severity: "high" | "medium" | "low";
  title: string;
  description: string;
  reviewer: string;
}

export type CriticalReviewPi = Pick<
  ExtensionAPI,
  "on" | "registerCommand" | "sendUserMessage"
>;

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
  cost: number;
}

function emptyUsage(): UsageStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turns: 0,
    cost: 0,
  };
}

function addUsage(target: UsageStats, source: UsageStats): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.turns += source.turns;
  target.cost += source.cost;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

interface ExtensionOptions {
  reviewersDir?: string;
  userReviewersDir?: string;
  configPath?: string;
}

export const USER_REVIEWERS_DIR = join(
  homedir(),
  ".local",
  "share",
  "critical-review-pi",
  "reviewers",
);

export const DEFAULT_CONFIG_PATH = join(
  homedir(),
  ".local",
  "share",
  "critical-review-pi",
  "config.json",
);

export const DEFAULT_MODEL = "claude-sonnet-4-5";
export const DEFAULT_REASONING = "off";

/**
 * Find the latest "claude opus" model among the given model names. Latest is
 * the highest major/minor version; for an equal version the undated alias
 * (e.g. `claude-opus-4-1`) is preferred over a dated snapshot
 * (`claude-opus-4-1-20250805`). Returns undefined if none match.
 */
export function findLatestClaudeOpusModel(
  models: Iterable<string>,
): string | undefined {
  const candidates = [...models].filter((m) => {
    const modelPart = m.includes("/") ? m.split("/").pop()! : m;
    const lower = modelPart.toLowerCase();
    return lower.includes("claude") && lower.includes("opus");
  });
  if (candidates.length === 0) return undefined;

  const versionKey = (name: string): [number, number, number] => {
    const modelPart = name.includes("/") ? name.split("/").pop()! : name;
    const match = modelPart
      .toLowerCase()
      .match(/opus[-_]?(\d+)[-_.](\d+)(?:[-_.](\d+))?/);
    if (!match) return [0, 0, -1];
    // Undated alias sorts after any dated snapshot of the same version.
    return [
      Number(match[1]),
      Number(match[2]),
      match[3] ? Number(match[3]) : Infinity,
    ];
  };

  return [...candidates].sort((a, b) => {
    const [aMaj, aMin, aSnap] = versionKey(a);
    const [bMaj, bMin, bSnap] = versionKey(b);
    if (aMaj !== bMaj) return bMaj - aMaj;
    if (aMin !== bMin) return bMin - aMin;
    return bSnap - aSnap;
  })[0];
}

export interface ReviewerModelEntry {
  model: string;
  reasoning: string;
}

export type ModelConfig = Record<string, ReviewerModelEntry>;

/** The model/reasoning a reviewer gets when it has no saved config entry. */
export function defaultModelEntry(
  knownModels: Iterable<string>,
): ReviewerModelEntry {
  return {
    model: findLatestClaudeOpusModel(knownModels) ?? DEFAULT_MODEL,
    reasoning: DEFAULT_REASONING,
  };
}

export function loadModelConfig(configPath: string): ModelConfig {
  if (!existsSync(configPath)) return {};
  const content = readFileSync(configPath, "utf-8");
  return JSON.parse(content) as ModelConfig;
}

export function saveModelConfig(configPath: string, config: ModelConfig): void {
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

const VALID_REASONING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export function parsePiModelList(output: string): Set<string> {
  const models = new Set<string>();
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[0] !== "provider") {
      models.add(`${parts[0]}/${parts[1]}`);
    }
  }
  return models;
}

/** Accept both `provider/model` (exact) and bare `model` (suffix match). */
function modelMatchesKnown(model: string, knownModels: Set<string>): boolean {
  if (model.includes("/")) return false;
  for (const known of knownModels) {
    if (known.endsWith(`/${model}`)) return true;
  }
  return false;
}

export function validateModelConfig(
  config: ModelConfig,
  knownModels: Set<string>,
): string[] {
  const errors: string[] = [];
  for (const [name, entry] of Object.entries(config)) {
    if (!entry.model || entry.model.trim() === "") {
      errors.push(`Reviewer "${name}": model is required`);
    } else if (
      !knownModels.has(entry.model) &&
      !modelMatchesKnown(entry.model, knownModels)
    ) {
      errors.push(`Reviewer "${name}": unknown model "${entry.model}"`);
    }
    if (!VALID_REASONING_LEVELS.has(entry.reasoning)) {
      errors.push(
        `Reviewer "${name}": invalid reasoning "${entry.reasoning}" (valid: ${[...VALID_REASONING_LEVELS].join(", ")})`,
      );
    }
  }
  return errors;
}

// ── Command definitions ──────────────────────────────────────────────

interface CommandDef {
  flag: string;
  kind: SimpleKind;
  description: string;
}

export const COMMAND_DEFS: CommandDef[] = [
  { flag: "-help", kind: "help", description: "Show this help" },
  { flag: "-watch", kind: "watch", description: "Open the log viewer" },
  { flag: "-abort", kind: "abort", description: "Abort an ongoing review" },
  {
    flag: "-fix",
    kind: "fix",
    description: "Start a review and implement all fixes",
  },
  {
    flag: "-fix-loop",
    kind: "fix-loop",
    description: "Fix and re-review until clean (max 10 iterations)",
  },
];

const FLAG_TO_KIND = new Map(COMMAND_DEFS.map((d) => [d.flag, d.kind]));

export function parseArgs(args: string): ParseResult {
  const trimmed = args.trim();
  if (!trimmed) return { kind: "review" };
  const kind = FLAG_TO_KIND.get(trimmed);
  if (kind) return { kind };
  if (trimmed.startsWith("-")) {
    return {
      kind: "invalid",
      reason: `Unknown flag: ${trimmed}. Use -help for usage.`,
    };
  }
  return {
    kind: "invalid",
    reason: `Unexpected argument: ${trimmed}. Use -help for usage.`,
  };
}

export function buildUsageLines(): string[] {
  const maxFlag = Math.max(...COMMAND_DEFS.map((d) => d.flag.length));
  return [
    "Usage: /critical-review [option]",
    "",
    "Options:",
    `  (none)${" ".repeat(maxFlag - 2)}  Start a code review`,
    ...COMMAND_DEFS.map((d) => `  ${d.flag.padEnd(maxFlag)}  ${d.description}`),
    "",
    "Requirements: gh CLI tool",
  ];
}

// ── Status bar ───────────────────────────────────────────────────────

export function formatElapsed(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

export function buildStatusBarLines(opts: {
  state: "running" | "finished" | "failed";
  step: string;
  elapsedMs: number;
}): string[] {
  const elapsed = formatElapsed(opts.elapsedMs);
  const icon =
    opts.state === "running" ? "⏳" : opts.state === "finished" ? "✓" : "✗";
  return [
    `${icon} /critical-review • ${opts.step} • ${elapsed} • See -help for usage`,
  ];
}

// ── Watch panel ──────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g;
const FUN_ASCII_SYMBOLS = ["@", "#", "%", "&", "$", "~", "^"] as const;
const GLYPH_TO_ASCII: Record<string, string> = {
  "\u2705": "v",
  "\u2714": "v",
  "\u2713": "v",
  "\u2718": "x",
  "\u274C": "x",
  "\u26A0": "!",
  "\u26A0\uFE0F": "!",
  "\u2139": "i",
  "\u2139\uFE0F": "i",
  "\uD835\uDC56": "i",
  "\uD83C\uDF32": "*",
  "\uD83D\uDD04": "~",
  "\uD83E\uDD5E": "=",
};

function sanitizeWatchLine(line: string): string {
  const stripped = stripAnsi(line)
    .replace(/\r/g, "")
    .replace(/\t/g, "  ")
    .replace(CONTROL_CHARS_RE, "");
  let safe = "";
  for (const ch of Array.from(stripped)) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) {
      safe += ch;
      continue;
    }
    const mapped = GLYPH_TO_ASCII[ch];
    safe += mapped ?? FUN_ASCII_SYMBOLS[code % FUN_ASCII_SYMBOLS.length];
  }
  return safe;
}

function clipAndPad(line: string, width: number): string {
  const truncated = truncateToWidth(line, width);
  const visWidth = visibleWidth(truncated);
  return truncated + " ".repeat(Math.max(0, width - visWidth));
}

export function buildWatchPanelFrame(opts: {
  logLines: string[];
  offset: number;
  height: number;
  width: number;
}): string[] {
  const innerWidth = Math.max(10, opts.width - 2);
  const bodyHeight = Math.max(1, opts.height - 3);
  const maxOffset = Math.max(0, opts.logLines.length - bodyHeight);
  const offset = Math.max(0, Math.min(opts.offset, maxOffset));
  const body = opts.logLines.slice(offset, offset + bodyHeight);
  while (body.length < bodyHeight) body.push("");

  const hasOverflow = maxOffset > 0;
  const legend = hasOverflow
    ? "↑/↓ • g top • G bottom • d pgdn • u pgup • esc exit watcher"
    : "esc exit watcher";
  const top = `┌${"─".repeat(innerWidth)}┐`;
  const content = body.map(
    (line) => `│${clipAndPad(sanitizeWatchLine(line), innerWidth)}│`,
  );
  const legendLine = `│${clipAndPad(legend, innerWidth)}│`;
  const bottom = `└${"─".repeat(innerWidth)}┘`;
  return [top, ...content, legendLine, bottom];
}

export type WatcherNavAction =
  | "top"
  | "bottom"
  | "pageUp"
  | "pageDown"
  | "up"
  | "down"
  | null;

export function parseWatcherNavAction(data: string): WatcherNavAction {
  if (matchesKey(data, Key.up)) return "up";
  if (matchesKey(data, Key.down)) return "down";
  if (matchesKey(data, "g")) return "top";
  if (matchesKey(data, Key.shift("g"))) return "bottom";
  if (matchesKey(data, "d")) return "pageDown";
  if (matchesKey(data, "u")) return "pageUp";
  return null;
}

// ── Reviewer discovery ───────────────────────────────────────────────

interface Frontmatter {
  name?: string;
  description?: string;
  tools?: string;
  can_edit_code?: string;
  [key: string]: string | undefined;
}

function parseFrontmatter(content: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const fm: Frontmatter = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fm[key] = value;
  }
  return { frontmatter: fm, body: match[2] };
}

export function loadReviewers(dir: string): ReviewerConfig[] {
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir);

  const reviewers: ReviewerConfig[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dir, entry);
    const content = readFileSync(filePath, "utf-8");

    const { frontmatter, body } = parseFrontmatter(content);
    const errors: string[] = [];
    if (!frontmatter.name) errors.push("missing: name");
    if (!frontmatter.description) errors.push("missing: description");
    if (frontmatter.can_edit_code === undefined) {
      errors.push("missing: can_edit_code (must be true or false)");
    }
    if (errors.length > 0) {
      throw new Error(`Reviewer file ${entry}: ${errors.join("; ")}`);
    }

    const tools = frontmatter.tools
      ? frontmatter.tools
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

    reviewers.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools,
      systemPrompt: body.trim(),
      filePath,
      canEditCode: frontmatter.can_edit_code === "true",
    });
  }

  return reviewers;
}

/**
 * Overwrite a reviewer's prompt body on disk, keeping its frontmatter block
 * (between the leading `---` fences) untouched.
 */
export function writeReviewerPrompt(
  filePath: string,
  systemPrompt: string,
): void {
  const content = readFileSync(filePath, "utf-8");
  const match = content.match(/^(---\n[\s\S]*?\n---\n)[\s\S]*$/);
  const frontmatterBlock = match ? match[1] : "";
  writeFileSync(filePath, `${frontmatterBlock}\n${systemPrompt.trim()}\n`);
}

/** Render a complete reviewer markdown file (frontmatter + prompt body). */
export function serializeReviewer(reviewer: ReviewerConfig): string {
  return [
    "---",
    `name: ${reviewer.name}`,
    `description: ${reviewer.description}`,
    `tools: ${reviewer.tools.join(", ")}`,
    `can_edit_code: ${reviewer.canEditCode}`,
    "---",
    "",
    reviewer.systemPrompt.trim(),
    "",
  ].join("\n");
}

/**
 * Persist a reviewer to disk. Existing files keep their on-disk frontmatter
 * (only the prompt body is replaced); new files are written in full.
 */
export function saveReviewerToDisk(reviewer: ReviewerConfig): void {
  if (existsSync(reviewer.filePath)) {
    writeReviewerPrompt(reviewer.filePath, reviewer.systemPrompt);
  } else {
    mkdirSync(dirname(reviewer.filePath), { recursive: true });
    writeFileSync(reviewer.filePath, serializeReviewer(reviewer));
  }
}

/** Allowed characters for a reviewer name (used as the .md file stem). */
const REVIEWER_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

// ── Issue parsing ────────────────────────────────────────────────────

export interface IssueParseResult {
  issues: ReviewIssue[];
  errors: string[];
}

export function parseReviewerIssues(
  output: string,
  reviewerName: string,
): IssueParseResult {
  const issues: ReviewIssue[] = [];
  const errors: string[] = [];
  const issueRegex = /ISSUE:\n([\s\S]*?)END_ISSUE/g;
  let match;
  let blockIndex = 0;
  while ((match = issueRegex.exec(output)) !== null) {
    blockIndex++;
    const block = match[1];
    const file = extractField(block, "file");
    const lineStr = extractField(block, "line");
    const severity = extractField(block, "severity") as
      | "high"
      | "medium"
      | "low";
    const title = extractField(block, "title");
    const description = extractField(block, "description", true);

    if (!file || !title) {
      const missing: string[] = [];
      if (!file) missing.push("file");
      if (!title) missing.push("title");
      errors.push(
        `ISSUE block #${blockIndex}: missing required field(s): ${missing.join(", ")}`,
      );
      continue;
    }

    const warned: string[] = [];
    if (!lineStr) warned.push("line");
    if (!severity) warned.push("severity");
    if (!description) warned.push("description");
    if (warned.length > 0) {
      errors.push(
        `ISSUE block #${blockIndex}: missing field(s) defaulted: ${warned.join(", ")}`,
      );
    }

    issues.push({
      file,
      line: lineStr ? parseInt(lineStr, 10) : 1,
      severity: severity ?? "medium",
      title,
      description: description?.trim() ?? title,
      reviewer: reviewerName,
    });
  }
  return { issues, errors };
}

function extractField(
  block: string,
  field: string,
  multiline = false,
): string | undefined {
  if (multiline) {
    const regex = new RegExp(`^${field}:\\s*(.*)$`, "m");
    const match = regex.exec(block);
    if (!match) return undefined;
    const startIdx = block.indexOf(match[0]) + match[0].length;
    const remaining = block.slice(startIdx);
    const lines = [match[1]];
    for (const line of remaining.split("\n")) {
      if (/^\w+:/.test(line.trim())) break;
      lines.push(line);
    }
    return lines.join("\n").trim();
  }
  const regex = new RegExp(`^${field}:\\s*(.+)$`, "m");
  const match = regex.exec(block);
  return match ? match[1].trim() : undefined;
}

// ── Deduplication ────────────────────────────────────────────────────

function formatIssueList(issues: ReviewIssue[]): string {
  return issues
    .map(
      (issue, i) =>
        `Issue #${i + 1}: [${issue.file}:${issue.line}] (${issue.severity}) ${issue.title}\n  ${issue.description}`,
    )
    .join("\n\n");
}

export function parseKeepList(
  output: string,
  totalIssues: number,
): number[] | undefined {
  const match = /KEEP:\s*([\d,\s]+)/i.exec(output);
  if (!match) return undefined;
  const ids = match[1]
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n >= 1 && n <= totalIssues);
  return ids.length > 0 ? ids : undefined;
}

interface DeduplicateResult {
  issues: ReviewIssue[];
  usage: UsageStats;
}

async function deduplicateWithSubagent(
  log: OutputLog,
  issues: ReviewIssue[],
  cwd: string,
  dedupModel: { model: string; reasoning: string },
): Promise<DeduplicateResult> {
  if (issues.length <= 1) {
    return { issues, usage: emptyUsage() };
  }

  const reviewerNames = new Set(issues.map((i) => i.reviewer));
  if (reviewerNames.size <= 1) {
    log.appendImmediate(
      "[dedup] All issues from a single reviewer, skipping LLM dedup",
    );
    return { issues, usage: emptyUsage() };
  }

  const result = await runSubagent(log, {
    model: dedupModel.model,
    reasoning: dedupModel.reasoning,
    tools: [],
    cwd,
    task: `You are a code review deduplication agent. Multiple reviewers have found the following issues. Some may be duplicates describing the same underlying problem.

Remove duplicates by keeping only the best-described instance of each unique issue. Two issues are duplicates if they describe the same bug or concern in the same area of code, even if worded differently.

${formatIssueList(issues)}

Respond with ONLY a single line listing the issue numbers to KEEP (comma-separated):
KEEP: <numbers>

For example: KEEP: 1, 3, 5`,
  });

  if (result.code !== 0 || result.killed) {
    throw new Error(
      `Dedup agent failed (${result.killed ? "aborted" : `exit ${result.code}`}): ${errorDetail(result)}`,
    );
  }

  const keepIds = parseKeepList(result.text, issues.length);
  if (!keepIds) {
    throw new Error(
      `Dedup agent returned unparseable output (no KEEP list found)`,
    );
  }

  const kept = keepIds.map((id) => issues[id - 1]);
  log.appendImmediate(
    `[dedup] LLM kept ${kept.length} of ${issues.length} issues`,
  );
  return { issues: kept, usage: result.usage };
}

// ── Output log ───────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\].*?\x07|\x1b\\\\/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export class OutputLog {
  private buffer: string[] = [];
  private maxLines: number;
  private activeProcs = new Set<ReturnType<typeof spawn>>();
  private aborted = false;
  onChange: (() => void) | null = null;
  onImmediate: (() => void) | null = null;

  constructor(maxLines: number) {
    this.maxLines = maxLines;
  }

  append(text: string, label?: string): void {
    const incoming = text.replace(/\t/g, "  ").split("\n");
    const visible = incoming.filter((l) => stripAnsi(l).trim());
    const prefixed = label ? visible.map((l) => `[${label}] ${l}`) : visible;
    if (prefixed.length === 0) return;
    this.buffer.push(...prefixed);
    if (this.buffer.length > this.maxLines) {
      this.buffer = this.buffer.slice(-this.maxLines);
    }
    this.onChange?.();
  }

  appendImmediate(text: string, label?: string): void {
    this.append(text, label);
    this.onImmediate?.();
  }

  lines(): string[] {
    return [...this.buffer];
  }

  allLines(): string[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
  }

  abortAll(): void {
    this.aborted = true;
    for (const proc of this.activeProcs) {
      this.killProcessTree(proc, "SIGTERM");
      setTimeout(() => {
        if (this.activeProcs.has(proc)) this.killProcessTree(proc, "SIGKILL");
      }, 1500);
    }
  }

  resetAbort(): void {
    this.aborted = false;
  }

  isAborted(): boolean {
    return this.aborted;
  }

  private killProcessTree(
    proc: ReturnType<typeof spawn>,
    signal: NodeJS.Signals,
  ): void {
    if (!proc.pid) return;
    try {
      process.kill(-proc.pid, signal);
    } catch {
      // Process group kill failed (e.g. not a group leader); try direct kill
      try {
        proc.kill(signal);
      } catch {
        // ESRCH expected — process already exited
      }
    }
  }

  /** Spawn a process and stream output line-by-line to the log. */
  async streamingExec(
    cmd: string,
    args: string[],
    options?: { timeout?: number; cwd?: string },
  ): Promise<ExecResult> {
    if (this.aborted) {
      return { stdout: "", stderr: "aborted", code: 1, killed: true };
    }
    this.appendImmediate(`$ ${cmd} ${args.join(" ")}`, "exec");

    return new Promise((resolve) => {
      const proc = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: options?.cwd,
        detached: true,
      });
      this.activeProcs.add(proc);
      let stdout = "";
      let stderr = "";
      let killed = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      if (options?.timeout) {
        timer = setTimeout(() => {
          killed = true;
          this.killProcessTree(proc, "SIGTERM");
        }, options.timeout);
      }

      proc.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        this.append(text);
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        this.append(text);
      });

      proc.on("error", (err) => {
        if (timer) clearTimeout(timer);
        this.activeProcs.delete(proc);
        this.append(`✘ ${cmd} error: ${err.message}`);
        resolve({ stdout, stderr: err.message, code: 1, killed });
      });

      proc.on("close", (code) => {
        if (timer) clearTimeout(timer);
        this.activeProcs.delete(proc);
        resolve({
          stdout,
          stderr,
          code: code ?? 1,
          killed: killed || this.aborted,
        });
      });
    });
  }
}

// ── Pi invocation helper ─────────────────────────────────────────────

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  return { command: "pi", args };
}

function fetchKnownModels(): Set<string> {
  const invocation = getPiInvocation(["--list-models"]);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf-8",
    timeout: 10_000,
  });
  const output = result.stdout || result.stderr || "";
  if (result.status !== 0 || !output.trim()) {
    throw new Error(`Failed to fetch model list: exit code ${result.status}`);
  }
  return parsePiModelList(output);
}

// ── Review pipeline ──────────────────────────────────────────────────

interface PRContext {
  title: string;
  body: string;
  baseBranch: string;
  headBranch: string;
  diff: string;
  changedFiles: string[];
}

async function gatherPRContext(
  log: OutputLog,
  cwd: string,
): Promise<PRContext | null> {
  log.appendImmediate("[review] Fetching PR metadata...");
  const ghResult = await log.streamingExec(
    "gh",
    ["pr", "view", "--json", "title,body,baseRefName,headRefName"],
    { cwd },
  );
  if (ghResult.code !== 0) {
    log.appendImmediate(
      "[review] Failed to fetch PR metadata — is this a PR branch?",
    );
    return null;
  }

  let prData: {
    title: string;
    body: string;
    baseRefName: string;
    headRefName: string;
  };
  try {
    prData = JSON.parse(ghResult.stdout.trim());
  } catch (err) {
    log.appendImmediate(`[review] Failed to parse PR metadata JSON: ${err}`);
    return null;
  }

  log.appendImmediate("[review] Generating diff...");
  const diffResult = await log.streamingExec(
    "git",
    ["diff", `${prData.baseRefName}...${prData.headRefName}`],
    { cwd },
  );
  if (diffResult.code !== 0) {
    log.appendImmediate("[review] Failed to generate diff");
    return null;
  }

  log.appendImmediate("[review] Sanitizing diff...");
  const sanitizedDiff = sanitizeDiff(diffResult.stdout);
  const changedFiles = extractChangedFiles(sanitizedDiff);
  log.appendImmediate(
    `[review] Found ${changedFiles.length} changed files (after sanitization)`,
  );

  return {
    title: prData.title,
    body: prData.body || "",
    baseBranch: prData.baseRefName,
    headBranch: prData.headRefName,
    diff: sanitizedDiff,
    changedFiles,
  };
}

function extractChangedFiles(diff: string): string[] {
  const files: string[] = [];
  const regex = /^diff --git a\/(.*?) b\//gm;
  let match;
  while ((match = regex.exec(diff)) !== null) {
    files.push(match[1]);
  }
  return [...new Set(files)];
}

// ── Diff sanitization ────────────────────────────────────────────────

/** Patterns for generated/binary files to filter from diffs. */
const GENERATED_FILE_PATTERNS = [
  /\.lock$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.min\.js$/,
  /\.min\.css$/,
  /\.map$/,
  /\.snap$/,
  /\.svg$/,
  /\.ico$/,
  /\.png$/,
  /\.jpg$/,
  /\.jpeg$/,
  /\.gif$/,
  /\.webp$/,
  /\.woff2?$/,
  /\.ttf$/,
  /\.eot$/,
];

/**
 * Remove binary files and generated code (lock files, minified assets, etc.)
 * from a unified diff.
 */
export function sanitizeDiff(diff: string): string {
  const sections = diff.split(/(?=^diff --git )/m);
  const kept: string[] = [];

  for (const section of sections) {
    if (!section.trim()) continue;

    if (/Binary files .* differ/i.test(section)) continue;
    if (/GIT binary patch/i.test(section)) continue;
    const fileMatch = section.match(/^diff --git a\/(.*?) b\//m);
    if (fileMatch) {
      const filePath = fileMatch[1];
      if (GENERATED_FILE_PATTERNS.some((p) => p.test(filePath))) continue;
    }

    kept.push(section);
  }

  return kept.join("");
}

// ── Usage extraction ─────────────────────────────────────────────────

/**
 * Parse pi JSON mode output (NDJSON) in a single pass, extracting both
 * the final assistant message text and cumulative token usage.
 */
export interface JsonModeOutput {
  text: string;
  usage: UsageStats;
  stopReason?: string;
  errorMessage?: string;
}

interface PiJsonUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

interface PiJsonMessage {
  role?: string;
  usage?: PiJsonUsage;
  stopReason?: string;
  errorMessage?: string;
  content?: string | Array<{ type?: string; text?: string }>;
}

interface PiJsonEvent {
  type?: string;
  message?: PiJsonMessage;
}

export function parseJsonModeOutput(jsonOutput: string): JsonModeOutput {
  const stats = emptyUsage();
  let lastMessage = "";
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  for (const line of jsonOutput.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as PiJsonEvent;
      const msg = event.message;
      if (event.type === "message_end" && msg?.role === "assistant") {
        stats.turns++;
        const u = msg.usage;
        if (u) {
          stats.inputTokens += u.input || 0;
          stats.outputTokens += u.output || 0;
          stats.cacheReadTokens += u.cacheRead || 0;
          stats.cacheWriteTokens += u.cacheWrite || 0;
          stats.cost += u.cost?.total || 0;
        }
        if (msg.stopReason) stopReason = msg.stopReason;
        if (msg.errorMessage) errorMessage = msg.errorMessage;
        const content = msg.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === "text" && typeof part.text === "string") {
              lastMessage = part.text;
            }
          }
        } else if (typeof content === "string") {
          lastMessage = content;
        }
      }
    } catch {
      // Skip non-JSON lines
    }
  }
  return { text: lastMessage, usage: stats, stopReason, errorMessage };
}

// ── Subagent runner ──────────────────────────────────────────────────

function errorDetail(result: {
  errorMessage?: string;
  stderr: string;
}): string {
  return result.errorMessage || result.stderr.trim() || "(no details)";
}

interface SubagentResult {
  text: string;
  usage: UsageStats;
  code: number;
  killed: boolean;
  stderr: string;
  stopReason?: string;
  errorMessage?: string;
}

async function runSubagent(
  log: OutputLog,
  opts: {
    model: string;
    reasoning?: string;
    tools: string[];
    task: string;
    cwd: string;
  },
): Promise<SubagentResult> {
  const piArgs: string[] = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--model",
    opts.model,
    ...(opts.reasoning ? ["--thinking", opts.reasoning] : []),
  ];
  if (opts.tools.length > 0) {
    piArgs.push("--tools", opts.tools.join(","));
  }
  piArgs.push(`Task: ${opts.task}`);

  const invocation = getPiInvocation(piArgs);
  const result = await log.streamingExec(invocation.command, invocation.args, {
    cwd: opts.cwd,
  });

  const parsed = parseJsonModeOutput(result.stdout);
  return {
    text: parsed.text,
    usage: parsed.usage,
    code: result.code,
    killed: result.killed,
    stderr: result.stderr,
    stopReason: parsed.stopReason,
    errorMessage: parsed.errorMessage,
  };
}

const REVIEWER_OUTPUT_FORMAT = `For each issue found, report it in this exact format:

ISSUE:
file: <path>
line: <line number>
severity: <high|medium|low>
title: <short title>
description: <detailed explanation>
END_ISSUE

IMPORTANT: Before reporting any issue, READ the actual file and verify the exact line number. Do NOT guess line numbers from diff headers.`;

// ── Reviewer agent ───────────────────────────────────────────────────

interface ReviewerResult {
  issues: ReviewIssue[];
  usage: UsageStats;
}

async function runReviewer(
  log: OutputLog,
  reviewer: ReviewerConfig,
  modelEntry: ReviewerModelEntry,
  context: PRContext,
  cwd: string,
): Promise<ReviewerResult> {
  log.appendImmediate(`[${reviewer.name}] Starting reviewer...`);

  const originalTask = `Review the following PR:

Title: ${context.title}
Description: ${context.body}

Changed files: ${context.changedFiles.join(", ")}

Diff:
\`\`\`
${context.diff}
\`\`\`

${reviewer.systemPrompt}

${REVIEWER_OUTPUT_FORMAT}`;

  const tools = reviewer.canEditCode
    ? [...new Set([...reviewer.tools, "edit", "write"])]
    : reviewer.tools;

  const result = await runSubagent(log, {
    model: modelEntry.model,
    reasoning: modelEntry.reasoning,
    tools,
    cwd,
    task: originalTask,
  });

  if (result.code !== 0 && !result.killed) {
    log.appendImmediate(
      `[${reviewer.name}] Reviewer failed (exit ${result.code}): ${errorDetail(result)}`,
    );
    if (result.stopReason) {
      log.appendImmediate(
        `[${reviewer.name}] Stop reason: ${result.stopReason}`,
      );
    }
    return { issues: [], usage: result.usage };
  }

  if (result.killed) {
    log.appendImmediate(`[${reviewer.name}] Reviewer was aborted`);
    return { issues: [], usage: result.usage };
  }

  log.appendImmediate(`[${reviewer.name}] Parsing issues from output...`);
  const parsed = parseReviewerIssues(result.text, reviewer.name);

  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) {
      log.appendImmediate(`[${reviewer.name}]   ${e}`);
    }
  }

  log.appendImmediate(
    `[${reviewer.name}] Found ${parsed.issues.length} issues`,
  );
  return { issues: parsed.issues, usage: result.usage };
}

// ── Critic agent ─────────────────────────────────────────────────────

export interface CriticConfig {
  model: string;
  reasoning?: string;
}

export const DEFAULT_CRITICS: CriticConfig[] = [
  { model: "claude-sonnet-4-6", reasoning: "high" },
  { model: "gpt-5.4" },
  { model: "gemini-3.1-pro-preview" },
];

interface JudgeResult {
  approved: boolean;
  usage: UsageStats;
}

const CRITIC_TASK_TEMPLATE = (issue: ReviewIssue, diff: string) =>
  `You are a skeptical code review critic. Your job is to determine if the following review comment is a REAL, ACTIONABLE issue that was INTRODUCED BY THIS PR.

The review comment:
- File: ${issue.file}
- Line: ${issue.line}
- Title: ${issue.title}
- Description: ${issue.description}
- Found by: ${issue.reviewer}

The PR diff:
\`\`\`
${diff}
\`\`\`

READ the actual file at ${issue.file} and verify:
1. Does the issue actually exist at or near line ${issue.line}?
2. Was it introduced by this PR (in the diff)?
3. Is it a REAL bug causing incorrect behavior, an actual security vulnerability, or code contradicting its own documentation?

Filter OUT:
- Nitpicks, style, formatting, imports
- Test coverage suggestions (unless test is actually wrong)
- "Best practices" without real impact
- Performance suggestions without measured impact
- Maintainability/future concerns
- Non-functional typos in comments/docs
- Theoretical concerns without concrete impact

Respond with either:
VERDICT: APPROVE
Reason: <why this is a real issue>

Or:
VERDICT: REJECT
Reason: <why this should be filtered out>`;

async function runSingleCritic(
  log: OutputLog,
  critic: CriticConfig,
  criticIndex: number,
  issue: ReviewIssue,
  context: PRContext,
  cwd: string,
): Promise<JudgeResult> {
  const label = `critic-${criticIndex}:${critic.model}`;

  const result = await runSubagent(log, {
    model: critic.model,
    reasoning: critic.reasoning,
    tools: ["read", "grep", "find", "ls", "bash"],
    cwd,
    task: CRITIC_TASK_TEMPLATE(issue, context.diff),
  });

  if (result.code !== 0 || result.killed) {
    log.appendImmediate(
      `[${label}] Failed to evaluate issue (${result.killed ? "aborted" : `exit ${result.code}`}): ${errorDetail(result)}`,
    );
    log.appendImmediate(`[${label}] Voting to keep issue due to error`);
    return { approved: true, usage: result.usage };
  }

  const approved = /VERDICT:\s*APPROVE/i.test(result.text);
  log.appendImmediate(
    `[${label}] ${approved ? "APPROVED" : "REJECTED"}: ${issue.title}`,
  );
  return { approved, usage: result.usage };
}

/**
 * Judge an issue using multiple critics with majority voting.
 * - 1 critic: 1 vote needed to keep
 * - 2+ critics: at least 2 must agree to keep
 */
async function judgeIssue(
  log: OutputLog,
  issue: ReviewIssue,
  context: PRContext,
  cwd: string,
  critics: CriticConfig[],
): Promise<JudgeResult> {
  log.appendImmediate(
    `[critic] Evaluating (${critics.length} critic(s)): ${issue.title} (${issue.file}:${issue.line})`,
  );

  const totalUsage = emptyUsage();

  const criticPromises = critics.map((critic, i) =>
    runSingleCritic(log, critic, i + 1, issue, context, cwd),
  );
  const results = await Promise.all(criticPromises);

  let approveCount = 0;
  for (const r of results) {
    addUsage(totalUsage, r.usage);
    if (r.approved) approveCount++;
  }

  const threshold = critics.length === 1 ? 1 : 2;
  const approved = approveCount >= threshold;

  log.appendImmediate(
    `[critic] ${approved ? "APPROVED" : "REJECTED"} (${approveCount}/${critics.length} votes): ${issue.title}`,
  );
  return { approved, usage: totalUsage };
}

// ── Cost logging ────────────────────────────────────────────────────

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

function logCostSummary(log: OutputLog, usage: UsageStats): void {
  log.appendImmediate(
    `[cost] Tokens: ↑${formatTokens(usage.inputTokens)} ↓${formatTokens(usage.outputTokens)} ` +
      `cache-R:${formatTokens(usage.cacheReadTokens)} cache-W:${formatTokens(usage.cacheWriteTokens)} ` +
      `turns:${usage.turns}` +
      (usage.cost > 0 ? ` cost:$${usage.cost.toFixed(4)}` : ""),
  );
}

function formatCostSummary(usage: UsageStats, elapsedMs: number): string {
  const lines = [
    "",
    "",
    "---",
    `Review completed in ${formatElapsed(elapsedMs)}`,
    `Tokens: ↑${formatTokens(usage.inputTokens)} input, ↓${formatTokens(usage.outputTokens)} output`,
  ];
  if (usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0) {
    lines.push(
      `Cache: ${formatTokens(usage.cacheReadTokens)} read, ${formatTokens(usage.cacheWriteTokens)} write`,
    );
  }
  lines.push(`Turns: ${usage.turns}`);
  if (usage.cost > 0) {
    lines.push(`Estimated cost: $${usage.cost.toFixed(4)}`);
  }
  return lines.join("\n");
}

// ── Report formatting ────────────────────────────────────────────────

function formatReviewReport(issues: ReviewIssue[]): string {
  if (issues.length === 0) {
    return "No actionable issues found.";
  }

  const lines: string[] = [];
  for (const issue of issues) {
    lines.push(`## ${issue.title}`);
    lines.push(`**File:** ${issue.file}:${issue.line}`);
    lines.push(`**Severity:** ${issue.severity}`);
    lines.push(`**Found by:** ${issue.reviewer}`);
    lines.push("");
    lines.push(issue.description);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Extension ────────────────────────────────────────────────────────

function getDefaultReviewersDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "reviewers");
}

export function createExtension(
  pi: CriticalReviewPi,
  options?: ExtensionOptions,
): void {
  const reviewersDir = options?.reviewersDir ?? getDefaultReviewersDir();
  const userReviewersDir = options?.userReviewersDir ?? USER_REVIEWERS_DIR;
  const configPath = options?.configPath ?? DEFAULT_CONFIG_PATH;
  if (!existsSync(userReviewersDir)) {
    mkdirSync(userReviewersDir, { recursive: true });
  }
  let modelConfig = loadModelConfig(configPath);
  const LOG_MAX_LINES = 10_000;
  const log = new OutputLog(LOG_MAX_LINES);
  const usage = buildUsageLines();

  let running = false;
  let startedAt = 0;
  let currentStep = "";
  let ctxRef: ExtensionContext | null = null;
  let statusTicker: ReturnType<typeof setInterval> | null = null;

  // ── Status bar ─────────────────────────────────────────────────

  const renderStatusBar = () => {
    if (!ctxRef?.hasUI) return;
    if (!running) {
      ctxRef.ui.setWidget("critical-review", undefined);
      return;
    }
    const elapsed = startedAt ? Date.now() - startedAt : 0;
    const lines = buildStatusBarLines({
      state: "running",
      step: currentStep,
      elapsedMs: elapsed,
    });
    ctxRef.ui.setWidget("critical-review", lines);
  };

  const clearStatusBar = () => {
    if (!ctxRef?.hasUI) return;
    ctxRef.ui.setWidget("critical-review", undefined);
  };

  const startTicker = () => {
    if (statusTicker) clearInterval(statusTicker);
    statusTicker = setInterval(renderStatusBar, 60_000);
  };

  const stopTicker = () => {
    if (!statusTicker) return;
    clearInterval(statusTicker);
    statusTicker = null;
  };

  const resetRunState = () => {
    running = false;
    stopTicker();
    clearStatusBar();
  };

  // ── Watcher ────────────────────────────────────────────────────

  const showWatcher = async (ctx: ExtensionCommandContext) => {
    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      let offset = 0;
      let lastWidth = 80;
      let autoTail = true;
      const height = 18;
      const text = new Text("", 0, 0);

      const renderBody = () => {
        const all = log.allLines();
        const bodyHeight = Math.max(1, height - 3);
        const maxOffset = Math.max(0, all.length - bodyHeight);
        if (autoTail) offset = maxOffset;
        const lines = buildWatchPanelFrame({
          logLines: all,
          offset,
          height,
          width: lastWidth,
        });
        text.setText(
          lines
            .map((line, i) =>
              i === lines.length - 2 ? theme.fg("dim", line) : line,
            )
            .join("\n"),
        );
      };

      const invalidate = () => {
        renderBody();
        text.invalidate();
        tui.requestRender();
      };

      log.onChange = invalidate;
      log.onImmediate = invalidate;
      invalidate();

      return {
        render: (w: number) => {
          lastWidth = w;
          renderBody();
          return text.render(w);
        },
        invalidate: () => text.invalidate(),
        handleInput: (data: string) => {
          const allCount = log.allLines().length;
          const bodyHeight = Math.max(1, height - 3);
          const maxOffset = Math.max(0, allCount - bodyHeight);

          if (matchesKey(data, Key.escape)) {
            log.onChange = null;
            log.onImmediate = null;
            done(undefined);
            return;
          }

          const action = parseWatcherNavAction(data);
          switch (action) {
            case "top":
              autoTail = false;
              offset = 0;
              break;
            case "bottom":
              autoTail = true;
              offset = maxOffset;
              break;
            case "pageUp":
              autoTail = false;
              offset = Math.max(0, offset - bodyHeight);
              break;
            case "pageDown":
              autoTail = false;
              offset = Math.min(maxOffset, offset + bodyHeight);
              break;
            case "up":
              autoTail = false;
              offset = Math.max(0, offset - 1);
              break;
            case "down":
              autoTail = false;
              offset = Math.min(maxOffset, offset + 1);
              break;
            default:
              return;
          }
          invalidate();
        },
      };
    });
  };

  // ── Review execution ───────────────────────────────────────────

  async function executeReview(
    selectedReviewers: ReviewerConfig[],
    ctx: ExtensionCommandContext,
    fixMode: boolean,
    cumulativeUsage?: UsageStats,
    critics: CriticConfig[] = DEFAULT_CRITICS,
  ): Promise<UsageStats> {
    running = true;
    startedAt = Date.now();
    log.resetAbort();
    log.clear();
    log.appendImmediate(
      `[review] Starting review (${fixMode ? "fix" : "report"} mode) with ${selectedReviewers.length} reviewer(s): ${selectedReviewers.map((r) => r.name).join(", ")}`,
    );
    startTicker();

    try {
      currentStep = "Fetching PR context";
      renderStatusBar();
      const totalUsage = cumulativeUsage ?? emptyUsage();

      const prContext = await gatherPRContext(log, ctx.cwd);
      if (!prContext) {
        log.appendImmediate("[review] Aborting — could not gather PR context");
        return totalUsage;
      }

      if (log.isAborted()) return totalUsage;
      currentStep = `Running ${selectedReviewers.length} reviewer(s)`;
      renderStatusBar();
      const parallelReviewers = selectedReviewers.filter((r) => !r.canEditCode);
      const sequentialReviewers = selectedReviewers.filter(
        (r) => r.canEditCode,
      );
      const reviewerResults = await Promise.all(
        parallelReviewers.map((r) =>
          runReviewer(log, r, modelConfig[r.name], prContext, ctx.cwd),
        ),
      );
      for (const r of sequentialReviewers) {
        if (log.isAborted()) break;
        reviewerResults.push(
          await runReviewer(log, r, modelConfig[r.name], prContext, ctx.cwd),
        );
      }
      const allIssues: ReviewIssue[] = [];
      for (const r of reviewerResults) {
        allIssues.push(...r.issues);
        addUsage(totalUsage, r.usage);
      }
      log.appendImmediate(`[review] Total raw issues: ${allIssues.length}`);

      if (log.isAborted()) return totalUsage;

      if (allIssues.length === 0) {
        currentStep = "No issues found";
        renderStatusBar();
        const report = formatReviewReport([]);
        logCostSummary(log, totalUsage);
        sendReport(report);
        return totalUsage;
      }

      log.appendImmediate(
        `[review] Deduplicating ${allIssues.length} issues...`,
      );
      currentStep = "Deduplicating issues";
      renderStatusBar();
      const dedupModelEntry = modelConfig[selectedReviewers[0].name];
      const dedupResult = await deduplicateWithSubagent(
        log,
        allIssues,
        ctx.cwd,
        dedupModelEntry,
      );
      const deduped = dedupResult.issues;
      addUsage(totalUsage, dedupResult.usage);
      log.appendImmediate(
        `[review] After deduplication: ${deduped.length} issues`,
      );

      if (log.isAborted()) return totalUsage;

      log.appendImmediate(`[review] Judging ${deduped.length} issue(s)...`);
      currentStep = `Judging ${deduped.length} issue(s) with ${critics.length} critic(s)`;
      renderStatusBar();
      const approved: ReviewIssue[] = [];
      const judgePromises = deduped.map(async (issue) => {
        if (log.isAborted()) return null;
        const judgeResult = await judgeIssue(
          log,
          issue,
          prContext,
          ctx.cwd,
          critics,
        );
        addUsage(totalUsage, judgeResult.usage);
        return judgeResult.approved ? issue : null;
      });
      const judgeResults = await Promise.all(judgePromises);
      for (const issue of judgeResults) {
        if (issue) approved.push(issue);
      }
      log.appendImmediate(
        `[review] After critic review: ${approved.length} issues approved`,
      );

      currentStep = "Reporting results";
      renderStatusBar();
      logCostSummary(log, totalUsage);
      const report = formatReviewReport(approved);
      const elapsed = startedAt ? Date.now() - startedAt : 0;
      const costSummary = formatCostSummary(totalUsage, elapsed);
      const fullReport = report + costSummary;

      const tmpFile = join(tmpdir(), `critical-review-${Date.now()}.md`);
      try {
        writeFileSync(tmpFile, fullReport);
        log.appendImmediate(`[review] Results written to ${tmpFile}`);
      } catch (err) {
        log.appendImmediate(`[review] Failed to write results file: ${err}`);
      }

      let clipboardNote = "";
      try {
        await copyToClipboard(fullReport);
        clipboardNote = "\n\n_Report copied to clipboard._";
      } catch (err) {
        log.appendImmediate(`[review] Failed to copy to clipboard: ${err}`);
      }

      const agentInstruction = fixMode
        ? "Fix the following issues with TDD:\n\n"
        : "Here are the review results. Do NOT fix these issues — present them to the user as-is:\n\n";
      sendReport(agentInstruction + fullReport + clipboardNote);
      log.appendImmediate("[review] Review complete");
      return totalUsage;
    } catch (err) {
      log.appendImmediate(`[review] Error: ${err}`);
      currentStep = "Failed";
      renderStatusBar();
      return cumulativeUsage ?? emptyUsage();
    } finally {
      resetRunState();
    }
  }

  // ── Fix loop ───────────────────────────────────────────────────

  async function executeFixLoop(
    selectedReviewers: ReviewerConfig[],
    ctx: ExtensionCommandContext,
    critics: CriticConfig[] = DEFAULT_CRITICS,
  ): Promise<void> {
    const MAX_ITERATIONS = 10;
    const loopStartedAt = Date.now();
    let cumulativeUsage = emptyUsage();
    try {
      for (let i = 1; i <= MAX_ITERATIONS; i++) {
        log.appendImmediate(`[fix-loop] Iteration ${i} of ${MAX_ITERATIONS}`);
        cumulativeUsage = await executeReview(
          selectedReviewers,
          ctx,
          true,
          cumulativeUsage,
          critics,
        );

        if (log.isAborted()) {
          log.appendImmediate("[fix-loop] Aborted");
          break;
        }

        if (lastReport?.includes("No actionable issues found")) {
          log.appendImmediate("[fix-loop] No more issues — done!");
          break;
        }

        log.appendImmediate("[fix-loop] Waiting for agent to finish fixing...");
        await ctx.waitForIdle();

        if (log.isAborted()) break;
      }

      const elapsed = Date.now() - loopStartedAt;
      logCostSummary(log, cumulativeUsage);
      const costSummary = formatCostSummary(cumulativeUsage, elapsed);
      sendReport(
        (lastReport ?? "") + "\n\n## Fix-loop cumulative cost" + costSummary,
      );
    } catch (err) {
      log.appendImmediate(`[fix-loop] Error: ${err}`);
      ctx.ui.notify(`Fix-loop failed: ${err}`, "error");
    } finally {
      resetRunState();
    }
  }

  let lastReport: string | undefined;

  function sendReport(content: string): void {
    lastReport = content;
    pi.sendUserMessage(content, { deliverAs: "followUp" });
  }

  // ── Command ────────────────────────────────────────────────────

  const completionItems = COMMAND_DEFS.map((d) => ({
    value: d.flag,
    label: d.flag,
    description: d.description,
  }));

  pi.registerCommand("critical-review", {
    description: "Perform a critical code review with AI specialist agents",
    getArgumentCompletions: (prefix: string) => {
      const filtered = completionItems.filter((a) =>
        a.value.startsWith(prefix),
      );
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);

      if (parsed.kind === "help") {
        ctx.ui.notify(usage.join("\n"), "info");
        return;
      }

      if (parsed.kind === "invalid") {
        log.appendImmediate(`[critical-review] ${parsed.reason}`);
        ctx.ui.notify(parsed.reason, "error");
        return;
      }

      if (parsed.kind === "abort") {
        if (running) {
          log.appendImmediate("[review] Aborting — user requested abort");
          log.abortAll();
          resetRunState();
          ctx.ui.notify("Review aborted", "info");
        } else {
          ctx.ui.notify("No review is currently running", "info");
        }
        return;
      }

      if (parsed.kind === "watch") {
        await showWatcher(ctx);
        return;
      }

      if (running) {
        log.appendImmediate("[review] Ignored: review already running");
        ctx.ui.notify(
          "A review is already running. Use -abort to stop it.",
          "warning",
        );
        return;
      }

      ctxRef = ctx;

      const bundledReviewers = loadReviewers(reviewersDir);
      const userReviewers = loadReviewers(userReviewersDir);
      const allReviewers = [...bundledReviewers, ...userReviewers];
      if (allReviewers.length === 0) {
        ctx.ui.notify(
          `No reviewers found. Add .md files to ${userReviewersDir}`,
          "error",
        );
        return;
      }

      const knownModels = fetchKnownModels();

      let configChanged = false;
      for (const r of allReviewers) {
        if (!modelConfig[r.name]) {
          modelConfig[r.name] = defaultModelEntry(knownModels);
          configChanged = true;
        }
      }
      if (configChanged) {
        saveModelConfig(configPath, modelConfig);
      }

      const validationErrors = validateModelConfig(modelConfig, knownModels);
      if (validationErrors.length > 0) {
        ctx.ui.notify(
          `Reviewer config errors:\n${validationErrors.join("\n")}`,
          "error",
        );
        return;
      }

      let selected: ReviewerConfig[];
      let activeCritics: CriticConfig[];
      if (ctx.hasUI) {
        const picked = await showReviewerSelection(
          ctx,
          allReviewers,
          modelConfig,
          knownModels,
          userReviewersDir,
          (updatedConfig) => {
            modelConfig = updatedConfig;
            saveModelConfig(configPath, modelConfig);
          },
        );
        if (!picked || picked.reviewers.length === 0) {
          return; // User cancelled
        }
        selected = picked.reviewers;
        activeCritics = picked.critics;
      } else {
        selected = allReviewers;
        activeCritics = DEFAULT_CRITICS.map((c) => ({ ...c }));
      }

      const fixMode = parsed.kind === "fix" || parsed.kind === "fix-loop";

      if (ctx.hasUI) {
        if (parsed.kind === "fix-loop") {
          void executeFixLoop(selected, ctx, activeCritics);
        } else {
          void executeReview(selected, ctx, fixMode, undefined, activeCritics);
        }
      } else {
        if (parsed.kind === "fix-loop") {
          await executeFixLoop(selected, ctx, activeCritics);
        } else {
          await executeReview(selected, ctx, fixMode, undefined, activeCritics);
        }
      }
    },
  });

  pi.on("session_shutdown", async () => {
    stopTicker();
    log.abortAll();
    ctxRef = null;
  });
}

// ── Reviewer selection UI ────────────────────────────────────────────

interface ReviewerSelection {
  reviewer: ReviewerConfig;
  selected: boolean;
}

interface SelectionResult {
  reviewers: ReviewerConfig[];
  critics: CriticConfig[];
}

async function showReviewerSelection(
  ctx: ExtensionCommandContext,
  reviewers: ReviewerConfig[],
  config: ModelConfig,
  knownModels: Set<string>,
  userReviewersDir: string,
  onConfigChange: (config: ModelConfig) => void,
): Promise<SelectionResult | null> {
  const selections: ReviewerSelection[] = reviewers.map((r) => ({
    reviewer: r,
    selected: true,
  }));
  const critics: CriticConfig[] = DEFAULT_CRITICS.map((c, i) => {
    const saved = config[`critic:${i}`];
    return saved
      ? { model: saved.model, reasoning: saved.reasoning }
      : { ...c };
  });
  let cursor = 0;
  const totalItems = () => selections.length + critics.length;
  const isCriticRow = () => cursor >= selections.length;
  const criticIndex = () => cursor - selections.length;

  let editingField: "model" | "reasoning" | null = null;
  const modelList = [...knownModels].sort();
  const reasoningList = [...VALID_REASONING_LEVELS];

  return ctx.ui.custom<SelectionResult | null>((tui, theme, _kb, done) => {
    const text = new Text("", 0, 0);
    const editorTheme: EditorTheme = {
      borderColor: (s: string) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (s: string) => theme.fg("accent", s),
        selectedText: (s: string) => theme.fg("accent", s),
        description: (s: string) => theme.fg("dim", s),
        scrollInfo: (s: string) => theme.fg("dim", s),
        noMatch: (s: string) => theme.fg("dim", s),
      },
    };
    let editor: Editor | null = null;
    let suggestionIndex = 0;
    let promptEditor: Editor | null = null;

    const startPromptEdit = () => {
      const reviewer = selections[cursor].reviewer;
      promptEditor = new Editor(tui, editorTheme, { paddingX: 0 });
      promptEditor.disableSubmit = true;
      promptEditor.focused = true;
      promptEditor.setText(reviewer.systemPrompt);
    };

    let nameEditor: Editor | null = null;
    let nameError = "";

    const startNewReviewer = () => {
      nameError = "";
      nameEditor = new Editor(tui, editorTheme, { paddingX: 0 });
      nameEditor.disableSubmit = true;
      nameEditor.focused = true;
    };

    const confirmNewReviewer = () => {
      if (!nameEditor) return;
      const name = nameEditor.getText().trim();
      if (!REVIEWER_NAME_PATTERN.test(name)) {
        nameError = "Use only letters, numbers, - and _";
        return;
      }
      const filePath = join(userReviewersDir, `${name}.md`);
      const exists =
        existsSync(filePath) ||
        selections.some((s) => s.reviewer.name === name);
      if (exists) {
        nameError = `A reviewer named "${name}" already exists`;
        return;
      }
      const reviewer: ReviewerConfig = {
        name,
        description: "Custom reviewer",
        tools: ["read", "grep", "find", "ls", "bash"],
        systemPrompt: "",
        filePath,
        canEditCode: false,
      };
      selections.push({ reviewer, selected: true });
      cursor = selections.length - 1;
      if (!config[name]) {
        config[name] = defaultModelEntry(knownModels);
      }
      nameEditor = null;
      startPromptEdit();
    };

    const visibleSuggestions = (): string[] => {
      if (!editor || !editingField) return [];
      const list = editingField === "model" ? modelList : reasoningList;
      const max = editingField === "model" ? 5 : 6;
      return fuzzyFilter(list, editor.getText(), (x) => x).slice(0, max);
    };

    const startEditing = (field: "model" | "reasoning") => {
      editingField = field;
      suggestionIndex = 0;
      let value: string;
      if (isCriticRow()) {
        const c = critics[criticIndex()];
        value = field === "model" ? c.model : (c.reasoning ?? "off");
      } else {
        const entry = config[selections[cursor].reviewer.name];
        value = field === "model" ? entry.model : entry.reasoning;
      }
      editor = new Editor(tui, editorTheme, { paddingX: 0 });
      editor.disableSubmit = true;
      editor.focused = true;
      editor.setText(value);
    };

    const stopEditing = () => {
      editingField = null;
      editor = null;
      suggestionIndex = 0;
    };

    const buildListContent = (): string => {
      const lines: string[] = [
        theme.bold(theme.fg("accent", " Select reviewers:")),
        "",
      ];

      for (let i = 0; i < selections.length; i++) {
        const sel = selections[i];
        const entry = config[sel.reviewer.name];
        const checkbox = sel.selected ? "[✓]" : "[ ]";
        const pointer = i === cursor ? "→ " : "  ";
        const name = theme.bold(sel.reviewer.name);
        const desc = theme.fg("dim", ` — ${sel.reviewer.description}`);
        lines.push(`${pointer}${checkbox} ${name}${desc}`);
        lines.push(
          theme.fg(
            "dim",
            `      model: ${entry.model}  reasoning: ${entry.reasoning}`,
          ),
        );
      }

      lines.push("");
      lines.push(theme.fg("dim", "  Critics (majority vote):"));
      for (let i = 0; i < critics.length; i++) {
        const ci = selections.length + i;
        const pointer = ci === cursor ? "→ " : "  ";
        const label = theme.bold(`critic ${i + 1}`);
        lines.push(`${pointer}${label}`);
        lines.push(
          theme.fg(
            "dim",
            `      model: ${critics[i].model}  reasoning: ${critics[i].reasoning ?? "off"}`,
          ),
        );
      }

      if (!editingField) {
        lines.push("");
        const legend = isCriticRow()
          ? "  m: model • r: reasoning • enter: start review • esc: cancel"
          : "  space: toggle • m: model • r: reasoning • e: edit prompt • n: new • enter: start review • esc: cancel";
        lines.push(theme.fg("dim", legend));
        const home = homedir();
        const displayDir = userReviewersDir.startsWith(home)
          ? `~${userReviewersDir.slice(home.length)}`
          : userReviewersDir;
        lines.push("");
        lines.push(
          theme.fg("dim", `  Note: reviewers are saved to: ${displayDir}`),
        );
      }

      return lines.join("\n");
    };

    return {
      render: (w: number) => {
        if (nameEditor) {
          const lines: string[] = [
            theme.bold(theme.fg("accent", " New reviewer name (a-zA-Z0-9-_):")),
            "",
          ];
          for (const line of nameEditor.render(w)) {
            lines.push(line);
          }
          if (nameError) {
            lines.push(truncateToWidth(theme.fg("error", `  ${nameError}`), w));
          }
          lines.push("");
          lines.push(theme.fg("dim", "  enter: confirm • esc: cancel"));
          return lines;
        }

        if (promptEditor) {
          const lines: string[] = [
            theme.bold(
              theme.fg("accent", " Editing reviewer prompt (full text):"),
            ),
            "",
          ];
          for (let i = 0; i < selections.length; i++) {
            const sel = selections[i];
            const checkbox = sel.selected ? "[✓]" : "[ ]";
            if (i === cursor) {
              lines.push(
                theme.fg("accent", `→ ${checkbox} ${sel.reviewer.name}`),
              );
              for (const line of promptEditor.render(w)) {
                lines.push(line);
              }
            } else {
              lines.push(
                truncateToWidth(
                  theme.fg(
                    "dim",
                    `  ${checkbox} ${sel.reviewer.name} — ${sel.reviewer.description}`,
                  ),
                  w,
                ),
              );
            }
          }
          lines.push("");
          lines.push(
            theme.fg(
              "dim",
              "  ^S: save to disk  •  esc: return (saved in memory)  •  shift+enter: new line",
            ),
          );
          return lines;
        }

        text.setText(buildListContent());
        const lines = text.render(w);
        if (editingField && editor) {
          const itemName = isCriticRow()
            ? `critic ${criticIndex() + 1}`
            : selections[cursor].reviewer.name;
          const label = editingField === "model" ? "Model" : "Reasoning";
          lines.push("");
          lines.push(theme.fg("accent", `  ${label} for ${itemName}:`));
          for (const line of editor.render(w)) {
            lines.push(line);
          }
          const visible = visibleSuggestions();
          const selected = Math.min(
            suggestionIndex,
            Math.max(0, visible.length - 1),
          );
          for (let i = 0; i < visible.length; i++) {
            const isSelected = i === selected;
            const row = `${isSelected ? "→ " : "  "}${visible[i]}`;
            lines.push(
              truncateToWidth(
                isSelected
                  ? theme.fg("accent", `  ${row}`)
                  : theme.fg("dim", `  ${row}`),
                w,
              ),
            );
          }
          lines.push(
            theme.fg(
              "dim",
              "  ↑/↓: select • tab: accept • enter: confirm • esc: cancel",
            ),
          );
        }
        return lines;
      },
      handleInput(data: string) {
        if (nameEditor) {
          if (matchesKey(data, Key.escape)) {
            nameEditor = null;
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.enter)) {
            confirmNewReviewer();
            tui.requestRender();
            return;
          }
          nameEditor.handleInput(data);
          tui.requestRender();
          return;
        }

        if (promptEditor) {
          const reviewer = selections[cursor].reviewer;
          if (matchesKey(data, Key.ctrl("s"))) {
            reviewer.systemPrompt = promptEditor.getText().trim();
            saveReviewerToDisk(reviewer);
            promptEditor = null;
            ctx.ui.notify(`Saved ${reviewer.name} prompt to disk`, "info");
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.escape)) {
            // Keep the edit in memory (used for this review) without writing.
            reviewer.systemPrompt = promptEditor.getText().trim();
            promptEditor = null;
            tui.requestRender();
            return;
          }
          // Enter is inert (disableSubmit); shift+enter inserts a newline.
          promptEditor.handleInput(data);
          tui.requestRender();
          return;
        }

        if (editingField && editor) {
          if (matchesKey(data, Key.escape)) {
            stopEditing();
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.enter)) {
            const value = editor.getText().trim();
            if (value) {
              if (isCriticRow()) {
                const ci = criticIndex();
                const c = critics[ci];
                if (editingField === "model") c.model = value;
                else c.reasoning = value;
                config[`critic:${ci}`] = {
                  model: c.model,
                  reasoning: c.reasoning ?? "off",
                };
                onConfigChange(config);
              } else {
                const reviewerName = selections[cursor].reviewer.name;
                config[reviewerName] = {
                  ...config[reviewerName],
                  [editingField]: value,
                };
                onConfigChange(config);
              }
            }
            stopEditing();
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.up)) {
            suggestionIndex = Math.max(0, suggestionIndex - 1);
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.down)) {
            const count = visibleSuggestions().length;
            suggestionIndex = Math.min(
              Math.max(0, count - 1),
              suggestionIndex + 1,
            );
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.tab)) {
            const visible = visibleSuggestions();
            if (visible.length > 0) {
              editor.setText(
                visible[Math.min(suggestionIndex, visible.length - 1)],
              );
              suggestionIndex = 0;
            }
            tui.requestRender();
            return;
          }
          editor.handleInput(data);
          // Typing changes the filtered list, so reset the caret to the top.
          suggestionIndex = 0;
          tui.requestRender();
          return;
        }

        if (matchesKey(data, Key.escape)) {
          done(null);
          return;
        }
        if (matchesKey(data, Key.enter)) {
          const selected = selections
            .filter((s) => s.selected)
            .map((s) => s.reviewer);
          done(selected.length > 0 ? { reviewers: selected, critics } : null);
          return;
        }
        if (matchesKey(data, Key.up)) {
          cursor = Math.max(0, cursor - 1);
        } else if (matchesKey(data, Key.down)) {
          cursor = Math.min(totalItems() - 1, cursor + 1);
        } else if (data === "m") {
          startEditing("model");
        } else if (data === "r") {
          startEditing("reasoning");
        } else if (!isCriticRow()) {
          if (matchesKey(data, Key.space)) {
            selections[cursor].selected = !selections[cursor].selected;
          } else if (data === "e") {
            startPromptEdit();
          } else if (data === "n") {
            startNewReviewer();
          }
        }
        tui.requestRender();
      },
      invalidate() {
        text.invalidate();
        editor?.invalidate();
        promptEditor?.invalidate();
        nameEditor?.invalidate();
      },
    };
  });
}

// ── Default export ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  createExtension(pi);
}
