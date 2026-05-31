/**
 * Integration tests for the /worktree extension.
 *
 * Tests drive the extension exactly the way the real pi runtime
 * does: a mock pi object registers the extension's command/event
 * handlers and `pi.runCommand(...)` delivers args. The extension
 * shells out to a real `git` running against per-test tmpdir
 * repositories.
 *
 * Editor invocation is mocked (we don't actually want to launch
 * VS Code in the test runner) but every other side effect — file
 * I/O, spawning git, scanning directories — is real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Editor mock ────────────────────────────────────────────────────
//
// `vi.mock` is hoisted above all imports. The extension calls
// `openInEditor` after creating a worktree; tests inspect
// `editorMock.calls` to verify it was invoked with the right path,
// and may set `editorMock.handler` to make it report failure.

// The handler signature is derived from the real `openInEditor`
// so any change to its argument or return shape (e.g. adding a
// new field to OpenEditorResult) breaks the mock at compile
// time, forcing tests to be updated in lock-step.
type OpenInEditor = typeof import("./editor.js").openInEditor;

const editorMock = vi.hoisted(() => {
  // Re-declared in vi.hoisted because it runs before module
  // imports; we can't reference the imported type here. The
  // module-scope `OpenInEditor` alias above keeps the rest of
  // the file honest.
  type Handler = (
    dir: string,
    env?: NodeJS.ProcessEnv,
    platform?: NodeJS.Platform,
  ) => { ok: boolean; attempted: string; error?: string };
  return {
    calls: [] as string[],
    handler: undefined as undefined | Handler,
  };
});

vi.mock("./editor.js", () => {
  const openInEditor: OpenInEditor = (dir, env, platform) => {
    editorMock.calls.push(dir);
    if (editorMock.handler) return editorMock.handler(dir, env, platform);
    return { ok: true, attempted: "mock" };
  };
  return { openInEditor };
});

import { execSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  realpathSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import worktreeExtension, {
  type WorktreePi,
  createExtension,
} from "./index.js";
import { createConfigStore } from "./config-store.js";
import { createRepoCache } from "./cache.js";

// ── throwingMock ───────────────────────────────────────────────────

/**
 * Wrap a partial impl in a Proxy and present it as a fully-typed
 * `T`. Any property access not present on the partial throws a
 * loud error instead of returning `undefined` (the default JS
 * behavior, which usually surfaces later as a confusing
 * `TypeError: x is not a function`).
 *
 * This lets each mock declare its static type as the FULL
 * production interface (e.g. `ExtensionCommandContext`) without
 * `as unknown as T` casts that silently lie. The partial impl
 * is presented as `T`, but the Proxy makes the gap explicit at
 * access time — tests must grow the mock when production
 * starts using a new method.
 *
 * Symbol-keyed access (Symbol.toPrimitive, Vitest internals,
 * etc.) passes through untouched so unrelated machinery still
 * works.
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

// ── Mock pi ────────────────────────────────────────────────────────

type CommandConfig = Parameters<WorktreePi["registerCommand"]>[1];
type CommandHandler = CommandConfig["handler"];

interface RegisteredCommand {
  name: string;
  config: CommandConfig;
}

interface MockPi extends WorktreePi {
  commands: Map<string, RegisteredCommand>;
  runCommand(
    name: string,
    args: string,
    ctx: MockCtx,
  ): ReturnType<CommandHandler>;
  argumentCompletions(
    name: string,
    prefix: string,
  ): ReturnType<NonNullable<CommandConfig["getArgumentCompletions"]>>;
}

function makeMockPi(): MockPi {
  const commands = new Map<string, RegisteredCommand>();
  return {
    commands,
    registerCommand(name, config) {
      commands.set(name, { name, config });
    },
    runCommand(name, args, ctx) {
      const cmd = commands.get(name);
      if (!cmd) throw new Error(`Command not registered: ${name}`);
      // ctx is already typed as the full ExtensionCommandContext
      // via throwingMock — no casting needed here.
      return cmd.config.handler(args, ctx);
    },
    argumentCompletions(name, prefix) {
      const cmd = commands.get(name);
      if (!cmd) throw new Error(`Command not registered: ${name}`);
      const fn = cmd.config.getArgumentCompletions;
      if (!fn) return null;
      return fn(prefix);
    },
  };
}

// ── Mock ctx ───────────────────────────────────────────────────────

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
  terminal: { rows: number; cols: number };
}

interface ActiveCustom {
  tui: MockActiveTui;
  done: (val: unknown) => void;
  component: CustomComponent;
  promise: Promise<unknown>;
}

/** Mock-only helpers attached to the proxied `ui` object. */
interface MockUiContextExtras {
  notifications: Array<{ msg: string; level: "info" | "warning" | "error" }>;
  hasActiveCustom(): boolean;
  fireInput(input: string): void;
  /** Type a string of characters into the active input one by one. */
  typeText(text: string): void;
  renderActive(width?: number): string[];
  exitActive(value?: unknown): void;
}

