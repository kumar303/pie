/**
 * Tests for the git extension.
 *
 * Most tests are integration-style: a mock pi object registers the
 * extension's `/git` command and event handlers, and tests drive
 * lifecycle through `pi.runCommand("git", ...)` and user keystrokes
 * through `ctx.ui.fireInput(...)` — exactly the way the real pi runtime
 * does. The extension shells out to real `git` running against per-test
 * tmpdir repositories; the harness creates files, commits, etc. so the
 * extension sees realistic `git status --porcelain` output.
 *
 * Pure transformation helpers (buildFileIndex, remapFileIndex,
 * buildChunkIndex, remapChunkIndex, initialDiffScrollOffset, plus the
 * delta probes) are kept as direct unit tests at the bottom of the
 * file: their inputs/outputs have no observable behavior through the pi
 * UI surface beyond what an integration test would assert (a scroll
 * offset). Forcing them through the full pipeline strictly loses signal.
 *
 * `FilePathAutocompleteProvider` is also kept direct: its public API
 * returns suggestion data structures that are consumed by an internal
 * pi-tui Editor overlay; the autocomplete dropdown is not part of the
 * component's `render(width)` output, so pi-level observability is
 * limited.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ────────────────────────────────────────────────────────────────────
// Mock `node:child_process` so any `delta` invocation (the syntax-
// highlighting tool the extension shells out to) is intercepted and
// fails. Without this mock, tests would behave differently depending
// on whether the developer has `delta` on their PATH — a real source of
// flakiness. Real `git` calls pass through unchanged.
//
// `vi.mock` is hoisted above all imports, so the mock is active before
// `index.ts` ever calls `execSync`, which means the cached
// `isDeltaAvailable()` value is set from the mock rather than the
// real shell on first use.
// ────────────────────────────────────────────────────────────────────

/**
 * Tests that need fine-grained control over what happens when the
 * extension shells out to `delta` can override `deltaMock.handler`.
 * `vi.hoisted` is required because the `vi.mock` factory below is
 * hoisted above all imports, so any helper it captures must also be
 * hoisted to be in scope at that point.
 *
 * Default (`handler === undefined`): any `delta`-shaped command throws
 * an ENOENT-like error — i.e. delta is not on PATH. This is the safe
 * baseline for tests that just want delta off and don't care how it
 * fails. Tests that *do* care must set `deltaMock.handler` explicitly.
 */
const deltaMock = vi.hoisted(() => ({
  handler: undefined as
    | undefined
    | ((command: string) => string | { error: Error & { stderr?: string } }),
}));

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  const isDeltaCommand = (cmd: string): boolean => {
    const t = cmd.trimStart();
    return t === "which delta" || t === "delta" || t.startsWith("delta ");
  };
  const execSync = ((command: unknown, options?: unknown) => {
    if (typeof command === "string" && isDeltaCommand(command)) {
      if (deltaMock.handler) {
        const result = deltaMock.handler(command);
        if (typeof result === "string") return result;
        throw result.error;
      }
      // Default: delta unavailable.
      const err = new Error(`mocked: refusing to run '${command}'`) as Error & {
        stderr: string;
      };
      err.stderr = `mocked: '${command}' not available`;
      throw err;
    }
    return (actual.execSync as (c: unknown, o?: unknown) => unknown)(
      command,
      options,
    );
  }) as typeof actual.execSync;
  return { ...actual, execSync };
});

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import gitExtension, {
  type GitPi,
  buildFileIndex,
  remapFileIndex,
  buildChunkIndex,
  remapChunkIndex,
  initialDiffScrollOffset,
  isDeltaAvailable,
  pipeThroughDelta,
  sanitizeLine,
  generateWorkingDiffOutput,
  FilePathAutocompleteProvider,
} from "./index.js";

// ── Key constants (raw bytes the real terminal would deliver) ───────

const ESC = "\x1b";
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const ENTER = "\r";
const TAB = "\t";
const ESCAPE = ESC;

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Wait until `predicate()` returns true, polling the microtask queue.
 * Throws (with `label`) if the deadline elapses without satisfaction.
 *
 * Use this instead of fixed-tick `await Promise.resolve()` chains when
 * waiting for the extension to settle: pi's command handler may add or
 * remove `await`s upstream over time, and a fixed-tick wait silently
 * breaks. A condition-based wait stays correct as long as the
 * eventual state is reached.
 */
