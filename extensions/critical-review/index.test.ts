import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type {
  ChildProcessWithoutNullStreams,
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  SpawnSyncReturns,
} from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Mocks ────────────────────────────────────────────────────────────

type MockChildProcess = EventEmitter &
  Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr" | "pid" | "kill">;
type MockSpawnFn = (
  cmd: Parameters<typeof nodeSpawn>[0],
  args?: readonly string[],
  options?: Parameters<typeof nodeSpawn>[2],
) => MockChildProcess;
type MockSpawnSyncFn = (
  cmd: Parameters<typeof nodeSpawnSync>[0],
  args?: Parameters<typeof nodeSpawnSync>[1],
  options?: Parameters<typeof nodeSpawnSync>[2],
) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr">;

const childProcessMock = vi.hoisted(() => {
  const MOCK_MODEL_LIST = [
    "provider  model        context  max-out  thinking  images",
    "anthropic claude-sonnet-4-5  200K  64K  yes  yes",
    "anthropic claude-sonnet-4-6  1M    64K  yes  yes",
    "anthropic claude-opus-4-6   1M    128K yes  yes",
    "openai    gpt-5.4            1M    32K  yes  yes",
    "google    gemini-3.1-pro-preview  2M  64K  yes  yes",
  ].join("\n");
  const defaultSpawnSyncResult = {
    status: 0,
    stdout: "",
    stderr: MOCK_MODEL_LIST,
  };
  return {
    spawn: vi.fn<MockSpawnFn>(),
    spawnSync: vi.fn<MockSpawnSyncFn>().mockReturnValue(defaultSpawnSyncResult),
    defaultSpawnSyncResult,
  };
});

vi.mock("node:child_process", () => ({
  spawn: childProcessMock.spawn,
  spawnSync: childProcessMock.spawnSync,
}));

const clipboardMock = vi.hoisted(() => ({
  writeText: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock("./clipboard.js", () => ({
  copyToClipboard: clipboardMock.writeText,
}));

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, Terminal, TUI } from "@earendil-works/pi-tui";
import {
  parseArgs,
  buildUsageLines,
  loadReviewers,
  writeReviewerPrompt,
  findLatestClaudeOpusModel,
  loadModelConfig,
  saveModelConfig,
  validateModelConfig,
  parsePiModelList,
  parseReviewerIssues,
  parseKeepList,
  OutputLog,
  formatElapsed,
  buildStatusBarLines,
  buildWatchPanelFrame,
  sanitizeDiff,
  parseJsonModeOutput,
  createExtension,
  DEFAULT_CRITICS,
  COMMAND_DEFS,
  type CriticalReviewPi,
} from "./index.js";

// ── Key constants ────────────────────────────────────────────────────

const ESC = "\x1b";
const ENTER = "\r";
const ESCAPE = ESC;
const TAB = "\t";
const BACKSPACE = "\x7f";
const CTRL_A = "\x01"; // move cursor to line start (Editor keybinding)
const CTRL_S = "\x13"; // save the edited prompt to disk
const ARROW_UP = "\x1b[A";
const ARROW_DOWN = "\x1b[B";

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── MockPi ───────────────────────────────────────────────────────────

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandConfig = Parameters<ExtensionAPI["registerCommand"]>[1];
type CommandHandler = CommandConfig["handler"];

interface RegisteredCommand {
  name: string;
  config: CommandConfig;
}

interface SendUserMessageCall {
  content: Parameters<ExtensionAPI["sendUserMessage"]>[0];
  options?: Parameters<ExtensionAPI["sendUserMessage"]>[1];
}

interface MockPi extends CriticalReviewPi {
  events: Map<string, EventHandler[]>;
  commands: Map<string, RegisteredCommand>;
  sentMessages: SendUserMessageCall[];
  fire(name: string, event: unknown, ctx: MockCtx): Promise<void>;
  runCommand(
    name: string,
    args: string,
    ctx: MockCtx,
  ): ReturnType<CommandHandler>;
}

function makeMockPi(): MockPi {
  const events = new Map<string, EventHandler[]>();
  const commands = new Map<string, RegisteredCommand>();
  const sentMessages: SendUserMessageCall[] = [];
  const pi: MockPi = {
    events,
    commands,
    sentMessages,
    on: ((name: string, fn: EventHandler) => {
      const list = events.get(name) ?? [];
      list.push(fn);
      events.set(name, list);
    }) as MockPi["on"],
    registerCommand(name, config) {
      commands.set(name, { name, config });
    },
    sendUserMessage: ((
      content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
      options?: Parameters<ExtensionAPI["sendUserMessage"]>[1],
    ) => {
      sentMessages.push({ content, options });
    }) as ExtensionAPI["sendUserMessage"],
    async fire(name, event, ctx) {
      const list = events.get(name) ?? [];
      for (const fn of list) {
        void fn(event, ctx as unknown as ExtensionContext);
      }
      await new Promise((r) => setImmediate(r));
    },
    runCommand(name, args, ctx) {
      const cmd = commands.get(name);
      if (!cmd) throw new Error(`Command not registered: ${name}`);
      return cmd.config.handler(
        args,
        ctx as unknown as Parameters<CommandHandler>[1],
      );
    },
  };
  return pi;
}

// ── MockCtx ──────────────────────────────────────────────────────────

type CustomFactory = Parameters<ExtensionUIContext["custom"]>[0];
type CustomTheme = Parameters<CustomFactory>[1];
type CustomComponent = Component & {
  handleInput(input: string): void;
  invalidate(): void;
  dispose?(): void;
};

interface MockActiveTui {
  requestRender: TUI["requestRender"];
  terminal: Pick<Terminal, "rows" | "columns">;
}

interface ActiveCustom {
  tui: MockActiveTui;
  done: (val: unknown) => void;
  component: CustomComponent;
  promise: Promise<unknown>;
}

interface Notification {
  msg: string;
  level: "info" | "warning" | "error";
}

interface MockUiContext {
  notifications: Notification[];
  statuses: Map<string, string | undefined>;
  statusHistory: Array<{ key: string; text: string | undefined }>;
  widgets: Map<string, string[] | undefined>;
  notify: ExtensionUIContext["notify"];
  setStatus: ExtensionUIContext["setStatus"];
  setWidget: ExtensionUIContext["setWidget"];
  custom: ExtensionUIContext["custom"];
  hasActiveCustom(): boolean;
  activeTui(): MockActiveTui;
  fireInput(input: string): void;
  renderActive(width?: number): string[];
  invalidateActive(): void;
  exitActive(value?: unknown): void;
}

/**
 * MockCtx must stay in sync with ExtensionCommandContext.
 * Pick<> ensures that if the extension starts using new ctx properties,
 * TypeScript will flag the mock as incompatible at the `as unknown as` cast site.
 */
type MockCtxBase = Pick<
  ExtensionCommandContext,
  "cwd" | "hasUI" | "isIdle" | "waitForIdle" | "abort"
> & {
  ui: MockUiContext;
};

interface MockCtx extends MockCtxBase {
  abortCalls: number;
  enterIdleState(): void;
  exitIdleState(): void;
  rejectIdleWaiters(err: unknown): void;
  pendingIdleWaiters(): number;
}

function makeMockCtx(opts: { cwd?: string; hasUI?: boolean } = {}): MockCtx {
  let active: ActiveCustom | undefined;
  const requireActive = (): ActiveCustom => {
    if (!active) throw new Error("no active ui.custom component");
    return active;
  };
  let isIdle = true;
  const idleWaiters: Array<() => void> = [];
  const idleRejecters: Array<(err: unknown) => void> = [];
  const ui: MockUiContext = {
    notifications: [],
    statuses: new Map(),
    statusHistory: [],
    widgets: new Map(),
    notify(msg, level) {
      ui.notifications.push({ msg, level: level ?? "info" });
    },
    setStatus(key, text) {
      ui.statuses.set(key, text);
      ui.statusHistory.push({ key, text });
    },
    setWidget(key: string, content: unknown) {
      ui.widgets.set(key, content as string[] | undefined);
    },
    custom: (async (factory: CustomFactory) => {
      const tui: MockActiveTui = {
        requestRender: vi.fn(),
        terminal: { rows: 40, columns: 120 },
      };
      const theme = {
        fg: (_color: string, text?: string) => text ?? "",
        bold: (text: string) => text,
      } as unknown as CustomTheme;
      const kb = {} as KeybindingsManager;
      let resolveDone!: (val: unknown) => void;
      const promise = new Promise<unknown>((res) => {
        resolveDone = res;
      });
      const done = (val: unknown) => {
        resolveDone(val);
        active = undefined;
      };
      const component = (await factory(
        tui as unknown as TUI,
        theme,
        kb,
        done as (result: never) => void,
      )) as CustomComponent;
      active = { tui, done, component, promise };
      return promise as Promise<never>;
    }) as ExtensionUIContext["custom"],
    hasActiveCustom: () => active !== undefined,
    activeTui: () => requireActive().tui,
    fireInput: (input) => requireActive().component.handleInput(input),
    renderActive: (width = 80) => requireActive().component.render(width),
    invalidateActive: () => requireActive().component.invalidate(),
    exitActive: (value) => requireActive().done(value),
  };

  let abortCalls = 0;
  const ctx: MockCtx = {
    cwd: opts.cwd ?? "/home/user/project",
    hasUI: opts.hasUI ?? true,
    isIdle: () => isIdle,
    waitForIdle: () => {
      if (isIdle) return Promise.resolve();
      return new Promise<void>((res, rej) => {
        idleWaiters.push(res);
        idleRejecters.push(rej);
      });
    },
    abort: () => {
      abortCalls += 1;
    },
    ui,
    enterIdleState: () => {
      isIdle = true;
      const waiters = idleWaiters.splice(0);
      for (const r of waiters) r();
    },
    exitIdleState: () => {
      isIdle = false;
    },
    rejectIdleWaiters: (err: unknown) => {
      idleWaiters.length = 0;
      const rejecters = idleRejecters.splice(0);
      for (const rej of rejecters) rej(err);
    },
    pendingIdleWaiters: () => idleRejecters.length,
    get abortCalls() {
      return abortCalls;
    },
  };
  return ctx;
}

// ── Wait helper ──────────────────────────────────────────────────────

async function waitFor(
  predicate: () => boolean,
  opts: { what: string; timeoutMs?: number } = { what: "condition" },
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(
        `waitFor: ${opts.what} not satisfied within ${timeoutMs}ms`,
      );
    await new Promise((r) => setImmediate(r));
  }
}

// ── Spawn controller ─────────────────────────────────────────────────

interface HeldProcess {
  command: string;
  complete: (override?: {
    stdout?: string;
    stderr?: string;
    code?: number;
  }) => void;
}

function makeSpawnController() {
  const queue: Array<{
    cmd: string;
    args: string[];
    stdout?: string;
    stderr?: string;
    code?: number;
    hold?: boolean;
  }> = [];
  const held: HeldProcess[] = [];
  let nextPid = 10_000;

  const spawnMock = childProcessMock.spawn;
  spawnMock.mockImplementation(
    (
      cmd: Parameters<MockSpawnFn>[0],
      args: readonly string[] = [],
      _options?: Parameters<MockSpawnFn>[2],
    ): MockChildProcess => {
      const next = queue.shift();
      if (!next) {
        throw new Error(
          `Unexpected spawn: ${cmd} ${Array.from(args).join(" ")}`,
        );
      }

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let closed = false;
      const proc: MockChildProcess = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        pid: nextPid,
        kill: vi.fn<MockChildProcess["kill"]>(() => {
          queueMicrotask(() => complete({ code: 1 }));
          return true;
        }),
      });
      nextPid += 1;

      const complete = (
        override: { stdout?: string; stderr?: string; code?: number } = {},
      ) => {
        if (closed) return;
        const heldIndex = held.findIndex((item) => item.complete === complete);
        if (heldIndex >= 0) held.splice(heldIndex, 1);
        closed = true;
        const result = { ...next, ...override };
        if (result.stdout) stdout.emit("data", Buffer.from(result.stdout));
        if (result.stderr) stderr.emit("data", Buffer.from(result.stderr));
        proc.emit("close", result.code ?? 0);
      };

      if (next.hold) {
        held.push({
          command: `${cmd} ${Array.from(args).join(" ")}`,
          complete,
        });
      } else {
        queueMicrotask(() => complete());
      }

      return proc;
    },
  );

  return {
    queue,
    held,
    enqueue(opts: {
      cmd: string;
      args: string[];
      stdout?: string;
      stderr?: string;
      code?: number;
      hold?: boolean;
    }) {
      queue.push(opts);
    },
  };
}