/**
 * Mocked UI is statically typed as the full `ExtensionUIContext`
 * (so misuse fails at compile time) plus test-only helpers.
 * At runtime the Proxy throws if the extension reaches for a
 * method we haven't stubbed.
 */
type MockUiContext = ExtensionUIContext & MockUiContextExtras;

/** Mocked ctx is the full `ExtensionCommandContext` with our UI mock substituted. */
type MockCtx = Omit<ExtensionCommandContext, "ui"> & { ui: MockUiContext };

function makeMockCtx(): MockCtx {
  let active: ActiveCustom | undefined;

  // Partial impl of ExtensionUIContext + MockUiContextExtras.
  // Anything not listed here is rejected by the Proxy below.
  const uiImpl: Partial<ExtensionUIContext> & MockUiContextExtras = {
    notifications: [],
    notify(msg, level) {
      uiImpl.notifications.push({ msg, level: level ?? "info" });
    },
    setStatus() {
      // unused in tests
    },
    custom: (async (factory: CustomFactory) => {
      // Stub TUI primitives. Anything not on these impls is
      // rejected by throwingMock with a clear error.
      const tuiImpl: MockActiveTui = {
        requestRender: vi.fn(),
        terminal: { rows: 40, cols: 120 },
      };
      const tui = throwingMock<CustomTui>(tuiImpl, "MockTui");
      const themeImpl = {
        fg: (_c: string, t?: string) => t ?? "",
        bold: (t: string) => t,
      };
      const theme = throwingMock<CustomTheme>(themeImpl, "MockTheme");
      const kb = throwingMock<CustomKb>({}, "MockKeybindingsManager");

      let resolveDone!: (val: unknown) => void;
      const promise = new Promise<unknown>((res) => {
        resolveDone = res;
      });
      const done = (val: unknown) => {
        resolveDone(val);
        active = undefined;
      };
      const component = (await factory(
        tui,
        theme,
        kb,
        done as (result: never) => void,
      )) as CustomComponent;
      active = { tui: tuiImpl, done, component, promise };
      return promise as Promise<never>;
    }) as ExtensionUIContext["custom"],
    hasActiveCustom: () => active !== undefined,
    fireInput: (input) => {
      if (!active) throw new Error("no active ui.custom component");
      active.component.handleInput(input);
    },
    typeText(text) {
      if (!active) throw new Error("no active ui.custom component");
      for (const ch of text) active.component.handleInput(ch);
    },
    renderActive: (width = 80) => {
      if (!active) throw new Error("no active ui.custom component");
      return active.component.render(width);
    },
    exitActive: (value) => {
      if (!active) throw new Error("no active ui.custom component");
      active.done(value);
    },
  };
  const ui = throwingMock<MockUiContext>(uiImpl, "MockUiContext");

  // Partial impl of ExtensionCommandContext.
  const ctxImpl: Partial<ExtensionCommandContext> & { ui: MockUiContext } = {
    cwd: "/home/user",
    hasUI: true,
    ui,
  };
  return throwingMock<MockCtx>(ctxImpl, "MockCtx");
}

// ── waitFor helper ────────────────────────────────────────────────

async function waitFor(
  predicate: () => boolean,
  what = "condition",
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`waitFor: ${what} not satisfied within ${timeoutMs}ms`);
    await new Promise((r) => setImmediate(r));
  }
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── tmpdir + harness ──────────────────────────────────────────────

let tmpDir: string;
// `dataDir` holds both the config (`config.json`) and the
// `trees/` subdir into which worktrees are created. Mirrors
// the production layout under `~/.local/share/worktree-pi/`.
let dataDir: string;
let treesDir: string;
let cacheDir: string;
let scanRoot: string; // the directory the user "configures" to scan
// `homeDir` is what the path helpers strip from a repo path
// when building the worktree's location. We point it at
// `tmpDir` so a repo at `<tmpDir>/scan-root/pie` produces a
// worktree at `<treesDir>/scan-root/pie_<branch>`.
let homeDir: string;

function initRepo(name: string): string {
  const path = join(scanRoot, name);
  mkdirSync(path, { recursive: true });
  execSync(
    `git init -q -b main && git config user.email t@t && git config user.name t`,
    { cwd: path },
  );
  writeFileSync(join(path, "README.md"), `# ${name}\n`);
  execSync(`git add . && git commit -qm init`, { cwd: path });
  return path;
}

function resetEditorMock(): void {
  editorMock.calls = [];
  editorMock.handler = undefined;
}

// Snapshot of `process.env.HOME` so individual tests that
// need to override it (e.g. to assert ~ expansion) can do so
// declaratively while afterEach restores the original value.
let originalHome: string | undefined;