async function waitFor(
  predicate: () => boolean,
  label: string,
  { timeoutMs = 2000 }: { timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: ${label} not satisfied within ${timeoutMs}ms`);
    }
    // Yield through both microtask and macrotask queues so we cover
    // any combination of `await`-chains and `setImmediate` upstream.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Wrap a partial mock implementation so that accessing any property
 * the mock does not implement throws a clear error instead of
 * returning `undefined` (which usually surfaces later as a confusing
 * `TypeError: x is not a function`).
 *
 * This lets us declare the mock object's static type as the full
 * production interface (e.g. `ExtensionCommandContext`) without using
 * `as unknown as T` to silently lie — we still construct a partial
 * impl, but the Proxy makes the lie explicit at access time.
 *
 * Symbol-keyed access (Symbol.toPrimitive, Symbol.iterator, Vitest
 * internals, etc.) passes through untouched so unrelated code paths
 * continue working.
 */
function throwingMock<T extends object>(impl: object, label: string): T {
  return new Proxy(impl as T, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      throw new Error(
        `${label}: property '${String(prop)}' was accessed but the test mock does not implement it. Add it to the mock if the extension needs it.`,
      );
    },
    has(target, prop) {
      return prop in target;
    },
  }) as T;
}

// ── MockPi ──────────────────────────────────────────────────────────

type CommandConfig = Parameters<GitPi["registerCommand"]>[1];
type CommandHandler = CommandConfig["handler"];

interface RegisteredCommand {
  name: string;
  config: CommandConfig;
}

interface SendUserMessageCall {
  content: Parameters<GitPi["sendUserMessage"]>[0];
  options?: Parameters<GitPi["sendUserMessage"]>[1];
}

interface MockPi extends GitPi {
  commands: Map<string, RegisteredCommand>;
  /** Recorded `pi.sendUserMessage` calls, in order. */
  sentMessages: SendUserMessageCall[];
  /** Invoke a registered command's handler. */
  runCommand(
    name: string,
    args: string,
    ctx: MockCtx,
  ): ReturnType<CommandHandler>;
}

function makeMockPi(): MockPi {
  const commands = new Map<string, RegisteredCommand>();
  const sentMessages: SendUserMessageCall[] = [];
  const pi: MockPi = {
    commands,
    sentMessages,
    registerCommand(name, config) {
      commands.set(name, { name, config });
    },
    sendUserMessage: ((
      content: Parameters<GitPi["sendUserMessage"]>[0],
      options?: Parameters<GitPi["sendUserMessage"]>[1],
    ) => {
      sentMessages.push({ content, options });
    }) as GitPi["sendUserMessage"],
    runCommand(name, args, ctx) {
      const cmd = commands.get(name);
      if (!cmd) throw new Error(`Command not registered: ${name}`);
      // `ctx` is typed as the full `ExtensionCommandContext` via
      // `makeMockCtx`'s throwing-proxy wrapper — no cast needed.
      return cmd.config.handler(args, ctx);
    },
  };
  return pi;
}

// ── MockCtx ──────────────────────────────────────────────────────────

/** Custom-component factory signature, derived from the real ui.custom. */
type CustomFactory = Parameters<ExtensionUIContext["custom"]>[0];
type CustomTui = Parameters<CustomFactory>[0];
type CustomTheme = Parameters<CustomFactory>[1];
type CustomKb = Parameters<CustomFactory>[2];
type CustomComponent = Component & {
  handleInput(input: string): void;
  invalidate(): void;
  dispose?(): void;
};

interface MockActiveTui {
  requestRender: ReturnType<typeof vi.fn>;
  setClearOnShrink: ReturnType<typeof vi.fn>;
  terminal: { rows: number; cols: number };
}

/**
 * The set of typed dispatchers the mock pi runtime registers when a
 * custom component mounts. Pi's real runtime keeps a `focusedComponent`
 * reference and routes input/render calls through it (see
 * `pi-tui/tui.d.ts`: `setFocus(component) → focusedComponent.handleInput`).
 *
 * The mock mirrors that: at mount time we capture how to deliver input
 * and how to obtain a render. `fireInput` and `renderActive` go through
 * these dispatchers — they never reach into `.component.handleInput()` or
 * `.component.render()` directly. This makes the test simulate pi's
 * dispatch flow rather than reaching past it into a hook.
 */
interface FocusedDispatch {
  /** Deliver a keystroke to the focused component, the way pi's TUI does. */
  handleInput(data: string): void;
  /** Ask the focused component to render, the way pi's render loop does. */
  render(width: number): string[];
  /** Resolve the `ui.custom()` promise (pi's `done()` callback). */
  done(val: unknown): void;
  /** The promise returned to the extension from `ui.custom()`. */
  promise: Promise<unknown>;
  /** Mock-internal handle to the tui object the factory was given. */
  tui: MockActiveTui;
}

/** Mock-only helpers attached to the proxied `ui` object. */
interface MockUiContextExtras {
  notifications: Array<{ msg: string; level: "info" | "warning" | "error" }>;
  hasActiveCustom(): boolean;
  fireInput(input: string): void;
  renderActive(width?: number): string[];
  exitActive(value?: unknown): void;
}

/**
 * The mocked UI surface is statically typed as the full
 * `ExtensionUIContext` (so misuse fails at compile time) plus a few
 * test-only helpers. At runtime the Proxy throws if the extension
 * reaches for something the test mock has not implemented.
 */
type MockUiContext = ExtensionUIContext & MockUiContextExtras;

/**
 * The mocked command context is statically typed as the full
 * `ExtensionCommandContext` (overriding `ui` with the mock variant).
 * Same Proxy treatment as `MockUiContext`.
 */
type MockCtx = Omit<ExtensionCommandContext, "ui"> & { ui: MockUiContext };

interface MakeCtxOpts {
  cwd?: string;
  hasUI?: boolean;
}

function makeMockCtx(opts: MakeCtxOpts = {}): MockCtx {
  // The currently-focused custom component's dispatchers, or undefined
  // when no `ui.custom()` is active. This mirrors pi-tui's
  // `focusedComponent` reference held inside the TUI runtime.
  let focused: FocusedDispatch | undefined;
  const requireFocused = (): FocusedDispatch => {
    if (!focused) {
      throw new Error(
        "No focused custom component: ui.custom() has not been called or has already resolved.",
      );
    }
    return focused;
  };

  // Partial impl of ExtensionUIContext + MockUiContextExtras. Anything
  // not listed here is rejected by the Proxy below with a clear error.
  const uiImpl: Partial<ExtensionUIContext> & MockUiContextExtras = {
    notifications: [],
    notify(msg, level) {
      uiImpl.notifications.push({ msg, level: level ?? "info" });
    },
    custom: (async (factory: CustomFactory) => {
      // Anything not on tuiImpl is rejected by throwingMock.
      const tuiImpl: MockActiveTui = {
        requestRender: vi.fn(),
        setClearOnShrink: vi.fn(),
        terminal: { rows: 40, cols: 120 },
      };
      const tui = throwingMock<CustomTui>(tuiImpl, "MockTui");

      // Minimal Theme stub — the git component only calls fg/bg/bold.
      const themeImpl = {
        fg: (_color: string, text?: string) => text ?? "",
        bg: (_color: string, text?: string) => text ?? "",
        bold: (text: string) => text,
      };
      const theme = throwingMock<CustomTheme>(themeImpl, "MockTheme");

      // Empty keybindings manager — git doesn't bind any keys this way.
      const kb = throwingMock<CustomKb>({}, "MockKeybindingsManager");

      let resolveDone!: (val: unknown) => void;
      const promise = new Promise<unknown>((res) => {
        resolveDone = res;
      });
      const component = (await factory(tui, theme, kb, ((val: unknown) => {
        resolveDone(val);
        focused = undefined;
      }) as (result: never) => void)) as CustomComponent;

      // Simulate pi's `tui.setFocus(component)`: register the dispatch
      // routes the runtime would use. From here on, `fireInput` and
      // `renderActive` go through these typed handlers — the test
      // helpers never touch `component.*` directly.
      focused = {
        handleInput: (data) => {
          if (!component.handleInput) {
            throw new Error(
              "focused component has no handleInput method (pi would have nothing to deliver input to)",
            );
          }
          component.handleInput(data);
        },
        render: (width) => component.render(width),
        done: (val) => {
          resolveDone(val);
          focused = undefined;
        },
        promise,
        tui: tuiImpl,
      };
      return promise as Promise<never>;
    }) as ExtensionUIContext["custom"],
    hasActiveCustom: () => focused !== undefined,
    fireInput: (input) => requireFocused().handleInput(input),
    renderActive: (width = 80) => requireFocused().render(width),
    exitActive: (value) => requireFocused().done(value),
  };
  const ui = throwingMock<MockUiContext>(uiImpl, "MockUiContext");

  // Partial impl of ExtensionCommandContext. Any other access → throw.
  const ctxImpl: Partial<ExtensionCommandContext> & { ui: MockUiContext } = {
    cwd: opts.cwd ?? process.cwd(),
    hasUI: opts.hasUI ?? true,
    ui,
  };
  return throwingMock<MockCtx>(ctxImpl, "MockCtx");
}

// ── Tmpdir + git repo helpers ───────────────────────────────────────

let tmpDir: string;
let origCwd: string;

function initGitRepo(dir: string): void {
  execSync("git init", { cwd: dir });
  execSync("git config user.email test@test.com", { cwd: dir });
  execSync("git config user.name Test", { cwd: dir });
}

beforeEach(() => {
  origCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "git-ext-"));
  initGitRepo(tmpDir);
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

interface Harness {
  pi: MockPi;
}

function setupExtension(): Harness {
  const pi = makeMockPi();
  // `MockPi extends GitPi`, which is exactly what the default export
  // accepts — no cast needed.
  gitExtension(pi);
  return { pi };
}

/**
 * Run `/git`, wait for the interactive UI to mount, and return a facade
 * for driving keypresses and inspecting rendered output. Uses real git
 * status output from the current tmpdir.
 */
async function openGitUi(
  h: Harness,
  ctxOpts?: MakeCtxOpts,
): Promise<{
  ctx: MockCtx;
  cmdPromise: ReturnType<CommandHandler>;
  hasUi(): boolean;
  render(width?: number): string[];
  renderText(width?: number): string;
  fireInput(input: string): void;
  exit(): void;
}> {
  const ctx = makeMockCtx(ctxOpts);
  const cmdPromise = h.pi.runCommand("git", "", ctx);
  // Wait until the extension has reached the point where it has
  // mounted a custom component (`ui.custom(factory)` resolved into a
  // focused component). This is the observable signal that the UI is
  // ready for keystrokes — robust to any number of internal `await`s
  // pi may add upstream.
  await waitFor(
    () => ctx.ui.hasActiveCustom(),
    "git extension mounted its custom UI component",
  );
  return {
    ctx,
    cmdPromise,
    hasUi: () => ctx.ui.hasActiveCustom(),
    render: (width = 80) => ctx.ui.renderActive(width),
    renderText: (width = 80) =>
      ctx.ui.renderActive(width).map(stripAnsi).join("\n"),
    fireInput: (input) => ctx.ui.fireInput(input),
    exit: () => ctx.ui.exitActive(undefined),
  };
}

// ════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS — driven through `pi.runCommand` and `ctx.ui.*`
// ════════════════════════════════════════════════════════════════════

describe("/git command registration", () => {
  it("registers a 'git' command", () => {
    const h = setupExtension();
    expect(h.pi.commands.has("git")).toBe(true);
  });

  it("notifies an error and does not mount UI when hasUI is false", async () => {
    const h = setupExtension();
    const ctx = makeMockCtx({ hasUI: false });
    await h.pi.runCommand("git", "", ctx);
    expect(ctx.ui.hasActiveCustom()).toBe(false);
    const err = ctx.ui.notifications.find((n) => n.level === "error");
    expect(err?.msg).toMatch(/TUI/);
  });
});

// ── git status parsing → file selector rendering ────────────────────
//
// Replaces the unit tests for the unexported `parseGitStatus` helper.
// The harness creates files in a real git tmpdir and asserts they
// appear in the rendered file selector with the correct status label.

describe("file selector reflects git status output", () => {
  it("shows modified files", async () => {
    writeFileSync(join(tmpDir, "file.txt"), "original");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "file.txt"), "modified");
    const h = setupExtension();
    const ui = await openGitUi(h);
    expect(ui.renderText()).toContain("file.txt");
  });

  it("shows untracked files", async () => {
    // Need at least one tracked file so `git status` doesn't show empty.
    writeFileSync(join(tmpDir, ".gitkeep"), "");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "newfile.txt"), "hello");
    const h = setupExtension();
    const ui = await openGitUi(h);
    expect(ui.renderText()).toContain("newfile.txt");
  });

  it("shows staged files", async () => {
    writeFileSync(join(tmpDir, ".gitkeep"), "");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "staged.txt"), "x");
    execSync("git add staged.txt", { cwd: tmpDir });
    const h = setupExtension();
    const ui = await openGitUi(h);
    expect(ui.renderText()).toContain("staged.txt");
  });

  it("shows the new name for renamed files", async () => {
    writeFileSync(join(tmpDir, "old.txt"), "content");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    execSync("git mv old.txt new.txt", { cwd: tmpDir });
    const h = setupExtension();
    const ui = await openGitUi(h);
    const text = ui.renderText();
    expect(text).toContain("new.txt");
  });

  it("shows multiple files of different statuses simultaneously", async () => {
    writeFileSync(join(tmpDir, "a.txt"), "a");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "a.txt"), "a-modified"); // M
    writeFileSync(join(tmpDir, "b.txt"), "b"); // ??
    writeFileSync(join(tmpDir, "c.txt"), "c");
    execSync("git add c.txt", { cwd: tmpDir }); // A (staged)
    const h = setupExtension();
    const ui = await openGitUi(h);
    const text = ui.renderText();
    expect(text).toContain("a.txt");
    expect(text).toContain("b.txt");
    expect(text).toContain("c.txt");
  });
});

// ── confirm-branch-check phase (no uncommitted changes) ─────────────

describe("confirm-branch-check phase", () => {
  it("shows confirmation prompt when there are no uncommitted changes", async () => {
    writeFileSync(join(tmpDir, "file.txt"), "hello");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    const h = setupExtension();
    const ui = await openGitUi(h);
    const text = ui.renderText();
    expect(text).toContain("Check branch status");
    expect(text).toContain("enter");
    expect(text).toContain("esc");
  });

  it("does not show the confirmation prompt when there are uncommitted changes", async () => {
    writeFileSync(join(tmpDir, "file.txt"), "hello");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "file.txt"), "modified");
    const h = setupExtension();
    const ui = await openGitUi(h);
    expect(ui.renderText()).not.toContain("Check branch status");
  });

  it("transitions away from the confirmation prompt when Enter is pressed", async () => {
    writeFileSync(join(tmpDir, "file.txt"), "hello");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    const h = setupExtension();
    const ui = await openGitUi(h);
    expect(ui.renderText()).toContain("Check branch status");
    ui.fireInput(ENTER);
    expect(ui.renderText()).not.toContain("Check branch status");
  });

  it("exits the UI when Escape is pressed at the confirmation prompt", async () => {
    writeFileSync(join(tmpDir, "file.txt"), "hello");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    const h = setupExtension();
    const ui = await openGitUi(h);
    ui.fireInput(ESCAPE);
    await ui.cmdPromise;
    expect(ui.hasUi()).toBe(false);
    // No prompt was sent — the user just exited.
    expect(h.pi.sentMessages).toEqual([]);
  });
});

// ── Select-files phase: navigation and selection ────────────────────

describe("file selector navigation and selection", () => {
  beforeEach(() => {
    // Three modified files: a.txt, b.txt, c.txt
    writeFileSync(join(tmpDir, "a.txt"), "a");
    writeFileSync(join(tmpDir, "b.txt"), "b");
    writeFileSync(join(tmpDir, "c.txt"), "c");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "a.txt"), "a-mod");
    writeFileSync(join(tmpDir, "b.txt"), "b-mod");
    writeFileSync(join(tmpDir, "c.txt"), "c-mod");
  });

  it("DOWN moves the cursor to the next file and re-renders", async () => {
    const h = setupExtension();
    const ui = await openGitUi(h);
    const before = ui.renderText();
    ui.fireInput(DOWN);
    const after = ui.renderText();
    expect(after).not.toBe(before);
  });

  it("UP from the first file does not move (clamped)", async () => {
    const h = setupExtension();
    const ui = await openGitUi(h);
    const before = ui.renderText();
    ui.fireInput(UP);
    const after = ui.renderText();
    expect(after).toBe(before);
  });

  it("DOWN past the last file does not move (clamped)", async () => {
    const h = setupExtension();
    const ui = await openGitUi(h);
    ui.fireInput(DOWN);
    ui.fireInput(DOWN); // cursor at last
    const before = ui.renderText();
    ui.fireInput(DOWN);
    const after = ui.renderText();
    expect(after).toBe(before);
  });

  it("TAB toggles selection of the file under the cursor", async () => {
    const h = setupExtension();
    const ui = await openGitUi(h);
    const before = ui.renderText();
    ui.fireInput(TAB);
    const after = ui.renderText();
    // Some marker changed in the rendered output (selection indicator).
    expect(after).not.toBe(before);
    // Pressing TAB again toggles back to the original.
    ui.fireInput(TAB);
    expect(ui.renderText()).toBe(before);
  });
});

describe("'a' (select-all) toggle", () => {
  beforeEach(() => {
    writeFileSync(join(tmpDir, "a.txt"), "a");
    writeFileSync(join(tmpDir, "b.txt"), "b");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "a.txt"), "a-mod");
    writeFileSync(join(tmpDir, "b.txt"), "b-mod");
  });

  it("selects all files when none are selected", async () => {
    const h = setupExtension();
    const ui = await openGitUi(h);
    const noneSelected = ui.renderText();
    ui.fireInput("a");
    const allSelected = ui.renderText();
    // Selection state changed.
    expect(allSelected).not.toBe(noneSelected);
  });

  it("deselects all when all are selected (toggle)", async () => {
    const h = setupExtension();
    const ui = await openGitUi(h);
    const noneSelected = ui.renderText();
    ui.fireInput("a"); // all
    ui.fireInput("a"); // toggle off
    expect(ui.renderText()).toBe(noneSelected);
  });

  it("'u' unselects everything regardless of prior state", async () => {
    const h = setupExtension();
    const ui = await openGitUi(h);
    const noneSelected = ui.renderText();
    ui.fireInput("a"); // select all
    ui.fireInput("u"); // unselect all
    expect(ui.renderText()).toBe(noneSelected);
  });
});

// ── Diff viewer ─────────────────────────────────────────────────────

describe("diff viewer ('d' from select-files)", () => {
  it("shows tracked file diffs in the rendered output", async () => {
    writeFileSync(join(tmpDir, "tracked.txt"), "original\n");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "tracked.txt"), "modified\n");
    const h = setupExtension();
    const ui = await openGitUi(h);
    ui.fireInput("d");
    const text = ui.renderText();
    expect(text).toContain("tracked.txt");
  });

  it("includes untracked files alongside tracked diffs", async () => {
    writeFileSync(join(tmpDir, "tracked.txt"), "v1\n");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "tracked.txt"), "v2\n");
    writeFileSync(join(tmpDir, "untracked.txt"), "new file\n");
    const h = setupExtension();
    const ui = await openGitUi(h);
    ui.fireInput("d");
    const text = ui.renderText();
    expect(text).toContain("tracked.txt");
    expect(text).toContain("untracked.txt");
  });

  it("renders no tab characters in diff output (tabs replaced with spaces)", async () => {
    // Source files commonly contain tabs. The component sanitizes them
    // to spaces so visibleWidth doesn't undercount and overflow lines.
    writeFileSync(join(tmpDir, "tabs.txt"), "before\n");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "tabs.txt"), "before\n\t\tindented with tabs\n");
    const h = setupExtension();
    const ui = await openGitUi(h);
    ui.fireInput("d");
    const lines = ui.render();
    for (const line of lines) {
      expect(line).not.toContain("\t");
    }
  });
});

describe("diff viewer discard-prompt confirmation", () => {
  // Simulate: enter diff viewer, switch to prompt pane, type something,
  // press escape (asks "discard?"), press 'y' (confirm). Afterwards the
  // viewer must STILL be open and the prompt cleared. Previously a bug
  // exited the viewer entirely on confirm.

  function setupTrackedDiff(): void {
    writeFileSync(join(tmpDir, "f.txt"), "original\n");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "f.txt"), "modified\n");
  }

  it("does NOT exit the diff viewer when the user confirms discard", async () => {
    setupTrackedDiff();
    const h = setupExtension();
    const ui = await openGitUi(h);
    ui.fireInput("d"); // open diff viewer
    expect(ui.renderText()).toContain("f.txt");
    // Switch focus to the prompt pane and type something.
    ui.fireInput(TAB);
    ui.fireInput("h");
    // First escape: prompt-pane → diff-pane (no confirmation yet).
    ui.fireInput(ESCAPE);
    // Second escape from diff-pane while prompt has text → "discard?".
    ui.fireInput(ESCAPE);
    expect(ui.renderText()).toMatch(/Discard prompt/);
    // Confirm discard. The original bug exited the viewer entirely;
    // the fix keeps the viewer open with the prompt cleared.
    ui.fireInput("y");
    expect(ui.hasUi()).toBe(true);
    expect(ui.renderText()).toContain("f.txt");
    expect(ui.renderText()).not.toMatch(/Discard prompt/);
  });
});

// ── Diff gathering: tracked vs untracked categorization ────────────
//
// Replaces the unit tests that filtered fixture arrays. The real
// production code categorizes selected files internally and produces a
// combined diff in the viewer; assert that diff output contains both
// kinds of files when both are selected.

describe("diff gathering categorizes tracked + untracked files", () => {
  it("includes tracked-modified files when only those are present", async () => {
    writeFileSync(join(tmpDir, "modified.txt"), "v1\n");
    writeFileSync(join(tmpDir, "deleted.txt"), "v1\n");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "modified.txt"), "v2\n");
    rmSync(join(tmpDir, "deleted.txt"));
    const h = setupExtension();
    const ui = await openGitUi(h);
    ui.fireInput("d");
    const text = ui.renderText();
    expect(text).toContain("modified.txt");
    expect(text).toContain("deleted.txt");
  });

  it("includes untracked files when only those are present", async () => {
    writeFileSync(join(tmpDir, ".gitkeep"), "");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "new1.txt"), "n1\n");
    writeFileSync(join(tmpDir, "new2.txt"), "n2\n");
    const h = setupExtension();
    const ui = await openGitUi(h);
    ui.fireInput("d");
    const text = ui.renderText();
    expect(text).toContain("new1.txt");
    expect(text).toContain("new2.txt");
  });

  it("includes diffs for staged files", async () => {
    writeFileSync(join(tmpDir, "staged.txt"), "original\n");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "staged.txt"), "changed\n");
    execSync("git add staged.txt", { cwd: tmpDir });
    const h = setupExtension();
    const ui = await openGitUi(h);
    ui.fireInput("d");
    const text = ui.renderText();
    expect(text).toContain("staged.txt");
    // The change content must appear (not just the file name).
    expect(text).toMatch(/changed|original/);
  });

  it("handles large diffs without raising buffer-overflow errors (regression)", async () => {
    // Regression: an early bug used a too-small `maxBuffer` for the
    // combined `git diff` call, which silently truncated output and
    // dropped later files. The current code surfaces such failures
    // through `ctx.ui.notify(..., "error")`. We assert: no error
    // notifications fire when diffing a large file alongside an
    // untracked one. (The viewer's render() is windowed so we can't
    // observe later-file content directly, but `notifications` is the
    // canonical error channel and was the user-visible regression.)
    const largeContent = "line\n".repeat(50000);
    writeFileSync(join(tmpDir, "large.txt"), largeContent);
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    const modifiedContent = "modified-line\n".repeat(50000);
    writeFileSync(join(tmpDir, "large.txt"), modifiedContent);
    writeFileSync(join(tmpDir, "small.txt"), "hello\n");
    const h = setupExtension();
    const ui = await openGitUi(h);
    ui.fireInput("d");
    expect(ui.hasUi()).toBe(true);
    expect(ui.ctx.ui.notifications.filter((n) => n.level === "error")).toEqual(
      [],
    );
  }, 15000);

  it("includes a hunk header for untracked files so all added lines are marked", async () => {
    // Without `@@ -0,0 +N,M @@`, delta only renders "added: filename"
    // with no content. The fake diff for untracked files must include
    // the hunk header so every body line is treated as an addition.
    writeFileSync(join(tmpDir, ".gitkeep"), "");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "newfile.txt"), "line1\nline2\nline3\n");
    const h = setupExtension();
    const ui = await openGitUi(h);
    ui.fireInput("d");
    const text = ui.renderText();
    // All three lines must show up (they were added).
    expect(text).toContain("line1");
    expect(text).toContain("line2");
    expect(text).toContain("line3");
  });
});

// ── Untracked file expansion ──────────────────────────────────────
//
// The unexported getUntrackedFiles helper expands untracked directories
// into individual file paths, respects .gitignore, and walks nested
// directories. Observable through the diff viewer: each file (not the
// containing directory) appears as its own diff section.

describe("untracked file expansion in diff viewer", () => {
  it("expands untracked directories into individual files", async () => {
    writeFileSync(join(tmpDir, ".gitkeep"), "");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    mkdirSync(join(tmpDir, "myext"));
    writeFileSync(join(tmpDir, "myext", "index.ts"), "export default {}");
    writeFileSync(join(tmpDir, "myext", "README.md"), "# My Ext");
    const h = setupExtension();
    const ui = await openGitUi(h);
    ui.fireInput("d");
    const text = ui.renderText();
    expect(text).toContain("myext/index.ts");
    expect(text).toContain("myext/README.md");
  });

  it("respects .gitignore (excluded files do not appear in diff)", async () => {
    // Commit `.gitignore` so its contents (which mention 'node_modules')
    // don't show up as diff additions; the test then only proves the
    // ignored *paths* are absent from the untracked-file expansion.
    writeFileSync(join(tmpDir, ".gitignore"), "node_modules/\n");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    mkdirSync(join(tmpDir, "node_modules", "some-pkg"), { recursive: true });
    writeFileSync(
      join(tmpDir, "node_modules", "some-pkg", "index.js"),
      "module.exports = {}",
    );
    writeFileSync(join(tmpDir, "real-file.txt"), "keep me\n");
    const h = setupExtension();
    const ui = await openGitUi(h);
    ui.fireInput("d");
    const text = ui.renderText();
    expect(text).toContain("real-file.txt");
    // Ignored paths must not appear as files in the diff output.
    expect(text).not.toContain("node_modules/some-pkg/index.js");
    expect(text).not.toContain("some-pkg/index.js");
  });

  it("walks nested directories", async () => {
    writeFileSync(join(tmpDir, ".gitkeep"), "");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    const nested = join(tmpDir, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "deep.txt"), "deep");
    writeFileSync(join(tmpDir, "a", "top.txt"), "top");
    const h = setupExtension();
    const ui = await openGitUi(h);
    ui.fireInput("d");
    const text = ui.renderText();
    expect(text).toContain("a/b/c/deep.txt");
    expect(text).toContain("a/top.txt");
  });
});
// ════════════════════════════════════════════════════════════════════
// DIRECT UNIT TESTS — pure transformation helpers
// ════════════════════════════════════════════════════════════════════
//
// These exported helpers are pure functions whose behavior is buried
// deep inside diff-viewer scroll/filter logic. Driving them through
// keypresses would explode each 5-line test into 30+ lines of harness
// while strictly losing signal — the integration assertion ends up
// being a single number (cursor offset), and the original assertion
// proves the math of the underlying transformation directly.

describe("buildFileIndex (direct)", () => {
  it("parses diff --git headers from raw diff output", () => {
    const diff = [
      "diff --git a/foo.ts b/foo.ts",
      "index abc..def 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,3 @@",
      "-old",
      "+new",
      "diff --git a/bar.ts b/bar.ts",
      "index 111..222 100644",
      "--- a/bar.ts",
      "+++ b/bar.ts",
    ].join("\n");
    const result = buildFileIndex(diff);
    expect(result).toEqual([
      { line: 0, name: "foo.ts" },
      { line: 7, name: "bar.ts" },
    ]);
  });

  it("handles ANSI-colored diff headers", () => {
    const diff = [
      "\x1b[1mdiff --git a/foo.ts b/foo.ts\x1b[m",
      "\x1b[1m+++ b/foo.ts\x1b[m",
    ].join("\n");
    const result = buildFileIndex(diff);
    expect(result).toEqual([{ line: 0, name: "foo.ts" }]);
  });

  it("returns empty array for non-diff input", () => {
    expect(buildFileIndex("not a diff")).toEqual([]);
  });
});

describe("remapFileIndex (direct)", () => {
  it("remaps line numbers in place to match file names in transformed output", () => {
    const fileIndex = [
      { line: 0, name: "a.ts" },
      { line: 10, name: "b.ts" },
    ];
    const transformed = [
      "Δ a.ts",
      "──────",
      "@@",
      "-old",
      "+new",
      "",
      "Δ b.ts",
      "──────",
      "@@",
      "-old",
      "+new",
    ].join("\n");
    remapFileIndex(fileIndex, transformed);
    expect(fileIndex).toEqual([
      { line: 0, name: "a.ts" },
      { line: 6, name: "b.ts" },
    ]);
  });

  it("preserves order when searching for file names", () => {
    const fileIndex = [
      { line: 0, name: "a.ts" },
      { line: 5, name: "b.ts" },
      { line: 10, name: "a.ts" },
    ];
    const transformed = ["Δ a.ts", "Δ b.ts", "Δ a.ts"].join("\n");
    remapFileIndex(fileIndex, transformed);
    expect(fileIndex).toEqual([
      { line: 0, name: "a.ts" },
      { line: 1, name: "b.ts" },
      { line: 2, name: "a.ts" },
    ]);
  });
});

describe("buildChunkIndex (direct)", () => {
  it("finds delta chunk header lines by the bullet+line-number pattern", () => {
    const lines = [
      "Δ multi.txt",
      "──────────",
      "────┐",
      "• 3: class Foo { │",
      "────┘",
      "-old line",
      "+new line",
      "",
      "────┐",
      "• 50: function bar() { │",
      "────┘",
      "-another old",
      "+another new",
    ];
    expect(buildChunkIndex(lines)).toEqual([2, 8]);
  });

  it("returns empty array when no chunk headers exist", () => {
    expect(buildChunkIndex(["just text", "no chunks"])).toEqual([]);
  });

  it("handles ANSI codes wrapping the bullet line", () => {
    const lines = ["────┐", "\x1b[36m• 5: foo()\x1b[m", "────┘"];
    expect(buildChunkIndex(lines)).toEqual([0]);
  });

  it("does not match lines without the bullet pattern", () => {
    const lines = ["────┐", "  no bullet here", "────┘"];
    expect(buildChunkIndex(lines)).toEqual([]);
  });
});

describe("remapChunkIndex (direct)", () => {
  const sections = [
    { name: "app.ts", startLine: 0, endLine: 10 },
    { name: "app.test.ts", startLine: 10, endLine: 20 },
  ];

  it("remaps chunk indices to filtered line numbers", () => {
    expect(
      remapChunkIndex([3, 7], sections, 0, {
        hideTests: false,
        hiddenFiles: new Set(),
      }),
    ).toEqual([3, 7]);
  });

  it("drops chunks in hidden test files", () => {
    expect(
      remapChunkIndex([5, 15], sections, 0, {
        hideTests: true,
        hiddenFiles: new Set(),
      }),
    ).toEqual([5]);
  });

  it("drops chunks in manually hidden files", () => {
    expect(
      remapChunkIndex([5, 15], sections, 0, {
        hideTests: false,
        hiddenFiles: new Set(["app.ts"]),
      }),
    ).toEqual([5]);
  });

  it("remaps line numbers when earlier sections are removed", () => {
    const threeSections = [
      { name: "a.ts", startLine: 0, endLine: 5 },
      { name: "b.test.ts", startLine: 5, endLine: 10 },
      { name: "c.ts", startLine: 10, endLine: 15 },
    ];
    expect(
      remapChunkIndex([12], threeSections, 0, {
        hideTests: true,
        hiddenFiles: new Set(),
      }),
    ).toEqual([7]);
  });

  it("returns empty array when no chunks provided", () => {
    expect(
      remapChunkIndex([], sections, 0, {
        hideTests: false,
        hiddenFiles: new Set(),
      }),
    ).toEqual([]);
  });

  it("accounts for preamble lines", () => {
    const sectionsWithPreamble = [{ name: "app.ts", startLine: 3, endLine: 8 }];
    expect(
      remapChunkIndex([5], sectionsWithPreamble, 3, {
        hideTests: false,
        hiddenFiles: new Set(),
      }),
    ).toEqual([5]);
  });
});

describe("initialDiffScrollOffset (direct)", () => {
  it("returns 0 when the file index is empty", () => {
    expect(initialDiffScrollOffset([])).toBe(0);
  });

  it("returns 0 when the first file starts at line 0", () => {
    expect(
      initialDiffScrollOffset([
        { line: 0, name: "a.ts" },
        { line: 10, name: "b.ts" },
      ]),
    ).toBe(0);
  });

  it("returns the first file line when there is a preamble (delta output)", () => {
    expect(
      initialDiffScrollOffset([
        { line: 3, name: "a.ts" },
        { line: 15, name: "b.ts" },
      ]),
    ).toBe(3);
  });
});

describe("isDeltaAvailable (direct)", () => {
  it("returns false in the test environment because the child_process mock intercepts 'which delta'", () => {
    expect(isDeltaAvailable()).toBe(false);
  });

  it("returns consistent results across calls (cached)", () => {
    expect(isDeltaAvailable()).toBe(isDeltaAvailable());
  });
});

describe("pipeThroughDelta (direct)", () => {
  // Each test sets up its own `deltaMock.handler` so the delta
  // behavior is explicit, not inherited from the file-level default.
  // The afterEach clears the handler so leakage between tests cannot
  // hide a bug — the default ("delta unavailable") then takes over.
  afterEach(() => {
    deltaMock.handler = undefined;
  });

  it("returns the input unchanged when forceAvailable is false (no delta invocation)", () => {
    // Set up: any attempt to invoke delta during this test is a bug.
    deltaMock.handler = (cmd) => {
      throw new Error(
        `pipeThroughDelta should not have invoked delta when forceAvailable=false (got: ${cmd})`,
      );
    };
    const input = "diff --git a/x b/x\n+line\n";
    expect(pipeThroughDelta(input, { forceAvailable: false })).toEqual({
      text: input,
    });
  });

  it("returns delta's output verbatim when delta succeeds", () => {
    // Set up: delta succeeds, returning canned text.
    const deltaOutput = "\x1b[1mdiff --git a/x b/x\x1b[m\n+colorized\n";
    deltaMock.handler = () => deltaOutput;
    const input = "diff --git a/x b/x\n+line\n";
    const result = pipeThroughDelta(input, { forceAvailable: true });
    expect(result).toEqual({ text: deltaOutput });
  });

  it("returns the input with an error when delta exits non-zero", () => {
    // Set up: delta fails with a synthetic stderr message that the
    // production code formats into the returned error string.
    deltaMock.handler = () => {
      const err = new Error("command failed") as Error & { stderr: string };
      err.stderr = "delta: malformed input on line 7";
      return { error: err };
    };
    const input = "diff --git a/x b/x\n";
    const result = pipeThroughDelta(input, { forceAvailable: true });
    expect(result.text).toBe(input);
    expect(result.error).toMatch(/delta failed/);
    expect(result.error).toMatch(/malformed input on line 7/);
  });
});

// ════════════════════════════════════════════════════════════════════
// generateWorkingDiffOutput is the single function the GitComponent
// calls to assemble the diff text + indices for the diff viewer. The
// integration tests cover that the rendered diff *content* is right;
// these direct tests pin the function's return-value contract —
// `fileIndex` (used by 'g'/'G' file navigation) and `chunkIndex` (used
// by 'c'/'C' chunk navigation) are only observable through scroll
// offsets in the integration UI, which would take many tests of
// indirect behavior to pin equivalently.
describe("generateWorkingDiffOutput (direct)", () => {
  it("returns a fileIndex containing every changed tracked file", () => {
    writeFileSync(join(tmpDir, "foo.txt"), "original foo\n");
    writeFileSync(join(tmpDir, "bar.txt"), "original bar\n");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "foo.txt"), "modified foo\n");
    writeFileSync(join(tmpDir, "bar.txt"), "modified bar\n");

    const result = generateWorkingDiffOutput({
      hideWhitespace: true,
      useDelta: false,
    });
    const names = result.fileIndex.map((e) => e.name).sort();
    expect(names).toEqual(["bar.txt", "foo.txt"]);
  });

  it("returns a fileIndex that includes untracked files alongside tracked changes", () => {
    writeFileSync(join(tmpDir, "tracked.txt"), "original\n");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "tracked.txt"), "modified\n");
    writeFileSync(join(tmpDir, "untracked.txt"), "new file\n");

    const result = generateWorkingDiffOutput({
      hideWhitespace: true,
      useDelta: false,
    });
    const names = result.fileIndex.map((e) => e.name).sort();
    expect(names).toEqual(["tracked.txt", "untracked.txt"]);
  });

  it("preserves git's ANSI color codes when useDelta is false", () => {
    // The diff viewer integration tests strip ANSI for textual matching,
    // so they cannot assert that the colorized fallback path is used
    // when delta is unavailable. This pins the contract directly: when
    // useDelta=false, the diff text contains git's own ANSI escapes.
    writeFileSync(join(tmpDir, "file.txt"), "original\n");
    execSync("git add file.txt && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "file.txt"), "modified\n");

    const result = generateWorkingDiffOutput({
      hideWhitespace: true,
      useDelta: false,
    });
    expect(result.diff).toContain("file.txt");
    // eslint-disable-next-line no-control-regex
    expect(result.diff).toMatch(/\x1b\[/);
  });

  it("returns an empty chunkIndex when useDelta is false", () => {
    // chunkIndex is built from delta's chunk-header decoration; with
    // useDelta=false there is no decoration to scan, and the function
    // must produce an empty array (so 'c'/'C' navigation no-ops cleanly).
    writeFileSync(join(tmpDir, "file.txt"), "original\n");
    execSync("git add file.txt && git commit -m init", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "file.txt"), "modified\n");

    const result = generateWorkingDiffOutput({
      hideWhitespace: true,
      useDelta: false,
    });
    expect(result.chunkIndex).toEqual([]);
  });
});

describe("sanitizeLine (direct)", () => {
  it("replaces tab characters with two spaces", () => {
    expect(sanitizeLine("\thello")).toBe("  hello");
    expect(sanitizeLine("a\tb\tc")).toBe("a  b  c");
  });

  it("preserves lines without tabs unchanged", () => {
    expect(sanitizeLine("plain text")).toBe("plain text");
    expect(sanitizeLine("  already spaces  ")).toBe("  already spaces  ");
  });

  it("handles mixed tabs and spaces (each tab independently → two spaces)", () => {
    expect(sanitizeLine("  \t  text\t")).toBe("      text  ");
  });

  it("handles empty string", () => {
    expect(sanitizeLine("")).toBe("");
  });

  it("preserves ANSI codes while replacing tabs", () => {
    // ANSI escape sequences must pass through untouched — only literal
    // \t characters are replaced.
    const input = "\x1b[31m\thello\x1b[m";
    expect(sanitizeLine(input)).toBe("\x1b[31m  hello\x1b[m");
  });
});

describe("FilePathAutocompleteProvider (direct)", () => {
  let provider: FilePathAutocompleteProvider;
  const signal = new AbortController().signal;

  beforeEach(() => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src/app.ts"), "export default {}");
    writeFileSync(join(tmpDir, "src/utils.ts"), "export {}");
    writeFileSync(join(tmpDir, "README.md"), "# test");
    execSync("git add . && git commit -m init", { cwd: tmpDir });
    provider = new FilePathAutocompleteProvider();
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

  it("matches a prefix in the middle of a line", async () => {
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

  it("applies completion by replacing the prefix with the full path", () => {
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

  it("matches a './' relative path prefix", async () => {
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
    const result = await provider.getSuggestions(["ext"], 0, 3, { signal });
    expect(result).toBeNull();
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