// ── tmpdir ───────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "critical-review-"));
  childProcessMock.spawn.mockReset();
  childProcessMock.spawnSync.mockReset();
  childProcessMock.spawnSync.mockReturnValue(
    childProcessMock.defaultSpawnSyncResult,
  );
  clipboardMock.writeText.mockReset();
  clipboardMock.writeText.mockResolvedValue(undefined);
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ── Harness ──────────────────────────────────────────────────────────

interface Harness {
  pi: MockPi;
  reviewersDir: string;
}

/**
 * Create a test reviewer .md file in the given directory.
 * Returns the directory path.
 */
function writeTestReviewer(
  dir: string,
  opts: {
    name?: string;
    description?: string;
    tools?: string;
    prompt?: string;
    canEditCode?: boolean;
  } = {},
): string {
  mkdirSync(dir, { recursive: true });
  const name = opts.name ?? "test-reviewer";
  writeFileSync(
    join(dir, `${name}.md`),
    `---
name: ${name}
description: ${opts.description ?? "Finds test issues"}
tools: ${opts.tools ?? "read, grep"}
can_edit_code: ${opts.canEditCode ?? false}
---

${opts.prompt ?? "You are a test reviewer."}
`,
  );
  return dir;
}

/**
 * Set up the extension with a reviewers directory.
 * Optionally seeds the directory with a default test reviewer.
 */
function setupExtension(opts?: {
  withReviewer?: boolean;
  reviewersDir?: string;
  userReviewersDir?: string;
  configPath?: string;
}): Harness {
  const pi = makeMockPi();
  const reviewersDir = opts?.reviewersDir ?? join(tmpDir, "reviewers");
  const userReviewersDir =
    opts?.userReviewersDir ?? join(tmpDir, "user-reviewers");
  const configPath = opts?.configPath ?? join(tmpDir, "config.json");
  if (opts?.withReviewer) {
    writeTestReviewer(reviewersDir);
  }
  createExtension(pi, { reviewersDir, userReviewersDir, configPath });
  return { pi, reviewersDir };
}

/**
 * Enqueue the standard gh + git spawns for a PR context.
 * Returns the branch names used so tests can assert against them.
 */
function enqueuePRContext(
  spawner: ReturnType<typeof makeSpawnController>,
  opts?: {
    title?: string;
    body?: string;
    base?: string;
    head?: string;
    diff?: string;
  },
) {
  const base = opts?.base ?? "main";
  const head = opts?.head ?? "feature";
  spawner.enqueue({
    cmd: "gh",
    args: ["pr", "view", "--json", "title,body,baseRefName,headRefName"],
    stdout: JSON.stringify({
      title: opts?.title ?? "Test PR",
      body: opts?.body ?? "PR description",
      baseRefName: base,
      headRefName: head,
    }),
  });
  spawner.enqueue({
    cmd: "git",
    args: ["diff", `${base}...${head}`],
    stdout: opts?.diff ?? "diff --git a/src/foo.ts b/src/foo.ts\n+added line\n",
  });
  return { base, head };
}

interface AgentEnqueueOpts {
  hold?: boolean;
  usage?: { input: number; output: number };
}

/**
 * Enqueue a reviewer subagent spawn that returns the given output text.
 */
function enqueueReviewerAgent(
  spawner: ReturnType<typeof makeSpawnController>,
  output: string,
  opts?: AgentEnqueueOpts,
) {
  spawner.enqueue({
    cmd: expect.any(String) as unknown as string,
    args: expect.any(Array) as unknown as string[],
    stdout: JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: output }],
        usage: opts?.usage ?? undefined,
      },
    }),
    hold: opts?.hold ?? true,
  });
}

/**
 * Enqueue a critic subagent spawn that returns APPROVE or REJECT.
 */
function enqueueCriticAgent(
  spawner: ReturnType<typeof makeSpawnController>,
  verdict: "APPROVE" | "REJECT",
  reason: string,
  opts?: AgentEnqueueOpts,
) {
  enqueueReviewerAgent(spawner, `VERDICT: ${verdict}\nReason: ${reason}`, opts);
}

/** Enqueue one critic per DEFAULT_CRITICS entry, all with the same verdict. */
function enqueueAllCritics(
  spawner: ReturnType<typeof makeSpawnController>,
  verdict: "APPROVE" | "REJECT",
  reason: string,
) {
  for (let i = 0; i < DEFAULT_CRITICS.length; i++) {
    enqueueCriticAgent(spawner, verdict, reason);
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("returns help for -help", () => {
    expect(parseArgs("-help")).toEqual({ kind: "help" });
  });

  it("returns watch for -watch", () => {
    expect(parseArgs("-watch")).toEqual({ kind: "watch" });
  });

  it("returns abort for -abort", () => {
    expect(parseArgs("-abort")).toEqual({ kind: "abort" });
  });

  it("returns fix for -fix", () => {
    expect(parseArgs("-fix")).toEqual({ kind: "fix" });
  });

  it("returns fix-loop for -fix-loop", () => {
    expect(parseArgs("-fix-loop")).toEqual({ kind: "fix-loop" });
  });

  it("returns review for empty args", () => {
    expect(parseArgs("")).toEqual({ kind: "review" });
  });

  it("returns review for whitespace-only args", () => {
    expect(parseArgs("   ")).toEqual({ kind: "review" });
  });

  it("returns invalid for unknown flags", () => {
    const result = parseArgs("-unknown");
    expect(result).toEqual(expect.objectContaining({ kind: "invalid" }));
  });

  it("handles every flag in COMMAND_DEFS", () => {
    for (const def of COMMAND_DEFS) {
      const result = parseArgs(def.flag);
      expect(result.kind, `${def.flag} should parse to ${def.kind}`).toBe(
        def.kind,
      );
    }
  });
});

describe("buildUsageLines", () => {
  it("includes every flag from COMMAND_DEFS", () => {
    const usage = buildUsageLines().join("\n");
    for (const def of COMMAND_DEFS) {
      expect(usage, `Usage should include ${def.flag}`).toContain(def.flag);
      expect(
        usage,
        `Usage should include description for ${def.flag}`,
      ).toContain(def.description);
    }
  });
});

describe("loadReviewers", () => {
  it("loads .md files with valid frontmatter from a directory", () => {
    const dir = join(tmpDir, "reviewers");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "test-reviewer.md"),
      `---
name: test-reviewer
description: Tests things
tools: read, grep
can_edit_code: false
---

You are a test reviewer.
`,
    );

    const reviewers = loadReviewers(dir);
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0].name).toBe("test-reviewer");
    expect(reviewers[0].description).toBe("Tests things");
    expect(reviewers[0].tools).toEqual(["read", "grep"]);
    expect(
      reviewers[0].canEditCode,
      "can_edit_code: false in frontmatter should parse as false",
    ).toBe(false);
    expect(reviewers[0].systemPrompt).toContain("You are a test reviewer.");
  });

  it("throws for file with no frontmatter", () => {
    const dir = join(tmpDir, "reviewers");
    mkdirSync(dir);
    writeFileSync(join(dir, "bad.md"), "No frontmatter here");

    expect(() => loadReviewers(dir)).toThrow("bad.md");
  });

  it("throws for file missing name", () => {
    const dir = join(tmpDir, "no-name-rev");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "noname.md"),
      "---\ndescription: Desc\ntools: read\ncan_edit_code: false\n---\nprompt",
    );

    expect(() => loadReviewers(dir)).toThrow("name");
  });

  it("throws for file missing description", () => {
    const dir = join(tmpDir, "no-desc-rev");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "nodesc.md"),
      "---\nname: test\ntools: read\ncan_edit_code: false\n---\nprompt",
    );

    expect(() => loadReviewers(dir)).toThrow("description");
  });

  it("returns empty array for non-existent directory", () => {
    const reviewers = loadReviewers(join(tmpDir, "nope"));
    expect(reviewers).toHaveLength(0);
  });

  it("throws for file missing can_edit_code", () => {
    const dir = join(tmpDir, "no-can-edit-rev");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "noedit.md"),
      "---\nname: test\ndescription: Desc\ntools: read\n---\nprompt",
    );

    expect(() => loadReviewers(dir)).toThrow("can_edit_code");
  });

  it("parses can_edit_code from frontmatter", () => {
    const dir = join(tmpDir, "can-edit-rev");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "editor.md"),
      "---\nname: editor\ndescription: Edits code\ntools: read\ncan_edit_code: true\n---\nprompt",
    );
    writeFileSync(
      join(dir, "reader.md"),
      "---\nname: reader\ndescription: Reads code\ntools: read\ncan_edit_code: false\n---\nprompt",
    );

    const reviewers = loadReviewers(dir);
    const editor = reviewers.find((r) => r.name === "editor")!;
    const reader = reviewers.find((r) => r.name === "reader")!;
    expect(editor.canEditCode, "editor should have canEditCode=true").toBe(
      true,
    );
    expect(reader.canEditCode, "reader should have canEditCode=false").toBe(
      false,
    );
  });

  it("loads multiple reviewers", () => {
    const dir = join(tmpDir, "reviewers");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "a.md"),
      `---\nname: alpha\ndescription: Alpha\ntools: read\ncan_edit_code: false\n---\nPrompt A`,
    );
    writeFileSync(
      join(dir, "b.md"),
      `---\nname: beta\ndescription: Beta\ntools: grep\ncan_edit_code: false\n---\nPrompt B`,
    );

    const reviewers = loadReviewers(dir);
    expect(reviewers).toHaveLength(2);
    const names = reviewers.map((r) => r.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });
});