// Mounted UI promises waiting for dismissal. Tests register a
// `cmd` here when they mount a custom component, and the
// afterEach below auto-dismisses any UI still active when the
// test body ends — so a failed assertion mid-test cannot leave
// a command promise unresolved (which would hang Vitest).
const mountedUis: Array<{
  ctx: MockCtx;
  cmd: ReturnType<MockPi["runCommand"]>;
}> = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "worktree-int-"));
  // macOS resolves /var/folders/… through a symlink to
  // /private/var/folders/…; git also follows that symlink, so
  // we resolve it once here and use the canonical path
  // throughout. Otherwise homeDir-stripping would mismatch
  // the path git reports.
  tmpDir = realpathSync(tmpDir);
  dataDir = join(tmpDir, "data");
  treesDir = join(dataDir, "trees");
  cacheDir = join(tmpDir, "cache");
  scanRoot = join(tmpDir, "scan-root");
  homeDir = tmpDir;
  mkdirSync(scanRoot, { recursive: true });
  resetEditorMock();
  originalHome = process.env.HOME;
  mountedUis.length = 0;
});

afterEach(async () => {
  // Atomically dismiss any UI the test left mounted. Even if
  // an assertion failed before the test could call dismiss(),
  // the ESC keypress + await here unblocks the command
  // promise so Vitest's worker can move on.
  for (const m of mountedUis) {
    if (m.ctx.ui.hasActiveCustom()) m.ctx.ui.fireInput("\x1b");
    try {
      await m.cmd;
    } catch {
      // The test already failed; we just want the promise
      // settled so teardown can complete.
    }
  }
  process.env.HOME = originalHome;
  rmSync(tmpDir, { recursive: true, force: true });
});

interface Harness {
  pi: MockPi;
  /** Live-read the on-disk config-store written by the extension. */
  configList(): string[];
  /** Live-read the on-disk cache written by the extension. */
  cacheRepos(): string[] | null;
}

export interface SetupOptions {
  /**
   * Pre-seed the on-disk config store *before* the extension
   * loads. Use this when the test needs the extension to
   * observe configured directories at construction time.
   */
  config?: string[];
  /**
   * Pre-seed the on-disk cache *before* the extension loads.
   * The extension reads the cache exactly once at
   * construction; tests that want the in-memory `repos` list
   * to start non-empty must seed via this option.
   */
  cache?: string[];
}

/**
 * Build the extension under test. Always uses the per-test
 * tmpdir-rooted config + cache. Tests should never construct
 * `createConfigStore` / `createRepoCache` directly — use this
 * factory so paths stay in sync and seeding happens before
 * the extension reads from disk.
 */
function setupExtension(opts: SetupOptions = {}): Harness {
  if (opts.config) {
    const store = createConfigStore(dataDir);
    for (const d of opts.config) store.add(d);
  }
  if (opts.cache) createRepoCache(cacheDir).save(opts.cache);

  const pi = makeMockPi();
  const configStore = createConfigStore(dataDir);
  const cache = createRepoCache(cacheDir);
  createExtension(pi, {
    configStore,
    cache,
    paths: { treesDir, homeDir },
  });
  return {
    pi,
    configList: () => createConfigStore(dataDir).list(),
    cacheRepos: () => createRepoCache(cacheDir).load()?.repos ?? null,
  };
}

/**
 * Run /worktree config (or another command that opens a UI)
 * and wait for the custom component to mount. The mounted UI
 * is registered with `mountedUis` so the top-level afterEach
 * dismisses it automatically — a failed assertion mid-test
 * cannot leave the command promise unresolved.
 *
 * Tests that need to assert on the post-dismiss state
 * (e.g. "the cache is written after the user closes the UI")
 * call `dismiss()` explicitly; the afterEach cleanup is then
 * a no-op for that UI.
 */
async function mountConfigUi(
  pi: MockPi,
  args: string = "config",
): Promise<{
  ctx: MockCtx;
  cmd: ReturnType<MockPi["runCommand"]>;
  /** Press Esc and await the command's resolution (idempotent). */
  dismiss(): Promise<void>;
}> {
  const ctx = makeMockCtx();
  const cmd = pi.runCommand("worktree", args, ctx);
  mountedUis.push({ ctx, cmd });
  await waitFor(() => ctx.ui.hasActiveCustom(), "config UI to mount");
  const dismiss = async () => {
    if (ctx.ui.hasActiveCustom()) ctx.ui.fireInput("\x1b");
    await cmd;
  };
  return { ctx, cmd, dismiss };
}

/**
 * Build the extension with no on-disk config or cache — the
 * "first run" scenario. Use this when a test specifically needs
 * to observe behavior with empty state (e.g. add/remove redirect
 * to config UI, parse-time validation runs before any I/O).
 */
function setupFreshExtension(): Harness {
  return setupExtension();
}

/**
 * Build the extension with `scanRoot` already configured (and
 * optionally a seeded cache). Use this for the common
 * scenario where add/remove tests need to skip the "no
 * directories configured" guard — each test makes its
 * precondition explicit at the call site rather than
 * inheriting it from a `beforeEach`.
 */
function setupConfiguredExtension(opts: { cache?: string[] } = {}): Harness {
  return setupExtension({ config: [scanRoot], cache: opts.cache });
}

// ── Tests ─────────────────────────────────────────────────────────

describe("/worktree command registration", () => {
  it("default export registers the worktree command", () => {
    const pi = makeMockPi();
    worktreeExtension(pi as unknown as Parameters<typeof worktreeExtension>[0]);
    expect(pi.commands.has("worktree")).toBe(true);
  });
});

describe("usage / help", () => {
  it("notifies usage with no args once the user has configured a directory", async () => {
    const h = setupConfiguredExtension();
    const ctx = makeMockCtx();
    await h.pi.runCommand("worktree", "", ctx);
    const usage = ctx.ui.notifications.find((n) => /Usage/i.test(n.msg));
    expect(usage).toBeDefined();
    expect(usage!.msg).toContain("/worktree");
    // The config UI must NOT mount when the user already has
    // a directory configured — the no-args path should just
    // print usage.
    expect(ctx.ui.hasActiveCustom()).toBe(false);
  });

  it("notifies usage on `help` once the user has configured a directory", async () => {
    const h = setupConfiguredExtension();
    const ctx = makeMockCtx();
    await h.pi.runCommand("worktree", "help", ctx);
    expect(
      ctx.ui.notifications.find((n) => /Usage/i.test(n.msg)),
    ).toBeDefined();
    expect(ctx.ui.hasActiveCustom()).toBe(false);
  });

  it("opens the config UI on first run with no args (instead of printing usage)", async () => {
    // First-run scenario: no directories configured yet. The
    // user types just `/worktree` to discover the command.
    // Printing a usage block referencing `/worktree config`
    // makes them issue a second command for no benefit — we
    // jump them straight into the config UI, the same way
    // `/worktree add` and `/worktree remove` do on first run.
    const h = setupFreshExtension();
    const ui = await mountConfigUi(h.pi, "");
    const text = ui.ctx.ui.renderActive().map(stripAnsi).join("\n");
    expect(text).toMatch(/director/i);
  });

  it("opens the config UI on first run for `help` (instead of printing usage)", async () => {
    // Same rationale as the no-args case: any first-run
    // invocation should funnel the user into the config UI.
    const h = setupFreshExtension();
    const ui = await mountConfigUi(h.pi, "help");
    const text = ui.ctx.ui.renderActive().map(stripAnsi).join("\n");
    expect(text).toMatch(/director/i);
  });

  it("rejects an unknown subcommand", async () => {
    const h = setupExtension();
    const ctx = makeMockCtx();
    await h.pi.runCommand("worktree", "frob", ctx);
    const err = ctx.ui.notifications.find((n) => n.level === "error");
    expect(err?.msg).toMatch(/Unknown subcommand/);
  });
});

describe("subcommand autocompletion", () => {
  it("filters by prefix", async () => {
    const h = setupExtension();
    const items = await h.pi.argumentCompletions("worktree", "ad");
    expect((items ?? []).map((i) => i.value)).toEqual(["add"]);
  });
});