describe("loadModelConfig / saveModelConfig", () => {
  it("returns empty object when config file does not exist", () => {
    const config = loadModelConfig(join(tmpDir, "nonexistent.json"));
    expect(config).toEqual({});
  });

  it("loads config from a JSON file", () => {
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        correctness: { model: "claude-sonnet-4-5", reasoning: "off" },
      }),
    );
    const config = loadModelConfig(configPath);
    expect(config.correctness).toEqual({
      model: "claude-sonnet-4-5",
      reasoning: "off",
    });
  });

  it("saves config to a JSON file", () => {
    const configPath = join(tmpDir, "save-test.json");
    const config = {
      security: { model: "gpt-5.4", reasoning: "high" },
    };
    saveModelConfig(configPath, config);
    const loaded = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(loaded).toEqual(config);
  });

  it("creates parent directories when saving", () => {
    const configPath = join(tmpDir, "nested", "dir", "config.json");
    saveModelConfig(configPath, { test: { model: "m", reasoning: "off" } });
    expect(
      existsSync(configPath),
      `saveModelConfig should create missing parent directories for ${configPath}`,
    ).toBe(true);
  });
});

describe("validateModelConfig", () => {
  const knownModels = new Set([
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-opus-4-6",
  ]);

  it("returns no errors for a qualified provider/model config entry", () => {
    const config = {
      test: { model: "anthropic/claude-sonnet-4-5", reasoning: "off" },
    };
    expect(validateModelConfig(config, knownModels)).toHaveLength(0);
  });

  it("accepts a bare model name that matches a known provider/model suffix", () => {
    const config = {
      test: { model: "claude-sonnet-4-5", reasoning: "off" },
    };
    expect(validateModelConfig(config, knownModels)).toHaveLength(0);
  });

  it("returns error for unknown model", () => {
    const config = {
      test: { model: "nonexistent-model", reasoning: "off" },
    };
    const errors = validateModelConfig(config, knownModels);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("nonexistent-model");
    expect(errors[0]).toContain("test");
  });

  it("returns error for invalid reasoning level", () => {
    const config = {
      test: { model: "anthropic/claude-sonnet-4-5", reasoning: "turbo" },
    };
    const errors = validateModelConfig(config, knownModels);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("turbo");
  });

  it("returns error for empty model", () => {
    const config = {
      test: { model: "", reasoning: "off" },
    };
    const errors = validateModelConfig(config, knownModels);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("test");
  });
});

describe("findLatestClaudeOpusModel", () => {
  it("returns the highest-version claude opus model", () => {
    const models = [
      "claude-sonnet-4-6",
      "claude-opus-4-0",
      "claude-opus-4-1",
      "claude-opus-4-6",
      "gpt-5.4",
    ];
    expect(findLatestClaudeOpusModel(models)).toBe("claude-opus-4-6");
  });

  it("prefers the undated alias over a dated snapshot of the same version", () => {
    const models = ["claude-opus-4-1-20250805", "claude-opus-4-1"];
    expect(findLatestClaudeOpusModel(models)).toBe("claude-opus-4-1");
  });

  it("matches case-insensitively", () => {
    const models = ["Claude-Opus-4-2", "claude-sonnet-4-5"];
    expect(findLatestClaudeOpusModel(models)).toBe("Claude-Opus-4-2");
  });

  it("returns undefined when no claude opus model is present", () => {
    const models = ["claude-sonnet-4-5", "gpt-5.4", "gemini-3.1-pro-preview"];
    expect(findLatestClaudeOpusModel(models)).toBeUndefined();
  });

  it("handles provider-qualified model names", () => {
    const models = [
      "anthropic/claude-opus-4-6",
      "anthropic-250k/claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
    ];
    expect(findLatestClaudeOpusModel(models)).toBe("anthropic/claude-opus-4-6");
  });
});

describe("writeReviewerPrompt", () => {
  it("replaces the prompt body while preserving frontmatter", () => {
    const dir = join(tmpDir, "write-prompt-rev");
    writeTestReviewer(dir, {
      name: "editable",
      description: "Original description",
      tools: "read, grep",
      canEditCode: false,
      prompt: "Old instructions.",
    });
    const filePath = join(dir, "editable.md");

    writeReviewerPrompt(
      filePath,
      "Brand new instructions.\nWith a second line.",
    );

    const reviewers = loadReviewers(dir);
    expect(reviewers).toHaveLength(1);
    const reviewer = reviewers[0];
    expect(reviewer.systemPrompt, "Prompt body should be replaced").toBe(
      "Brand new instructions.\nWith a second line.",
    );
    expect(reviewer.name, "Frontmatter name should be preserved").toBe(
      "editable",
    );
    expect(
      reviewer.description,
      "Frontmatter description should be preserved",
    ).toBe("Original description");
    expect(reviewer.tools, "Frontmatter tools should be preserved").toEqual([
      "read",
      "grep",
    ]);
    expect(
      reviewer.canEditCode,
      "Frontmatter can_edit_code should be preserved",
    ).toBe(false);
  });
});

describe("parsePiModelList", () => {
  it("qualifies each model with its provider", () => {
    const output = [
      "provider                              model                       context  max-out  thinking  images",
      "anthropic                             claude-sonnet-4-5           200K     64K      yes       yes",
      "openai                                gpt-4o                      128K     16K      no        yes",
    ].join("\n");
    const models = parsePiModelList(output);
    expect(models).toContain("anthropic/claude-sonnet-4-5");
    expect(models).toContain("openai/gpt-4o");
    expect(models).not.toContain("provider");
  });

  it("keeps models from different providers distinct", () => {
    const output = [
      "provider                              model                       context  max-out  thinking  images",
      "anthropic                             claude-opus-4-6             1M       128K     yes       yes",
      "anthropic-250k                        claude-opus-4-6             250K     128K     yes       yes",
    ].join("\n");
    const models = parsePiModelList(output);
    expect(models.size, "Both provider variants should be distinct").toBe(2);
    expect(models).toContain("anthropic/claude-opus-4-6");
    expect(models).toContain("anthropic-250k/claude-opus-4-6");
  });

  it("returns empty set for empty output", () => {
    expect(parsePiModelList("").size).toBe(0);
  });
});

describe("parseReviewerIssues", () => {
  it("parses a single issue from reviewer output", () => {
    const output = `Looking at the code...

ISSUE:
file: src/foo.ts
line: 42
severity: high
title: Null pointer dereference
description: The variable x is used without checking for null first.
END_ISSUE

That's all I found.`;

    const { issues, errors } = parseReviewerIssues(output, "test-reviewer");
    expect(errors).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      file: "src/foo.ts",
      line: 42,
      severity: "high",
      title: "Null pointer dereference",
      description: "The variable x is used without checking for null first.",
      reviewer: "test-reviewer",
    });
  });

  it("parses multiple issues", () => {
    const output = `ISSUE:
file: a.ts
line: 1
severity: high
title: Bug A
description: Desc A
END_ISSUE

ISSUE:
file: b.ts
line: 2
severity: medium
title: Bug B
description: Desc B
END_ISSUE`;

    const { issues } = parseReviewerIssues(output, "reviewer");
    expect(issues).toHaveLength(2);
    expect(issues[0].file).toBe("a.ts");
    expect(issues[1].file).toBe("b.ts");
  });

  it("returns empty array for output with no issues", () => {
    const { issues, errors } = parseReviewerIssues(
      "Looks good to me!",
      "reviewer",
    );
    expect(issues).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("defaults missing non-critical fields and logs warnings", () => {
    const output = `ISSUE:
file: src/foo.ts
title: Missing description and line
END_ISSUE`;

    const result = parseReviewerIssues(output, "reviewer");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].file).toBe("src/foo.ts");
    expect(result.issues[0].title).toBe("Missing description and line");
    expect(result.issues[0].line).toBe(1);
    expect(result.issues[0].severity).toBe("medium");
    expect(result.issues[0].description).toBe("Missing description and line");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("defaulted");
  });

  it("drops block missing file (required)", () => {
    const output = `ISSUE:
line: 5
severity: high
title: No file
description: Something is wrong
END_ISSUE`;

    const result = parseReviewerIssues(output, "reviewer");
    expect(result.issues).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("file");
  });

  it("drops block missing title (required)", () => {
    const output = `ISSUE:
file: src/foo.ts
line: 5
severity: high
description: Something is wrong
END_ISSUE`;

    const result = parseReviewerIssues(output, "reviewer");
    expect(result.issues).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("title");
  });

  it("handles multiline descriptions", () => {
    const output = `ISSUE:
file: src/foo.ts
line: 10
severity: medium
title: Bad logic
description: The condition on line 10 is wrong.
It should check for both x and y.
END_ISSUE`;

    const { issues } = parseReviewerIssues(output, "reviewer");
    expect(issues).toHaveLength(1);
    expect(issues[0].description).toContain("both x and y");
  });
});

describe("parseKeepList", () => {
  it("parses a valid KEEP line", () => {
    expect(parseKeepList("KEEP: 1, 3, 5", 5)).toEqual([1, 3, 5]);
  });

  it("returns undefined for output without KEEP", () => {
    expect(
      parseKeepList("I think we should keep all of them", 3),
    ).toBeUndefined();
  });

  it("filters out-of-range IDs", () => {
    expect(parseKeepList("KEEP: 1, 99", 3)).toEqual([1]);
  });

  it("returns undefined when all IDs are invalid", () => {
    expect(parseKeepList("KEEP: 99, 100", 3)).toBeUndefined();
  });
});

describe("OutputLog", () => {
  it("appends lines with a label prefix", () => {
    const log = new OutputLog(100);
    log.append("hello world", "test");
    expect(log.lines()).toEqual(["[test] hello world"]);
  });

  it("respects max line limit", () => {
    const log = new OutputLog(3);
    log.append("line 1");
    log.append("line 2");
    log.append("line 3");
    log.append("line 4");
    expect(log.lines()).toHaveLength(3);
    expect(log.lines()[0]).toBe("line 2");
  });

  it("calls onChange when lines are appended", () => {
    const log = new OutputLog(100);
    const onChange = vi.fn();
    log.onChange = onChange;
    log.append("hello");
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("clears all lines", () => {
    const log = new OutputLog(100);
    log.append("hello");
    log.clear();
    expect(log.lines()).toHaveLength(0);
  });
});

describe("formatElapsed", () => {
  it("shows hours:minutes", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(30_000)).toBe("0:00");
    expect(formatElapsed(60_000)).toBe("0:01");
    expect(formatElapsed(90_000)).toBe("0:01");
    expect(formatElapsed(180_000)).toBe("0:03");
    expect(formatElapsed(3_600_000)).toBe("1:00");
    expect(formatElapsed(7_200_000)).toBe("2:00");
    expect(formatElapsed(23_160_000)).toBe("6:26");
    expect(formatElapsed(14_340_000)).toBe("3:59");
  });
});

describe("buildStatusBarLines", () => {
  it("includes the step name in output", () => {
    const lines = buildStatusBarLines({
      state: "running",
      step: "Running reviewers",
      elapsedMs: 5000,
    });
    const text = lines.join("\n");
    expect(text).toContain("Running reviewers");
  });
});

describe("sanitizeDiff", () => {
  it("removes binary file diffs", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "+added line",
      "diff --git a/image.png b/image.png",
      "Binary files differ",
      "diff --git a/src/bar.ts b/src/bar.ts",
      "--- a/src/bar.ts",
      "+++ b/src/bar.ts",
      "+another line",
    ].join("\n");

    const result = sanitizeDiff(diff);
    expect(result).toContain("src/foo.ts");
    expect(result).toContain("src/bar.ts");
    expect(result).not.toContain("image.png");
  });

  it("removes generated file diffs (lock files)", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "+real change",
      "diff --git a/package-lock.json b/package-lock.json",
      "+lock file content",
    ].join("\n");

    const result = sanitizeDiff(diff);
    expect(result).toContain("src/foo.ts");
    expect(result).not.toContain("package-lock.json");
  });

  it("returns the diff unchanged if no binary or generated files", () => {
    const diff = "diff --git a/src/foo.ts b/src/foo.ts\n+added line";
    const result = sanitizeDiff(diff);
    expect(result).toBe(diff);
  });
});

describe("parseJsonModeOutput usage extraction", () => {
  it("extracts token usage from JSON mode output", () => {
    const output = [
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
          model: "claude-sonnet-4-5",
        },
      }),
    ].join("\n");

    const usage = parseJsonModeOutput(output).usage;
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.cacheReadTokens).toBe(10);
    expect(usage.cacheWriteTokens).toBe(5);
    expect(usage.turns).toBe(1);
  });

  it("accumulates across multiple turns", () => {
    const output = [
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Turn 1" }],
          usage: { input: 100, output: 50 },
        },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Turn 2" }],
          usage: { input: 200, output: 80 },
        },
      }),
    ].join("\n");

    const usage = parseJsonModeOutput(output).usage;
    expect(usage.inputTokens).toBe(300);
    expect(usage.outputTokens).toBe(130);
    expect(usage.turns).toBe(2);
  });

  it("returns zeros for output with no usage data", () => {
    const usage = parseJsonModeOutput("no json here").usage;
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.turns).toBe(0);
  });
});

describe("parseJsonModeOutput", () => {
  it("extracts stopReason and errorMessage from message_end events", () => {
    const output = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fail" }],
        usage: { input: 10, output: 5 },
        stopReason: "error",
        errorMessage: "Context window exceeded",
      },
    });

    const result = parseJsonModeOutput(output);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Context window exceeded");
  });

  it("leaves stopReason/errorMessage undefined when not present", () => {
    const output = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: { input: 10, output: 5 },
      },
    });

    const result = parseJsonModeOutput(output);
    expect(result.stopReason).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
  });
});

describe("buildWatchPanelFrame", () => {
  it("renders log lines in a bordered frame", () => {
    const lines = buildWatchPanelFrame({
      logLines: ["line 1", "line 2"],
      offset: 0,
      height: 10,
      width: 40,
    });
    expect(lines[0]).toContain("┌");
    expect(lines[lines.length - 1]).toContain("└");
  });

  it("pads empty space when fewer lines than height", () => {
    const lines = buildWatchPanelFrame({
      logLines: ["only line"],
      offset: 0,
      height: 10,
      width: 40,
    });
    // Should have top border + body lines + legend + bottom border
    expect(lines.length).toBe(10);
  });

  it("replaces non-ASCII characters so they do not break TUI layout", () => {
    const lines = buildWatchPanelFrame({
      logLines: ["✅ done", "⚠️ warning", "🌲 tree", "café naïve"],
      offset: 0,
      height: 10,
      width: 40,
    });
    // Extract body lines (skip top border, legend, bottom border)
    const body = lines.slice(1, -2);
    for (const line of body) {
      // Only box-drawing chars (│┌└─┐┘) and printable ASCII should remain
      const inner = line.slice(1, -1); // strip │ borders
      for (const ch of Array.from(inner)) {
        const code = ch.codePointAt(0) ?? 0;
        expect(
          code,
          `Non-ASCII char U+${code.toString(16)} found in: ${inner}`,
        ).toBeLessThanOrEqual(0x7e);
      }
    }
  });
});