describe("first-run config flow", () => {
  it("opens the config UI and asks for a directory", async () => {
    // Scenario: extension freshly loaded, user invokes
    // `/worktree config`. No repos / dirs are required — the
    // assertion is purely that the UI mounts and renders the
    // expected header.
    const h = setupExtension();
    const ui = await mountConfigUi(h.pi);

    const text = ui.ctx.ui.renderActive().map(stripAnsi).join("\n");
    expect(text).toMatch(/director/i);

    await ui.dismiss();
  });

  it("persists config as JSON object {dirs:[...]} at <dataDir>/config.json", async () => {
    // Locks down the new on-disk shape so a future change
    // away from the object form would have to update this
    // test consciously — the previous shape was a top-level
    // array and that drift was invisible until something
    // tried to read it.
    const h = setupExtension();
    initRepo("gamma");
    const ui = await mountConfigUi(h.pi);
    ui.ctx.ui.typeText(scanRoot);
    ui.ctx.ui.fireInput("\r");
    await waitFor(
      () => h.configList().length >= 1,
      "config store to be written",
    );
    await ui.dismiss();

    const configFile = join(dataDir, "config.json");
    expect(existsSync(configFile)).toBe(true);
    const raw: unknown = JSON.parse(readFileSync(configFile, "utf-8"));
    // Object form (not a bare array): forward-compatible for
    // additional keys later (e.g. editor preferences).
    expect(raw).toEqual({ dirs: [scanRoot] });
  });

  it("saves a configured directory and scans repos into the cache", async () => {
    const h = setupExtension();
    initRepo("alpha");
    initRepo("beta");
    const ui = await mountConfigUi(h.pi);

    // Type the path and submit.
    ui.ctx.ui.typeText(scanRoot);
    ui.ctx.ui.fireInput("\r");

    // After a valid directory is added, it should be stored.
    await waitFor(
      () => h.configList().length >= 1,
      "config store to be written",
    );
    expect(h.configList()).toEqual([scanRoot]);

    // Exit the UI; the scan should populate the cache.
    await ui.dismiss();
    await waitFor(() => h.cacheRepos() !== null, "cache to be written");
    const names = (h.cacheRepos() ?? []).map((p) => p.split("/").pop());
    expect(names).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });

  it("rejects a directory that does not contain any git repos", async () => {
    const h = setupExtension();
    const empty = join(tmpDir, "empty");
    mkdirSync(empty);
    const ui = await mountConfigUi(h.pi);
    ui.ctx.ui.typeText(empty);
    ui.ctx.ui.fireInput("\r");

    await waitFor(
      () =>
        ui.ctx.ui.notifications.some(
          (n) => n.level === "error" && /no git repositories/i.test(n.msg),
        ),
      "error notification",
    );
    expect(h.configList()).toEqual([]);

    await ui.dismiss();
  });

  it("expands ~ in the entered path", async () => {
    // `process.env.HOME` is restored by the top-level afterEach,
    // so the override here doesn't need a try/finally.
    process.env.HOME = scanRoot;
    initRepo("gamma");
    const h = setupExtension();
    const ui = await mountConfigUi(h.pi);
    // `~/` should resolve to scanRoot via expandHome.
    ui.ctx.ui.typeText("~/");
    ui.ctx.ui.fireInput("\r");
    await waitFor(() => h.configList().length >= 1, "config saved");
    expect(h.configList()).toEqual([scanRoot]);
    await ui.dismiss();
  });

  it("forwards the down arrow to the editor while the autocomplete dropdown is open", async () => {
    // Repro: with multiple path autocomplete candidates the
    // user should be able to press Down to highlight the
    // second one, then Tab to accept it. Before the fix the
    // ConfigComponent unconditionally consumed Down to
    // navigate the saved-dirs list, so the dropdown stayed
    // pinned on the first item.
    //
    // We seed two sibling directories that both contain a
    // git repo (so submission succeeds in either case) and
    // assert the saved path is the SECOND child, not the
    // first — only achievable if Down moved the dropdown
    // selection.
    //
    // The path is typed as `~/ac-parent/` (HOME pointed at
    // tmpDir) because the editor's autocomplete provider
    // treats text starting with a literal `/` as a slash-
    // command lookup, not a filesystem path — so absolute
    // paths simply don't surface a dropdown.
    process.env.HOME = tmpDir;
    // Two candidate scan roots side-by-side; each contains a
    // real git repo so config-store accepts whichever one we
    // pick. The bug-vs-fix difference is which one gets
    // saved — ac-a (Down swallowed) or ac-b (Down forwarded).
    const aRoot = join(tmpDir, "ac-a");
    const bRoot = join(tmpDir, "ac-b");
    mkdirSync(join(aRoot, "repo"), { recursive: true });
    mkdirSync(join(bRoot, "repo"), { recursive: true });
    execSync("git init -b main", { cwd: join(aRoot, "repo") });
    execSync("git init -b main", { cwd: join(bRoot, "repo") });

    const h = setupFreshExtension();
    const ui = await mountConfigUi(h.pi);

    ui.ctx.ui.typeText("~/ac-");

    // Tab opens the autocomplete dropdown when there are
    // multiple candidates (with a single candidate it would
    // auto-apply). The editor's path-completion path is only
    // surfaced via Tab — typing alone doesn't auto-trigger
    // outside slash-command / @-attachment contexts.
    ui.ctx.ui.fireInput("\t");

    await waitFor(() => {
      const out = ui.ctx.ui.renderActive(120).map(stripAnsi).join("\n");
      return /ac-a/.test(out) && /ac-b/.test(out);
    }, "path autocomplete dropdown");

    // Down arrow — must move dropdown selection, not the
    // saved-dirs cursor above.
    ui.ctx.ui.fireInput("\x1b[B");
    // Tab applies the currently-highlighted dropdown item.
    ui.ctx.ui.fireInput("\t");
    // Submit.
    ui.ctx.ui.fireInput("\r");

    await waitFor(() => h.configList().length >= 1, "config saved");
    // If Down had been swallowed, the saved path would be
    // the FIRST candidate (ac-a).
    expect(h.configList()).toEqual([bRoot]);
  });

  it("/worktree without config redirects to config", async () => {
    const h = setupExtension();
    // No `add` should run if config is empty — the extension
    // should open the config UI instead and notify why.
    const ui = await mountConfigUi(h.pi, "add foo bar");
    await waitFor(
      () =>
        ui.ctx.ui.notifications.some((n) =>
          /no.*director|configure/i.test(n.msg),
        ),
      "redirect notification",
    );
    await ui.dismiss();
  });
});