describe("createExtension", () => {
  it("creates user reviewers directory if it does not exist", () => {
    const userDir = join(tmpDir, "auto-created-user-dir");
    expect(
      existsSync(userDir),
      "precondition: user reviewers dir should not exist before createExtension",
    ).toBe(false);
    const pi = makeMockPi();
    const reviewersDir = join(tmpDir, "rev-for-autodir");
    writeTestReviewer(reviewersDir);
    createExtension(pi, { reviewersDir, userReviewersDir: userDir });
    expect(
      existsSync(userDir),
      "createExtension should create the user reviewers dir if missing",
    ).toBe(true);
  });

  describe("-help", () => {
    it("shows usage text via notification", async () => {
      const { pi } = setupExtension({ withReviewer: true });
      const ctx = makeMockCtx();
      await pi.runCommand("critical-review", "-help", ctx);
      const text = ctx.ui.notifications.map((n) => n.msg).join("\n");
      expect(text).toContain("-help");
    });
  });

  describe("-abort", () => {
    it("does nothing when no review is running", async () => {
      const { pi } = setupExtension();
      const ctx = makeMockCtx();
      await pi.runCommand("critical-review", "-abort", ctx);
      const text = ctx.ui.notifications.map((n) => n.msg).join("\n");
      expect(text).toContain("No review");
    });
  });

  describe("-watch", () => {
    it("opens log viewer overlay", async () => {
      const { pi } = setupExtension();
      const ctx = makeMockCtx();

      const watchPromise = pi.runCommand("critical-review", "-watch", ctx);

      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "watch panel to open",
      });

      const lines = ctx.ui.renderActive(80);
      expect(
        lines.length,
        "Watch panel should render at least the border frame",
      ).toBeGreaterThan(0);
      expect(lines[0]).toContain("┌");

      ctx.ui.fireInput(ESCAPE);
      await watchPromise;
    });
  });

  describe("invalid args", () => {
    it("notifies about invalid arguments", async () => {
      const { pi } = setupExtension();
      const ctx = makeMockCtx();
      await pi.runCommand("critical-review", "-bogus", ctx);
      const errorNotifications = ctx.ui.notifications.filter(
        (n) => n.level === "error",
      );
      expect(
        errorNotifications,
        `Expected an error notification but got: ${JSON.stringify(ctx.ui.notifications)}`,
      ).toHaveLength(1);
    });
  });

  describe("review flow", () => {
    it("shows validation errors and blocks review", async () => {
      const reviewersDir = join(tmpDir, "invalid-rev");
      writeTestReviewer(reviewersDir, { name: "bad-reviewer" });
      const configPath = join(tmpDir, "bad-config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          "bad-reviewer": { model: "claude-sonnet-4-5", reasoning: "turbo" },
        }),
      );

      const { pi } = setupExtension({ reviewersDir, configPath });
      const ctx = makeMockCtx();

      await pi.runCommand("critical-review", "", ctx);

      const errorNotifications = ctx.ui.notifications.filter(
        (n) => n.level === "error",
      );
      expect(
        errorNotifications.length,
        `Expected error notification but got: ${JSON.stringify(ctx.ui.notifications)}`,
      ).toBeGreaterThanOrEqual(1);
      expect(errorNotifications[0].msg).toContain("turbo");
    });

    it("loads reviewers from both bundled and user dirs", async () => {
      const reviewersDir = join(tmpDir, "bundled-rev");
      writeTestReviewer(reviewersDir, { name: "bundled" });
      const userReviewersDir = join(tmpDir, "user-rev");
      writeTestReviewer(userReviewersDir, { name: "custom" });

      const { pi } = setupExtension({ reviewersDir, userReviewersDir });
      const ctx = makeMockCtx();

      const reviewPromise = pi.runCommand("critical-review", "", ctx);

      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      const lines = ctx.ui.renderActive(200).map(stripAnsi).join("\n");
      expect(lines, "Should show bundled reviewer").toContain("bundled");
      expect(lines, "Should show user reviewer").toContain("custom");

      ctx.ui.fireInput(ESCAPE);
      await reviewPromise;
    });

    it("shows reviewer selection with user dir hint", async () => {
      const { pi } = setupExtension({ withReviewer: true });
      const ctx = makeMockCtx();

      const reviewPromise = pi.runCommand("critical-review", "", ctx);

      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      const lines = ctx.ui.renderActive(200).map(stripAnsi).join("\n");
      expect(lines).toContain("test-reviewer");
      expect(lines, "Selection UI should mention user reviewers dir").toContain(
        "user-reviewers",
      );

      ctx.ui.fireInput(ESCAPE);
      await reviewPromise;
    });

    it("shows critic configuration in selection UI", async () => {
      const { pi } = setupExtension({ withReviewer: true });
      const ctx = makeMockCtx();

      const reviewPromise = pi.runCommand("critical-review", "", ctx);

      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      const lines = ctx.ui.renderActive(200).map(stripAnsi).join("\n");
      for (const critic of DEFAULT_CRITICS) {
        expect(lines, `Should show critic model ${critic.model}`).toContain(
          critic.model,
        );
      }

      ctx.ui.fireInput(ESCAPE);
      await reviewPromise;
    });

    it("allows editing critic model via 'm' key", async () => {
      const { pi } = setupExtension({ withReviewer: true });
      const ctx = makeMockCtx();

      const reviewPromise = pi.runCommand("critical-review", "", ctx);
      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      // Move cursor past the single reviewer (index 0) to the first critic
      // (index 1). Each critic row shows its model/reasoning like reviewers.
      ctx.ui.fireInput(ARROW_DOWN);
      let lines = ctx.ui.renderActive(200).map(stripAnsi).join("\n");
      expect(lines, "Cursor should point at the first critic").toMatch(
        /→.*critic 1/i,
      );

      // Press 'm' to edit the critic's model
      ctx.ui.fireInput("m");
      lines = ctx.ui.renderActive(200).map(stripAnsi).join("\n");
      expect(lines, "Should show model editing for the critic").toContain(
        "Model for critic 1",
      );

      // Clear the pre-filled value and type a new model
      const prefilled = DEFAULT_CRITICS[0].model;
      for (let i = 0; i < prefilled.length; i++) {
        ctx.ui.fireInput(BACKSPACE);
      }
      for (const ch of "gpt") ctx.ui.fireInput(ch);
      ctx.ui.fireInput(TAB); // accept top autocomplete match
      ctx.ui.fireInput(ENTER); // confirm

      // The critic line should now show the updated model
      lines = ctx.ui.renderActive(200).map(stripAnsi).join("\n");
      expect(
        lines,
        "The critic's model should be updated in the display",
      ).toMatch(/critic 1[\s\S]*model:.*openai\/gpt/i);

      ctx.ui.fireInput(ESCAPE);
      await reviewPromise;
    });

    it("allows editing critic reasoning via 'r' key", async () => {
      const { pi } = setupExtension({ withReviewer: true });
      const ctx = makeMockCtx();

      const reviewPromise = pi.runCommand("critical-review", "", ctx);
      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      // Move to the first critic
      ctx.ui.fireInput(ARROW_DOWN);

      // Press 'r' to edit reasoning
      ctx.ui.fireInput("r");
      let lines = ctx.ui.renderActive(200).map(stripAnsi).join("\n");
      expect(lines, "Should show reasoning editing for critic").toContain(
        "Reasoning for critic 1",
      );

      // Clear and type new reasoning
      for (let i = 0; i < "high".length; i++) ctx.ui.fireInput(BACKSPACE);
      for (const ch of "medium") ctx.ui.fireInput(ch);
      ctx.ui.fireInput(ENTER);

      lines = ctx.ui.renderActive(200).map(stripAnsi).join("\n");
      expect(lines, "The critic's reasoning should be updated").toMatch(
        /critic 1[\s\S]*reasoning: medium/i,
      );

      ctx.ui.fireInput(ESCAPE);
      await reviewPromise;
    });

    it("does not allow space/e/n on critic entries", async () => {
      const { pi } = setupExtension({ withReviewer: true });
      const ctx = makeMockCtx();

      const reviewPromise = pi.runCommand("critical-review", "", ctx);
      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      // Move to the first critic
      ctx.ui.fireInput(ARROW_DOWN);

      // space should NOT toggle (critics are always active)
      ctx.ui.fireInput(" ");
      // e should NOT open prompt editor
      ctx.ui.fireInput("e");
      // n should NOT open new reviewer
      ctx.ui.fireInput("n");

      // We should still be in the list — no editor opened, no name prompt
      const lines = ctx.ui.renderActive(200).map(stripAnsi).join("\n");
      expect(
        lines,
        "Should still show the selection list without any editor",
      ).toContain("Select reviewers");
      expect(lines, "Should not have opened any editing prompt").not.toContain(
        "New reviewer name",
      );

      ctx.ui.fireInput(ESCAPE);
      await reviewPromise;
    });

    it("uses edited critic config in the review", async () => {
      const { pi } = setupExtension({ withReviewer: true });
      const spawner = makeSpawnController();
      const ctx = makeMockCtx();

      enqueuePRContext(spawner);
      enqueueReviewerAgent(
        spawner,
        "ISSUE:\nfile: a.ts\nline: 1\nseverity: high\ntitle: Bug\ndescription: d\nEND_ISSUE",
      );
      // All 3 critics will approve
      enqueueAllCritics(spawner, "APPROVE", "Real bug.");

      void pi.runCommand("critical-review", "", ctx);
      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      // Move to first critic and change its model
      ctx.ui.fireInput(ARROW_DOWN);
      ctx.ui.fireInput("m");
      const prefilled = DEFAULT_CRITICS[0].model;
      for (let i = 0; i < prefilled.length; i++) ctx.ui.fireInput(BACKSPACE);
      for (const ch of "gpt") ctx.ui.fireInput(ch);
      ctx.ui.fireInput(TAB);
      ctx.ui.fireInput(ENTER);

      // Start the review
      ctx.ui.fireInput(ENTER);
      await waitFor(() => !ctx.ui.hasActiveCustom(), {
        what: "selection to close",
      });

      // Wait for the reviewer process
      await waitFor(() => spawner.held.length > 0, {
        what: "reviewer process to start",
      });
      spawner.held[0].complete();

      // Wait for critic processes
      await waitFor(() => spawner.held.length >= DEFAULT_CRITICS.length, {
        what: `${DEFAULT_CRITICS.length} critic processes to start`,
        timeoutMs: 2000,
      });

      // The first critic should have been spawned with the edited model
      const criticCalls = childProcessMock.spawn.mock.calls;
      // After 2 PR-context calls + 1 reviewer call = 3 calls, critics start
      const firstCriticArgs = criticCalls[3][1] as string[];
      const modelIdx = firstCriticArgs.indexOf("--model");
      expect(
        firstCriticArgs[modelIdx + 1],
        "First critic should use the edited model, not the default",
      ).toContain("gpt");

      for (const held of [...spawner.held]) held.complete();

      await waitFor(() => pi.sentMessages.length > 0, {
        what: "review results",
        timeoutMs: 3000,
      });
    });

    it("persists edited critic config across sessions", async () => {
      const reviewersDir = join(tmpDir, "critic-persist-rev");
      writeTestReviewer(reviewersDir, { name: "my-reviewer" });
      const configPath = join(tmpDir, "critic-persist-config.json");

      const { pi } = setupExtension({ reviewersDir, configPath });
      const ctx = makeMockCtx();

      // Session 1: edit critic 1's model
      const reviewPromise = pi.runCommand("critical-review", "", ctx);
      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      ctx.ui.fireInput(ARROW_DOWN); // move to critic 1
      ctx.ui.fireInput("m");
      const prefilled = DEFAULT_CRITICS[0].model;
      for (let i = 0; i < prefilled.length; i++) ctx.ui.fireInput(BACKSPACE);
      for (const ch of "gpt") ctx.ui.fireInput(ch);
      ctx.ui.fireInput(TAB);
      ctx.ui.fireInput(ENTER); // confirm model edit
      ctx.ui.fireInput(ESCAPE); // cancel selection
      await reviewPromise;

      // Session 2: reopen and verify the edited critic model persisted
      const ctx2 = makeMockCtx();
      const reviewPromise2 = pi.runCommand("critical-review", "", ctx2);
      await waitFor(() => ctx2.ui.hasActiveCustom(), {
        what: "reviewer selection to reopen",
      });

      const lines = ctx2.ui.renderActive(200).map(stripAnsi).join("\n");
      expect(
        lines,
        "Critic 1 should show the edited model from the previous session",
      ).toMatch(/critic 1[\s\S]*model:.*openai\/gpt/i);

      ctx2.ui.fireInput(ESCAPE);
      await reviewPromise2;
    });

    it("auto-creates config with defaults for new reviewers", async () => {
      const reviewersDir = join(tmpDir, "config-test-rev");
      writeTestReviewer(reviewersDir, { name: "fresh-reviewer" });
      const configPath = join(tmpDir, "auto-config.json");

      const { pi } = setupExtension({ reviewersDir, configPath });
      const ctx = makeMockCtx();

      const reviewPromise = pi.runCommand("critical-review", "", ctx);

      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      // Config should have been created with the latest claude opus model.
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(
        config["fresh-reviewer"],
        "Config should default a new reviewer to the latest claude opus model",
      ).toEqual({
        model: "anthropic/claude-opus-4-6",
        reasoning: "off",
      });

      ctx.ui.fireInput(ESCAPE);
      await reviewPromise;
    });

    it("shows model from config in selection UI", async () => {
      const reviewersDir = join(tmpDir, "model-display-rev");
      writeTestReviewer(reviewersDir, { name: "my-reviewer" });
      const configPath = join(tmpDir, "model-display-config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          "my-reviewer": { model: "claude-opus-4-6", reasoning: "high" },
        }),
      );

      const { pi } = setupExtension({ reviewersDir, configPath });
      const ctx = makeMockCtx();

      const reviewPromise = pi.runCommand("critical-review", "", ctx);

      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      const rendered = ctx.ui.renderActive(200).map(stripAnsi);
      const lines = rendered.join("\n");
      // Model and reasoning appear on their own indented line, not in
      // parentheses after the description.
      expect(lines, "Should show model from config").toContain(
        "model: claude-opus-4-6",
      );
      expect(lines, "Should show reasoning from config").toContain(
        "reasoning: high",
      );
      expect(
        lines,
        "Model should not be shown in parentheses on the reviewer line",
      ).not.toContain("(claude-opus-4-6");

      ctx.ui.fireInput(ESCAPE);
      await reviewPromise;
    });

    it("allows editing model via 'm' key and saves to config", async () => {
      const reviewersDir = join(tmpDir, "edit-model-rev");
      writeTestReviewer(reviewersDir, { name: "editable" });
      const configPath = join(tmpDir, "edit-model-config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          editable: { model: "claude-sonnet-4-5", reasoning: "off" },
        }),
      );

      const { pi } = setupExtension({ reviewersDir, configPath });
      const ctx = makeMockCtx();

      const reviewPromise = pi.runCommand("critical-review", "", ctx);

      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      // Press 'm' to edit model
      ctx.ui.fireInput("m");
      let lines = ctx.ui.renderActive(200).map(stripAnsi).join("\n");
      expect(lines, "Should show model editing prompt").toContain(
        "Model for editable",
      );

      // The edit buffer starts pre-filled with the current model value
      for (let i = 0; i < "anthropic/claude-sonnet-4-5".length; i++) {
        ctx.ui.fireInput(BACKSPACE);
      }
      ctx.ui.fireInput("g");
      ctx.ui.fireInput("p");
      ctx.ui.fireInput("t");

      // Should show fuzzy matches
      lines = ctx.ui.renderActive(200).map(stripAnsi).join("\n");
      expect(lines, "Should show fuzzy matches for gpt").toContain(
        "openai/gpt-5.4",
      );

      // Tab to accept top match
      ctx.ui.fireInput(TAB);
      // Enter to confirm
      ctx.ui.fireInput(ENTER);

      // Config should be updated
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(
        config.editable.model,
        "Config should be updated with new model",
      ).toBe("openai/gpt-5.4");

      ctx.ui.fireInput(ESCAPE);
      await reviewPromise;
    });

    it("supports cursor movement in the model field (ctrl+a to line start)", async () => {
      const reviewersDir = join(tmpDir, "cursor-rev");
      writeTestReviewer(reviewersDir, { name: "editable" });
      const configPath = join(tmpDir, "cursor-config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          editable: { model: "claude-opus-4-6", reasoning: "off" },
        }),
      );

      const { pi } = setupExtension({ reviewersDir, configPath });
      const ctx = makeMockCtx();

      const reviewPromise = pi.runCommand("critical-review", "", ctx);
      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      ctx.ui.fireInput("m");
      // Cursor starts at the end of the pre-filled model value. Ctrl+A moves it
      // to the line start so the typed prefix lands before, not after, it.
      ctx.ui.fireInput(CTRL_A);
      ctx.ui.fireInput("x");
      ctx.ui.fireInput(ENTER);

      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(
        config.editable.model,
        "Typed char should be inserted at the cursor's new (start) position",
      ).toBe("xclaude-opus-4-6");

      ctx.ui.fireInput(ESCAPE);
      await reviewPromise;
    });

    it("moves a caret through autocomplete suggestions and accepts the highlighted one", async () => {
      const reviewersDir = join(tmpDir, "caret-rev");
      writeTestReviewer(reviewersDir, { name: "editable" });
      const configPath = join(tmpDir, "caret-config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          editable: { model: "claude-opus-4-6", reasoning: "off" },
        }),
      );

      const { pi } = setupExtension({ reviewersDir, configPath });
      const ctx = makeMockCtx();

      const reviewPromise = pi.runCommand("critical-review", "", ctx);
      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      ctx.ui.fireInput("m");
      // Clear the pre-filled value, then type a prefix matching several models.
      for (let i = 0; i < "anthropic/claude-opus-4-6".length; i++) {
        ctx.ui.fireInput(BACKSPACE);
      }
      for (const ch of "claude") ctx.ui.fireInput(ch);

      // Suggestion lines render with a caret "→ " on the highlighted entry and
      // an aligned blank prefix on the rest. Both exclude the reviewer row
      // (which begins with "[✓]").
      const suggestionLines = (): string[] =>
        ctx.ui
          .renderActive(200)
          .map(stripAnsi)
          .map((l) => l.trim())
          .filter((l) => /^(→ )?\S*claude-/.test(l));
      const caretIndex = (): number =>
        suggestionLines().findIndex((l) => l.startsWith("→ "));

      const initial = suggestionLines();
      expect(
        initial.length,
        `Expected multiple claude suggestions, got: ${JSON.stringify(initial)}`,
      ).toBeGreaterThanOrEqual(3);
      expect(caretIndex(), "Caret should start on the first suggestion").toBe(
        0,
      );

      ctx.ui.fireInput(ARROW_DOWN);
      expect(
        caretIndex(),
        "Caret should move down to the second suggestion",
      ).toBe(1);

      ctx.ui.fireInput(ARROW_UP);
      expect(caretIndex(), "Caret should move back up to the first").toBe(0);

      // Move to the second suggestion and accept it; the editor should fill
      // with whatever value the caret is pointing at.
      ctx.ui.fireInput(ARROW_DOWN);
      const expected = suggestionLines()[1].replace(/^→ /, "");
      ctx.ui.fireInput(TAB);
      ctx.ui.fireInput(ENTER);

      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(
        config.editable.model,
        "Accepting the highlighted suggestion should save that value",
      ).toBe(expected);

      ctx.ui.fireInput(ESCAPE);
      await reviewPromise;
    });

    it("opens an inline prompt editor with the 'e' key showing the current prompt text", async () => {
      const reviewersDir = join(tmpDir, "prompt-edit-rev");
      writeTestReviewer(reviewersDir, {
        name: "editable",
        prompt: "Original reviewer instructions.",
      });

      const { pi } = setupExtension({ reviewersDir });
      const ctx = makeMockCtx();

      const reviewPromise = pi.runCommand("critical-review", "", ctx);
      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      ctx.ui.fireInput("e");
      const lines = ctx.ui.renderActive(200).map(stripAnsi).join("\n");
      expect(lines, "Should show the full prompt text in the editor").toContain(
        "Original reviewer instructions.",
      );

      ctx.ui.fireInput(ESCAPE); // leave prompt editor
      ctx.ui.fireInput(ESCAPE); // cancel selection
      await reviewPromise;
    });

    it("enter does nothing while editing a prompt (does not start the review)", async () => {
      const reviewersDir = join(tmpDir, "prompt-enter-rev");
      writeTestReviewer(reviewersDir, {
        name: "editable",
        prompt: "Original reviewer instructions.",
      });

      const { pi } = setupExtension({ reviewersDir });
      // A spawner with an empty queue: any spawn (i.e. a review starting) would
      // throw "Unexpected spawn", so a silently-started review is detectable.
      makeSpawnController();
      const ctx = makeMockCtx();

      const reviewPromise = pi.runCommand("critical-review", "", ctx);
      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      ctx.ui.fireInput("e");
      ctx.ui.fireInput(ENTER);

      expect(
        ctx.ui.hasActiveCustom(),
        "Enter should not close the editor or start the review",
      ).toBe(true);
      const lines = ctx.ui.renderActive(200).map(stripAnsi).join("\n");
      // The reviewer's prompt body only renders inside the editor, so its
      // presence confirms we are still in the editor (not back at the list).
      expect(
        lines,
        "Should still be in the prompt editor after Enter",
      ).toContain("Original reviewer instructions.");

      ctx.ui.fireInput(ESCAPE); // leave prompt editor
      ctx.ui.fireInput(ESCAPE); // cancel selection
      await reviewPromise;
    });

    it("uses the in-memory edited prompt for the review without writing to disk", async () => {
      const reviewersDir = join(tmpDir, "mem-prompt-rev");
      writeTestReviewer(reviewersDir, {
        name: "editable",
        prompt: "Original instructions.",
      });
      const filePath = join(reviewersDir, "editable.md");

      const { pi } = setupExtension({ reviewersDir });
      const spawner = makeSpawnController();
      enqueuePRContext(spawner);
      enqueueReviewerAgent(spawner, "No issues found.");

      const ctx = makeMockCtx();
      const reviewPromise = pi.runCommand("critical-review", "", ctx);
      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      ctx.ui.fireInput("e");
      // Append distinctive text to the existing prompt (cursor starts at end).
      for (const ch of " EXTRA") ctx.ui.fireInput(ch);
      ctx.ui.fireInput(ESCAPE); // keep in memory, do not write to disk

      // Start the review.
      ctx.ui.fireInput(ENTER);

      await waitFor(() => spawner.held.length > 0, {
        what: "reviewer agent to spawn",
        timeoutMs: 2000,
      });
      expect(
        spawner.held[0].command,
        "Review should use the edited (in-memory) prompt",
      ).toContain("Original instructions. EXTRA");

      expect(
        readFileSync(filePath, "utf-8"),
        "The reviewer file on disk should be unchanged",
      ).not.toContain("EXTRA");

      spawner.held[0].complete();
      await waitFor(() => pi.sentMessages.length > 0, {
        what: "review results to be sent",
        timeoutMs: 3000,
      });
      await reviewPromise;
    });

    it("saves the edited prompt to disk when pressing 'S'", async () => {
      const reviewersDir = join(tmpDir, "save-prompt-rev");
      writeTestReviewer(reviewersDir, {
        name: "editable",
        prompt: "Original instructions.",
      });
      const filePath = join(reviewersDir, "editable.md");

      const { pi } = setupExtension({ reviewersDir });
      const ctx = makeMockCtx();

      const reviewPromise = pi.runCommand("critical-review", "", ctx);
      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      ctx.ui.fireInput("e");
      // A capital S is now ordinary text (save is ^S), so it must be typed.
      for (const ch of " SCREEN") ctx.ui.fireInput(ch);
      ctx.ui.fireInput(CTRL_S); // ^S: save to disk

      expect(
        readFileSync(filePath, "utf-8"),
        "The reviewer file on disk should contain the edited prompt",
      ).toContain("Original instructions. SCREEN");

      // The saved prompt should still load correctly (frontmatter intact).
      const reviewers = loadReviewers(reviewersDir);
      expect(reviewers[0].systemPrompt).toBe("Original instructions. SCREEN");
      expect(reviewers[0].name).toBe("editable");

      ctx.ui.fireInput(ESCAPE); // cancel selection
      await reviewPromise;
    });

    it("adds a new reviewer with the 'n' key and opens its prompt editor", async () => {
      const reviewersDir = join(tmpDir, "addnew-rev");
      writeTestReviewer(reviewersDir, { name: "editable" });

      const { pi } = setupExtension({ reviewersDir });
      const ctx = makeMockCtx();

      const reviewPromise = pi.runCommand("critical-review", "", ctx);
      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      ctx.ui.fireInput("n");
      expect(
        ctx.ui.renderActive(200).map(stripAnsi).join("\n"),
        "Should show the new-reviewer name prompt",
      ).toContain("New reviewer name");

      for (const ch of "my-new-reviewer") ctx.ui.fireInput(ch);
      ctx.ui.fireInput(ENTER);

      // Typed text only echoes inside the prompt editor, so its presence
      // confirms the editor opened for the freshly created reviewer.
      for (const ch of "Draft prompt body.") ctx.ui.fireInput(ch);
      const lines = ctx.ui.renderActive(200).map(stripAnsi).join("\n");
      expect(
        lines,
        "Typed prompt text should render in the new reviewer's editor",
      ).toContain("Draft prompt body.");
      expect(lines, "The new reviewer name should be shown").toContain(
        "my-new-reviewer",
      );

      ctx.ui.fireInput(ESCAPE); // leave prompt editor
      ctx.ui.fireInput(ESCAPE); // cancel selection
      await reviewPromise;
    });

    it("rejects an invalid new reviewer name", async () => {
      const reviewersDir = join(tmpDir, "badname-rev");
      writeTestReviewer(reviewersDir, { name: "editable" });

      const { pi } = setupExtension({ reviewersDir });
      const ctx = makeMockCtx();

      const reviewPromise = pi.runCommand("critical-review", "", ctx);
      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      ctx.ui.fireInput("n");
      for (const ch of "bad!name") ctx.ui.fireInput(ch);
      ctx.ui.fireInput(ENTER);

      const lines = ctx.ui.renderActive(200).map(stripAnsi).join("\n");
      expect(
        lines,
        "Should show a validation error and stay in the name prompt",
      ).toContain("New reviewer name");
      expect(lines, "Should explain the allowed characters").toMatch(
        /letters|a-zA-Z|allowed/i,
      );

      ctx.ui.fireInput(ESCAPE); // cancel name prompt
      ctx.ui.fireInput(ESCAPE); // cancel selection
      await reviewPromise;
    });

    it("rejects a duplicate new reviewer name", async () => {
      const reviewersDir = join(tmpDir, "dupname-rev");
      writeTestReviewer(reviewersDir, { name: "editable" });

      const { pi } = setupExtension({ reviewersDir });
      const ctx = makeMockCtx();

      const reviewPromise = pi.runCommand("critical-review", "", ctx);
      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      ctx.ui.fireInput("n");
      for (const ch of "editable") ctx.ui.fireInput(ch);
      ctx.ui.fireInput(ENTER);

      const lines = ctx.ui.renderActive(200).map(stripAnsi).join("\n");
      expect(
        lines,
        "Should stay in the name prompt for a duplicate name",
      ).toContain("New reviewer name");
      expect(lines, "Should report the name already exists").toMatch(
        /already exists/i,
      );

      ctx.ui.fireInput(ESCAPE); // cancel name prompt
      ctx.ui.fireInput(ESCAPE); // cancel selection
      await reviewPromise;
    });

    it("saves a new reviewer to the user reviewers dir on 'S'", async () => {
      const reviewersDir = join(tmpDir, "savenew-bundled");
      writeTestReviewer(reviewersDir, { name: "editable" });
      const userReviewersDir = join(tmpDir, "savenew-user");

      const { pi } = setupExtension({ reviewersDir, userReviewersDir });
      const ctx = makeMockCtx();

      const reviewPromise = pi.runCommand("critical-review", "", ctx);
      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      ctx.ui.fireInput("n");
      for (const ch of "custom-rev") ctx.ui.fireInput(ch);
      ctx.ui.fireInput(ENTER);
      for (const ch of "Look for custom issues.") ctx.ui.fireInput(ch);
      ctx.ui.fireInput(CTRL_S); // ^S: save permanently

      const savedPath = join(userReviewersDir, "custom-rev.md");
      expect(
        existsSync(savedPath),
        "The new reviewer file should exist in the user reviewers dir",
      ).toBe(true);

      const saved = loadReviewers(userReviewersDir);
      expect(saved).toHaveLength(1);
      expect(saved[0].name).toBe("custom-rev");
      expect(saved[0].systemPrompt).toBe("Look for custom issues.");
      // Verify the full serialized frontmatter round-trips, not just the prompt.
      expect(
        saved[0].description,
        "Saved reviewer should serialize the default description",
      ).toBe("Custom reviewer");
      expect(
        saved[0].tools,
        "Saved reviewer should serialize the default tool list",
      ).toEqual(["read", "grep", "find", "ls", "bash"]);
      expect(
        saved[0].canEditCode,
        "Saved reviewer should serialize can_edit_code: false",
      ).toBe(false);

      ctx.ui.fireInput(ESCAPE); // cancel selection
      await reviewPromise;
    });

    it("keeps a new reviewer in memory and uses it for the review without saving", async () => {
      const reviewersDir = join(tmpDir, "memnew-bundled");
      writeTestReviewer(reviewersDir, { name: "editable" });
      const userReviewersDir = join(tmpDir, "memnew-user");

      const { pi } = setupExtension({ reviewersDir, userReviewersDir });
      const spawner = makeSpawnController();
      enqueuePRContext(spawner);
      enqueueReviewerAgent(spawner, "No issues found."); // editable
      enqueueReviewerAgent(spawner, "No issues found."); // mem-rev

      const ctx = makeMockCtx();
      const reviewPromise = pi.runCommand("critical-review", "", ctx);
      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      ctx.ui.fireInput("n");
      for (const ch of "mem-rev") ctx.ui.fireInput(ch);
      ctx.ui.fireInput(ENTER);
      for (const ch of "Mem reviewer instructions.") ctx.ui.fireInput(ch);
      ctx.ui.fireInput(ESCAPE); // keep in memory only

      ctx.ui.fireInput(ENTER); // start review

      await waitFor(() => spawner.held.length >= 2, {
        what: "both reviewer agents to spawn",
        timeoutMs: 2000,
      });
      const commands = spawner.held.map((h) => h.command).join("\n");
      expect(
        commands,
        "The in-memory new reviewer's prompt should be used in the review",
      ).toContain("Mem reviewer instructions.");

      expect(
        existsSync(join(userReviewersDir, "mem-rev.md")),
        "The new reviewer should not have been written to disk",
      ).toBe(false);

      for (const held of [...spawner.held]) held.complete();
      await waitFor(() => pi.sentMessages.length > 0, {
        what: "review results to be sent",
        timeoutMs: 3000,
      });
      await reviewPromise;
    });

    it("skips selection UI and uses all reviewers when hasUI is false", async () => {
      const { pi } = setupExtension({ withReviewer: true });
      const spawner = makeSpawnController();
      const ctx = makeMockCtx({ hasUI: false });

      enqueuePRContext(spawner);
      enqueueReviewerAgent(spawner, "No issues found.");

      const reviewPromise = pi.runCommand("critical-review", "", ctx);

      // Without a UI, the review starts directly instead of opening selection.
      await waitFor(() => spawner.held.length > 0, {
        what: "reviewer process to start without selection UI",
        timeoutMs: 2000,
      });
      expect(
        ctx.ui.hasActiveCustom(),
        "Should not open selection UI without hasUI",
      ).toBe(false);
      spawner.held[0].complete();

      await waitFor(() => pi.sentMessages.length > 0, {
        what: "review results to be sent",
        timeoutMs: 3000,
      });

      await reviewPromise;
    });

    it("starts review when pressing enter on reviewer selection", async () => {
      const { pi } = setupExtension({ withReviewer: true });
      const spawner = makeSpawnController();
      const ctx = makeMockCtx();

      enqueuePRContext(spawner);
      enqueueReviewerAgent(
        spawner,
        "ISSUE:\nfile: src/foo.ts\nline: 42\nseverity: high\ntitle: Bug found\ndescription: There is a bug\nEND_ISSUE",
      );
      // One critic per DEFAULT_CRITICS entry, majority must approve
      enqueueAllCritics(spawner, "APPROVE", "This is a real bug.");

      void pi.runCommand("critical-review", "", ctx);

      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });

      // Press enter to start the review with all reviewers selected
      ctx.ui.fireInput(ENTER);

      // Wait for the selection to close and review to start
      await waitFor(() => !ctx.ui.hasActiveCustom(), {
        what: "selection to close",
      });

      // The review runs in background. Complete the held processes.
      await waitFor(() => spawner.held.length > 0, {
        what: "reviewer process to start",
      });

      // Complete the reviewer
      spawner.held[0].complete();

      // Complete all critic agents (spawned in parallel)
      await waitFor(() => spawner.held.length >= DEFAULT_CRITICS.length, {
        what: `${DEFAULT_CRITICS.length} critic processes to start`,
        timeoutMs: 2000,
      });
      for (const held of [...spawner.held]) {
        held.complete();
      }

      // The review should eventually finish and send results
      await waitFor(() => pi.sentMessages.length > 0, {
        what: "review results to be sent",
        timeoutMs: 3000,
      });

      // Results should contain the issue file path
      const msg = pi.sentMessages[0];
      expect(
        msg.content,
        "Review report should be sent as a string message",
      ).toBeTypeOf("string");
      expect(msg.content as string).toContain("src/foo.ts");
    });

    it("uses LLM to deduplicate similar issues from multiple reviewers", async () => {
      const reviewersDir = join(tmpDir, "multi-reviewers");
      writeTestReviewer(reviewersDir, { name: "reviewer-a" });
      writeTestReviewer(reviewersDir, { name: "reviewer-b" });
      const { pi } = setupExtension({ reviewersDir });
      const spawner = makeSpawnController();
      const ctx = makeMockCtx();

      enqueuePRContext(spawner);
      // Reviewer A finds one issue
      enqueueReviewerAgent(
        spawner,
        [
          "ISSUE:",
          "file: src/foo.ts",
          "line: 42",
          "severity: high",
          "title: Null pointer dereference",
          "description: Variable x is used without null check",
          "END_ISSUE",
        ].join("\n"),
      );
      // Reviewer B finds a duplicate issue
      enqueueReviewerAgent(
        spawner,
        [
          "ISSUE:",
          "file: src/foo.ts",
          "line: 43",
          "severity: medium",
          "title: Missing null check on x",
          "description: x could be null here",
          "END_ISSUE",
        ].join("\n"),
      );
      // Dedup agent says keep only issue #1
      enqueueReviewerAgent(spawner, "KEEP: 1");
      // All critics approve the surviving issue
      enqueueAllCritics(spawner, "APPROVE", "Real bug.");

      void pi.runCommand("critical-review", "", ctx);

      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });
      ctx.ui.fireInput(ENTER);
      await waitFor(() => !ctx.ui.hasActiveCustom(), {
        what: "selection to close",
      });

      // Both reviewers run in parallel
      await waitFor(() => spawner.held.length >= 2, {
        what: "both reviewer processes to start",
        timeoutMs: 2000,
      });
      spawner.held[0].complete();
      spawner.held[0].complete();

      // Dedup agent
      await waitFor(() => spawner.held.length > 0, {
        what: "dedup agent to start",
        timeoutMs: 2000,
      });
      spawner.held[0].complete();

      // All critics evaluate the 1 surviving issue in parallel
      await waitFor(() => spawner.held.length >= DEFAULT_CRITICS.length, {
        what: `${DEFAULT_CRITICS.length} critic processes to start`,
        timeoutMs: 2000,
      });
      for (const held of [...spawner.held]) {
        held.complete();
      }

      await waitFor(() => pi.sentMessages.length > 0, {
        what: "review results to be sent",
        timeoutMs: 3000,
      });

      const msg = pi.sentMessages[0];
      expect(
        msg.content,
        "Review report should be sent as a string message",
      ).toBeTypeOf("string");
      const content = msg.content as string;
      expect(content, "Should contain the kept issue").toContain(
        "Null pointer dereference",
      );
      // The deduped issue should NOT appear
      expect(content, "Should not contain the removed duplicate").not.toContain(
        "Missing null check on x",
      );
    });

    it("runs parallel reviewers first, then sequential (can_edit_code) reviewers", async () => {
      const reviewersDir = join(tmpDir, "ordering-reviewers");
      writeTestReviewer(reviewersDir, {
        name: "parallel-a",
        canEditCode: false,
      });
      writeTestReviewer(reviewersDir, {
        name: "parallel-b",
        canEditCode: false,
      });
      writeTestReviewer(reviewersDir, {
        name: "sequential-c",
        canEditCode: true,
      });
      writeTestReviewer(reviewersDir, {
        name: "sequential-d",
        canEditCode: true,
      });
      const { pi } = setupExtension({ reviewersDir });
      const spawner = makeSpawnController();
      const ctx = makeMockCtx();

      enqueuePRContext(spawner);
      // 2 parallel + 2 sequential = 4 reviewer agents
      enqueueReviewerAgent(spawner, "No issues found.");
      enqueueReviewerAgent(spawner, "No issues found.");
      enqueueReviewerAgent(spawner, "No issues found.");
      enqueueReviewerAgent(spawner, "No issues found.");

      void pi.runCommand("critical-review", "", ctx);

      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });
      ctx.ui.fireInput(ENTER);
      await waitFor(() => !ctx.ui.hasActiveCustom(), {
        what: "selection to close",
      });

      // Parallel reviewers (parallel-a, parallel-b) should start together
      await waitFor(() => spawner.held.length >= 2, {
        what: "both parallel reviewers to start",
        timeoutMs: 2000,
      });
      expect(
        spawner.held.length,
        "Only parallel reviewers should be running before sequential ones",
      ).toBe(2);
      spawner.held[0].complete();
      spawner.held[0].complete();

      // After parallel reviewers complete, sequential ones run one at a time
      await waitFor(() => spawner.held.length >= 1, {
        what: "first sequential reviewer to start",
        timeoutMs: 2000,
      });
      expect(
        spawner.held.length,
        "Sequential reviewers should run one at a time",
      ).toBe(1);
      spawner.held[0].complete();

      await waitFor(() => spawner.held.length >= 1, {
        what: "second sequential reviewer to start",
        timeoutMs: 2000,
      });
      expect(
        spawner.held.length,
        "Second sequential reviewer should run alone",
      ).toBe(1);
      spawner.held[0].complete();

      await waitFor(() => pi.sentMessages.length > 0, {
        what: "review results to be sent",
        timeoutMs: 3000,
      });
    });

    it("salvages issues with missing non-critical fields", async () => {
      const { pi } = setupExtension({ withReviewer: true });
      const spawner = makeSpawnController();
      const ctx = makeMockCtx();

      enqueuePRContext(spawner);
      // Reviewer returns a block missing description — should be salvaged
      enqueueReviewerAgent(
        spawner,
        "ISSUE:\nfile: src/foo.ts\ntitle: Bug found\nEND_ISSUE",
      );
      enqueueAllCritics(spawner, "APPROVE", "Real bug.");

      void pi.runCommand("critical-review", "", ctx);

      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });
      ctx.ui.fireInput(ENTER);
      await waitFor(() => !ctx.ui.hasActiveCustom(), {
        what: "selection to close",
      });

      // Reviewer
      await waitFor(() => spawner.held.length > 0, {
        what: "reviewer process to start",
      });
      spawner.held[0].complete();

      // All critics
      await waitFor(() => spawner.held.length >= DEFAULT_CRITICS.length, {
        what: `${DEFAULT_CRITICS.length} critic processes to start`,
        timeoutMs: 2000,
      });
      for (const held of [...spawner.held]) {
        held.complete();
      }

      await waitFor(() => pi.sentMessages.length > 0, {
        what: "review results to be sent",
        timeoutMs: 3000,
      });

      const msg = pi.sentMessages[0];
      expect(
        msg.content,
        "Review report should be sent as a string message",
      ).toBeTypeOf("string");
      expect(
        msg.content as string,
        "Salvaged issue should appear in results",
      ).toContain("Bug found");
    });

    it("adds edit and write tools for can_edit_code reviewers", async () => {
      const reviewersDir = join(tmpDir, "edit-tools-rev");
      writeTestReviewer(reviewersDir, {
        name: "editor",
        tools: "read, grep",
        canEditCode: true,
      });

      const { pi } = setupExtension({ reviewersDir });
      const spawner = makeSpawnController();
      const ctx = makeMockCtx();

      enqueuePRContext(spawner);
      enqueueReviewerAgent(spawner, "No issues found.");

      void pi.runCommand("critical-review", "", ctx);

      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });
      ctx.ui.fireInput(ENTER);
      await waitFor(() => !ctx.ui.hasActiveCustom(), {
        what: "selection to close",
      });

      await waitFor(() => spawner.held.length > 0, {
        what: "reviewer process to start",
      });

      const spawnCalls = childProcessMock.spawn.mock.calls;
      // The 3rd call is the reviewer (after gh and git diff)
      const reviewerArgs = spawnCalls[2][1] as string[];
      const toolsIdx = reviewerArgs.indexOf("--tools");
      expect(
        toolsIdx,
        `Expected --tools in args: ${reviewerArgs.join(" ")}`,
      ).toBeGreaterThanOrEqual(0);
      const toolsValue = reviewerArgs[toolsIdx + 1];
      expect(toolsValue, `Expected edit in tools: ${toolsValue}`).toContain(
        "edit",
      );
      expect(toolsValue, `Expected write in tools: ${toolsValue}`).toContain(
        "write",
      );

      spawner.held[0].complete();

      await waitFor(() => pi.sentMessages.length > 0, {
        what: "review results to be sent",
        timeoutMs: 3000,
      });
    });

    it("passes --thinking flag when reviewer has reasoning set", async () => {
      const reviewersDir = join(tmpDir, "reasoning-rev");
      writeTestReviewer(reviewersDir, { name: "thinker" });
      const configPath = join(tmpDir, "reasoning-config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          thinker: { model: "claude-opus-4-6", reasoning: "high" },
        }),
      );

      const { pi } = setupExtension({ reviewersDir, configPath });
      const spawner = makeSpawnController();
      const ctx = makeMockCtx();

      enqueuePRContext(spawner);
      enqueueReviewerAgent(spawner, "No issues found.");

      void pi.runCommand("critical-review", "", ctx);

      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });
      ctx.ui.fireInput(ENTER);
      await waitFor(() => !ctx.ui.hasActiveCustom(), {
        what: "selection to close",
      });

      await waitFor(() => spawner.held.length > 0, {
        what: "reviewer process to start",
      });

      const spawnCalls = childProcessMock.spawn.mock.calls;
      // The 3rd call is the reviewer (after gh and git diff)
      const reviewerArgs = spawnCalls[2][1] as string[];
      const thinkingIdx = reviewerArgs.indexOf("--thinking");
      expect(
        thinkingIdx,
        `Expected --thinking in args: ${reviewerArgs.join(" ")}`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        reviewerArgs[thinkingIdx + 1],
        `Expected "high" after --thinking in args: ${reviewerArgs.join(" ")}`,
      ).toBe("high");

      spawner.held[0].complete();

      await waitFor(() => pi.sentMessages.length > 0, {
        what: "review results to be sent",
        timeoutMs: 3000,
      });
    });
  });

  describe("fix-loop flow", () => {
    it("reports cumulative cost across all iterations", async () => {
      const { pi } = setupExtension({ withReviewer: true });
      const spawner = makeSpawnController();
      const ctx = makeMockCtx();

      // Iteration 1: finds an issue
      enqueuePRContext(spawner);
      enqueueReviewerAgent(
        spawner,
        "ISSUE:\nfile: src/foo.ts\nline: 42\nseverity: high\ntitle: Bug found\ndescription: There is a bug\nEND_ISSUE",
        { usage: { input: 1000, output: 500 } },
      );
      for (let i = 0; i < DEFAULT_CRITICS.length; i++) {
        enqueueCriticAgent(spawner, "APPROVE", "Real bug.", {
          usage: { input: 200, output: 100 },
        });
      }

      // Iteration 2: no issues (clean)
      enqueuePRContext(spawner);
      enqueueReviewerAgent(spawner, "No issues found.", {
        usage: { input: 800, output: 400 },
      });

      void pi.runCommand("critical-review", "-fix-loop", ctx);

      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });
      ctx.ui.fireInput(ENTER);
      await waitFor(() => !ctx.ui.hasActiveCustom(), {
        what: "selection to close",
      });

      // Iteration 1: reviewer
      await waitFor(() => spawner.held.length > 0, {
        what: "reviewer process to start",
      });
      spawner.held[0].complete();

      // Iteration 1: critics
      await waitFor(() => spawner.held.length >= DEFAULT_CRITICS.length, {
        what: `${DEFAULT_CRITICS.length} critic processes to start`,
        timeoutMs: 2000,
      });
      for (const held of [...spawner.held]) {
        held.complete();
      }

      // Wait for iteration 1 report
      await waitFor(() => pi.sentMessages.length >= 1, {
        what: "iteration 1 results",
        timeoutMs: 3000,
      });

      // waitForIdle resolves immediately in mock
      // Iteration 2: reviewer
      await waitFor(() => spawner.held.length > 0, {
        what: "iteration 2 reviewer to start",
        timeoutMs: 3000,
      });
      spawner.held[0].complete();

      // Wait for iteration 2 (clean) report
      await waitFor(() => pi.sentMessages.length >= 2, {
        what: "iteration 2 results",
        timeoutMs: 3000,
      });

      // The final message should contain cumulative tokens from both iterations.
      // Iteration 1: 1000 input (reviewer) + 200*3 input (critics) = 1600
      // Iteration 2: 800 input (reviewer) = 800
      // Total input: 2400
      const lastMsg = pi.sentMessages[pi.sentMessages.length - 1];
      const content = lastMsg.content as string;
      expect(
        content,
        "Final report should include cumulative token count from all iterations",
      ).toContain("2.4k");
    });

    it("reports an error if the fix loop fails while waiting for the agent", async () => {
      const { pi } = setupExtension({ withReviewer: true });
      const spawner = makeSpawnController();
      const ctx = makeMockCtx();
      // Force waitForIdle to block so the test can make it reject.
      ctx.exitIdleState();

      // Iteration 1 finds an approved issue, so the loop proceeds to waitForIdle.
      enqueuePRContext(spawner);
      enqueueReviewerAgent(
        spawner,
        "ISSUE:\nfile: src/foo.ts\nline: 1\nseverity: high\ntitle: Bug\ndescription: bug\nEND_ISSUE",
      );
      enqueueAllCritics(spawner, "APPROVE", "Real bug.");

      void pi.runCommand("critical-review", "-fix-loop", ctx);

      await waitFor(() => ctx.ui.hasActiveCustom(), {
        what: "reviewer selection to open",
      });
      ctx.ui.fireInput(ENTER);
      await waitFor(() => !ctx.ui.hasActiveCustom(), {
        what: "selection to close",
      });

      await waitFor(() => spawner.held.length > 0, {
        what: "reviewer process to start",
      });
      spawner.held[0].complete();
      await waitFor(() => spawner.held.length >= DEFAULT_CRITICS.length, {
        what: `${DEFAULT_CRITICS.length} critic processes to start`,
        timeoutMs: 2000,
      });
      for (const held of [...spawner.held]) {
        held.complete();
      }

      await waitFor(() => pi.sentMessages.length >= 1, {
        what: "iteration 1 report",
        timeoutMs: 3000,
      });

      // The loop is now awaiting the agent; make that wait reject.
      await waitFor(() => ctx.pendingIdleWaiters() > 0, {
        what: "fix-loop to await the agent becoming idle",
        timeoutMs: 3000,
      });
      ctx.rejectIdleWaiters(new Error("agent crashed"));

      await waitFor(
        () =>
          ctx.ui.notifications.some(
            (n) => n.level === "error" && /fix-loop/i.test(n.msg),
          ),
        {
          what: "fix-loop failure to be reported to the user",
          timeoutMs: 3000,
        },
      );
    });
  });
});