describe("subsequent runs", () => {
  it("surfaces background scan errors on the next user command", async () => {
    // Scenario: a previously-configured directory has been
    // deleted (or made unreadable) since last run. The
    // background re-scan kicked off on extension load will
    // encounter the failure. Per AGENTS.md, those errors
    // must be reported — not silently dropped — even though
    // they happen outside any handler. We verify they surface
    // on the *next* /worktree invocation as a warning.
    const missing = join(tmpDir, "deleted-since-last-run");
    // Seed config with a path that does not exist on disk.
    // We bypass validateConfigDir on purpose — simulating a
    // dir that was valid when added but vanished since.
    const phantom = join(missing, "phantom-repo");
    const h = setupExtension({
      config: [missing],
      // Cache pre-seeded with a phantom repo. The bg scan will
      // overwrite this with `[]` once it finishes — we use that
      // transition as a deterministic "bg scan completed"
      // signal, instead of a fragile single-tick yield.
      cache: [phantom],
    });
    await waitFor(
      () => !(h.cacheRepos() ?? []).includes(phantom),
      "background scan to finish (cache rewritten)",
    );
    const ctx = makeMockCtx();
    await h.pi.runCommand("worktree", "help", ctx);
    const warn = ctx.ui.notifications.find(
      (n) => n.level === "warning" && /Background scan failed/.test(n.msg),
    );
    expect(warn?.msg).toContain(missing);
  });

  it("loads from cache without rescanning synchronously, then re-scans in the background", async () => {
    initRepo("alpha");
    const h = setupExtension({
      config: [scanRoot],
      cache: [join(scanRoot, "alpha")],
    });

    // After registration, cached repos should be available for
    // autocompletion immediately.
    const items = h.pi.argumentCompletions("worktree", "add ");
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: expect.stringMatching(/^add .*alpha/),
        }),
      ]),
    );

    // Now create a new repo; the background re-scan triggered on
    // load should pick it up.
    initRepo("beta");
    await waitFor(
      () => (h.cacheRepos() ?? []).some((r) => r.endsWith("/beta")),
      "background rescan to update cache",
    );
  });
});

// ── /worktree add ──────────────────────────────────────────────────

describe("/worktree add", () => {
  it("creates a worktree under the trees dir and opens the editor", async () => {
    initRepo("pie");
    const h = setupConfiguredExtension({ cache: [join(scanRoot, "pie")] });
    const ctx = makeMockCtx();
    await h.pi.runCommand("worktree", "add pie my-feat", ctx);

    // git worktree exists at the canonical trees-dir location.
    // For homeDir=tmpDir and a repo at <tmpDir>/scan-root/pie
    // the worktree should land at <treesDir>/scan-root/pie_my-feat.
    const worktreePath = join(treesDir, "scan-root", "pie_my-feat");
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(worktreePath, "README.md"))).toBe(true);
    // It must NOT have been created next to the repo (the
    // old convention).
    expect(existsSync(join(scanRoot, "pie-tree-my-feat"))).toBe(false);
    expect(existsSync(join(scanRoot, "pie_my-feat"))).toBe(false);

    // editor was opened with that exact path
    expect(editorMock.calls).toEqual([worktreePath]);

    // success notification mentions the new directory name.
    expect(
      ctx.ui.notifications.some(
        (n) => n.level !== "error" && /pie_my-feat/.test(n.msg),
      ),
    ).toBe(true);
  });

  it("creates the worktree under treesDir/<absolute-path> when the repo is outside HOME", async () => {
    // Mirrors the second example in the spec: a repo at
    // `/Volumes/…/example` (i.e. outside HOME) becomes
    // `<treesDir>/Volumes/…/example_<branch>`. We can't
    // actually create a repo under /Volumes from a test, so
    // we point homeDir at a *different* directory than the
    // tmpdir parent: the scanRoot path will then no longer
    // start with homeDir, exercising the non-HOME branch of
    // repoRelativeFromRoot.
    homeDir = join(tmpDir, "some-other-home");
    mkdirSync(homeDir);
    initRepo("pie");
    const h = setupConfiguredExtension({ cache: [join(scanRoot, "pie")] });
    const ctx = makeMockCtx();
    await h.pi.runCommand("worktree", "add pie my-feat", ctx);

    // tmpDir is absolute (e.g. /private/var/…/scan-root/pie),
    // so the worktree should land at
    //   <treesDir>/<tmpDir-without-leading-slash>/scan-root/pie_my-feat
    const expected = join(
      treesDir,
      tmpDir.replace(/^\//, ""),
      "scan-root",
      "pie_my-feat",
    );
    expect(existsSync(expected)).toBe(true);
  });

  it("errors when the branch already exists locally (pre-flight, git not invoked)", async () => {
    const repo = initRepo("pie");
    execSync(`git branch dup`, { cwd: repo });
    const h = setupConfiguredExtension({ cache: [repo] });
    const ctx = makeMockCtx();
    await h.pi.runCommand("worktree", "add pie dup", ctx);
    const err = ctx.ui.notifications.find((n) => n.level === "error");
    // Strong assertion: the error message must come from OUR
    // pre-flight check, not from git's own stderr. (git's
    // message would also contain "already exists" but in a
    // different format; pinning our format here means the
    // test fails if the pre-flight is removed and git is
    // allowed to be the source of the error.)
    expect(err?.msg).toBe("Branch already exists in pie: dup");
    // No worktree directory should have been created.
    expect(existsSync(join(treesDir, "scan-root", "pie_dup"))).toBe(false);
    expect(editorMock.calls).toEqual([]);
  });

  it("errors when the worktree directory already exists (pre-flight, git not invoked)", async () => {
    const repo = initRepo("pie");
    const occupied = join(treesDir, "scan-root", "pie_occupied");
    mkdirSync(occupied, { recursive: true });
    // Sentinel file: if git ran, it would refuse to clobber
    // a non-empty dir, but a buggy implementation might still
    // overwrite/move things. Either way, the file must remain.
    writeFileSync(join(occupied, "sentinel.txt"), "keep");
    const h = setupConfiguredExtension({ cache: [repo] });
    const ctx = makeMockCtx();
    await h.pi.runCommand("worktree", "add pie occupied", ctx);
    const err = ctx.ui.notifications.find((n) => n.level === "error");
    // Strong assertion: the error message must come from OUR
    // pre-flight check, not from git's own stderr.
    expect(err?.msg).toBe(`Worktree directory already exists: ${occupied}`);
    expect(existsSync(join(occupied, "sentinel.txt"))).toBe(true);
    // The branch must NOT have been created either (proves
    // git was not invoked).
    const branches = execSync("git branch --list occupied", {
      cwd: repo,
      encoding: "utf-8",
    }).trim();
    expect(branches).toBe("");
    expect(editorMock.calls).toEqual([]);
  });

  it("errors when the repo cannot be resolved", async () => {
    initRepo("pie");
    const h = setupConfiguredExtension({ cache: [join(scanRoot, "pie")] });
    const ctx = makeMockCtx();
    await h.pi.runCommand("worktree", "add no-such-repo feat", ctx);
    const err = ctx.ui.notifications.find((n) => n.level === "error");
    expect(err?.msg).toMatch(/no.*match|unknown repo/i);
    expect(editorMock.calls).toEqual([]);
  });

  it("autocompletes `add <repo>` to the full path when the leaf is ambiguous", async () => {
    // When two cached repos share a leaf name (e.g. ~/a/pie
    // and ~/b/pie), inserting just `pie` would force the
    // user to retype the full path on Enter because
    // resolveRepo cannot disambiguate. Instead each
    // ambiguous candidate inserts its full path — the user
    // picks the row whose description column shows the
    // disambiguating parent. Unique leaves still insert the
    // short leaf form (covered by the next test).
    const aPie = join(scanRoot, "alpha", "pie");
    const bPie = join(scanRoot, "beta", "pie");
    const h = setupConfiguredExtension({ cache: [aPie, bPie] });
    const items = await h.pi.argumentCompletions("worktree", "add pie");
    expect(items).not.toBeNull();
    const values = (items ?? []).map((i) => i.value);
    expect(values).toEqual(
      expect.arrayContaining([`add ${aPie} `, `add ${bPie} `]),
    );
    // Sanity: no entry inserts the bare leaf when ambiguous.
    expect(values).not.toContain("add pie ");
    // Labels still show the short leaf for readability —
    // disambiguation lives in the description column.
    expect((items ?? []).every((i) => i.label === "pie")).toBe(true);
  });

  it("keeps the bare-leaf value when the leaf is unique among ambiguous siblings", async () => {
    // Mixed scenario: `pie` is duplicated, `pox` is unique.
    // Only the duplicates should switch to full-path values;
    // pox stays as a short leaf so the common case isn't
    // penalized.
    const aPie = join(scanRoot, "alpha", "pie");
    const bPie = join(scanRoot, "beta", "pie");
    const pox = join(scanRoot, "alpha", "pox");
    const h = setupConfiguredExtension({ cache: [aPie, bPie, pox] });
    const items = await h.pi.argumentCompletions("worktree", "add p");
    expect(items).not.toBeNull();
    const byPath = new Map(
      (items ?? []).map((i) => [i.description ?? "", i.value]),
    );
    expect(byPath.get(aPie)).toBe(`add ${aPie} `);
    expect(byPath.get(bPie)).toBe(`add ${bPie} `);
    expect(byPath.get(pox)).toBe("add pox ");
  });

  it("autocompletes `add <repo>` ranking leaf matches above full-path matches", async () => {
    // Asserts ordering rather than exclusion. Asserting that
    // `queue` is *absent* from the results would be path-
    // dependent: a tmp parent containing 'p' (e.g. /tmp/)
    // makes queue's full path subseq-match the query "p".
    // Leaf matches always rank above full-path-only matches,
    // so pie (exact) and pie-incubator (leaf prefix) are
    // guaranteed to be the top 2 regardless of whether
    // queue's full path happens to subseq-match.
    const h = setupConfiguredExtension({
      cache: [
        join(scanRoot, "pie"),
        join(scanRoot, "pie-incubator"),
        join(scanRoot, "queue"),
      ],
    });
    const items = await h.pi.argumentCompletions("worktree", "add pie");
    expect(items).not.toBeNull();
    const values = (items ?? []).map((i) => i.value);
    // pie (exact leaf) ranks first; pie-incubator (leaf
    // prefix) ranks second.
    expect(values.slice(0, 2)).toEqual(["add pie ", "add pie-incubator "]);
  });
});

// ── parse-time guard ───────────────────────────────────────────────────────────────────────

describe("argument parsing happens before any repo I/O", () => {
  it("rejects an invalid branch name without touching git or the cache", async () => {
    // The extension is built with NO config and NO cache.
    // If parsing were ever reordered to run after the cache
    // lookup, this test would fail with the "no directories
    // configured" warning instead of the parse error — which
    // is the regression this test pins.
    const h = setupFreshExtension();
    const ctx = makeMockCtx();
    await h.pi.runCommand("worktree", "add pie bad..branch", ctx);
    expect(editorMock.calls).toEqual([]);
    // The would-be worktree path under the new convention
    // (treesDir / scan-root / pie_bad..branch) must not exist.
    expect(existsSync(join(treesDir, "scan-root", "pie_bad..branch"))).toBe(
      false,
    );
    const err = ctx.ui.notifications.find((n) => n.level === "error");
    expect(err?.msg).toMatch(/'\.\.'/);
  });
});

// ── /worktree remove ──────────────────────────────────────────────

describe("/worktree remove", () => {
  it("removes a worktree created by /worktree add", async () => {
    const repo = initRepo("pie");
    // Seed a worktree at the canonical trees-dir location
    // — the same place /worktree add would create it.
    const wt = join(treesDir, "scan-root", "pie_feat");
    mkdirSync(dirname(wt), { recursive: true });
    execSync(`git worktree add ${wt} -b feat`, { cwd: repo });
    expect(existsSync(wt)).toBe(true);

    const h = setupConfiguredExtension({ cache: [repo] });
    const ctx = makeMockCtx();
    await h.pi.runCommand("worktree", "remove pie feat", ctx);

    expect(existsSync(wt)).toBe(false);
    expect(
      ctx.ui.notifications.some(
        (n) => n.level !== "error" && /removed/i.test(n.msg),
      ),
    ).toBe(true);
  });

  it("reports git's error when the worktree does not exist", async () => {
    const repo = initRepo("pie");
    const h = setupConfiguredExtension({ cache: [repo] });
    const ctx = makeMockCtx();
    await h.pi.runCommand("worktree", "remove pie ghost", ctx);
    const err = ctx.ui.notifications.find((n) => n.level === "error");
    expect(err).toBeDefined();
  });

  it("autocompletes branches based on existing worktree directories", async () => {
    const repo = initRepo("pie");
    // Seed two worktrees at the canonical trees-dir layout
    // so the autocomplete (which reads that directory) sees
    // them.
    const parent = join(treesDir, "scan-root");
    mkdirSync(parent, { recursive: true });
    execSync(`git worktree add ${join(parent, "pie_alpha")} -b alpha`, {
      cwd: repo,
    });
    execSync(`git worktree add ${join(parent, "pie_beta")} -b beta`, {
      cwd: repo,
    });

    const h = setupConfiguredExtension({ cache: [repo] });
    const items = await h.pi.argumentCompletions("worktree", "remove pie ");
    expect(items).not.toBeNull();
    const values = (items ?? []).map((i) => i.value);
    expect(values).toEqual(
      expect.arrayContaining(["remove pie alpha", "remove pie beta"]),
    );
  });
});
