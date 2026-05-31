/**
 * /worktree extension — a small git worktree manager.
 *
 *   /worktree help                       show usage
 *   /worktree config                     manage scan directories
 *   /worktree add <repo> <branch>        create a new worktree
 *   /worktree remove <repo> <branch>     remove an existing worktree
 *
 * On first run (no configured directories) the user is taken
 * straight into the config flow. Subsequent runs load repository
 * paths from a JSON cache and trigger a background re-scan to
 * keep the cache fresh.
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";
import type {
  AutocompleteItem,
  Component,
  EditorTheme,
  Focusable,
  TUI,
} from "@earendil-works/pi-tui";
import {
  CombinedAutocompleteProvider,
  Editor,
  Text,
  Key,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { parseWorktreeArgs, SUBCOMMANDS } from "./parse.js";
import {
  createConfigStore,
  expandHome,
  type ConfigStore,
} from "./config-store.js";
import { createRepoCache, type RepoCache } from "./cache.js";
import { scanRepos, validateConfigDir } from "./scan.js";
import { fuzzyMatchRepos, repoLeaf } from "./fuzzy.js";
import {
  DEFAULT_DATA_DIR,
  treesDirIn,
  worktreeAbsolutePath,
  type PathContext,
} from "./paths.js";
import {
  createWorktree,
  type GitResult,
  listExistingWorktreeBranches,
  localBranchExists,
  removeWorktree,
} from "./git.js";
import { homedir } from "node:os";
import { openInEditor } from "./editor.js";

// ── pi API surface ─────────────────────────────────────────────────

// Only the surface we actually use. If the extension grows to
// listen for events, add `"on"` here — the mock pi in tests
// will then need to satisfy the overloaded `on` shape.
export type WorktreePi = Pick<ExtensionAPI, "registerCommand">;

export interface WorktreeExtensionOptions {
  configStore?: ConfigStore;
  cache?: RepoCache;
  /**
   * Path context (treesDir + homeDir). Defaults to the real
   * user's home + `~/.local/share/worktree-pi/trees`. Tests
   * override this to keep all I/O inside their tmpdir.
   */
  paths?: PathContext;
}

export default function (pi: ExtensionAPI) {
  return createExtension(pi);
}

export function createExtension(
  pi: WorktreePi,
  options: WorktreeExtensionOptions = {},
) {
  const configStore = options.configStore ?? createConfigStore();
  const cache = options.cache ?? createRepoCache();
  const paths: PathContext = options.paths ?? {
    treesDir: treesDirIn(DEFAULT_DATA_DIR),
    homeDir: homedir(),
  };

  // In-memory snapshot of the most recent repo list. Updated
  // synchronously by a fresh scan and asynchronously by the
  // background refresh kicked off on extension load.
  let repos: string[] = cache.load()?.repos ?? [];

  /**
   * Re-scan and update both memory and the on-disk cache.
   *
   * `notifyError` is required — every caller has a place to
   * report errors (the user's UI for foreground calls, the
   * deferred `backgroundError` channel for the load-time
   * scan), and silently dropping per-directory failures is
   * exactly the bug we fixed in an earlier pass. Callers that
   * truly want to discard errors must opt in by passing a
   * no-op explicitly so the choice is visible in the source.
   */
  function rescanAndCache(notifyError: (msg: string) => void): void {
    const dirs = configStore.list();
    if (dirs.length === 0) {
      repos = [];
      cache.save([]);
      return;
    }
    const result = scanRepos(dirs);
    repos = result.repos;
    cache.save(result.repos);
    if (result.errors.length > 0) {
      const summary = result.errors
        .map((e) => `${e.dir}: ${e.message}`)
        .join("\n");
      notifyError(`Scan errors:\n${summary}`);
    }
  }

  // Errors from the background re-scan are stashed here and
  // surfaced the next time the user invokes a /worktree
  // command. We can't `notify` from a microtask because there
  // is no `ctx` outside a handler.
  let backgroundError: string | null = null;

  if (configStore.list().length > 0) {
    queueMicrotask(() => {
      try {
        // Route per-directory scan errors into the same deferred
        // channel as top-level exceptions — otherwise a single
        // unreadable scan dir would be lost. AGENTS.md tenet:
        // all caught errors must be reported.
        rescanAndCache((msg) => {
          backgroundError = backgroundError
            ? `${backgroundError}\n${msg}`
            : msg;
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        backgroundError = backgroundError ? `${backgroundError}\n${msg}` : msg;
      }
    });
  }

  pi.registerCommand("worktree", {
    description:
      "/worktree help|config|add <repo> <branch>|remove <repo> <branch>",
    getArgumentCompletions: (prefix) => {
      return getCompletions(prefix, repos, paths);
    },
    handler: async (args, ctx) => {
      if (backgroundError) {
        ctx.ui.notify(`Background scan failed: ${backgroundError}`, "warning");
        backgroundError = null;
      }

      const parsed = parseWorktreeArgs(args);

      // Parse-time errors fire before any config / I/O check
      // so the user sees the actual problem with their
      // arguments, not an unrelated "first-run" prompt.
      if (parsed.kind === "invalid") {
        ctx.ui.notify(parsed.reason, "error");
        return;
      }

      // Open the config UI then re-scan, surfacing any per-dir
      // scan errors back through ctx.ui as warnings. Used for
      // both an explicit `/worktree config` and the first-run
      // auto-redirect.
      const openConfigAndRescan = async () => {
        await runConfigUi(ctx, configStore);
        rescanAndCache((m) => ctx.ui.notify(m, "warning"));
      };

      // First-run auto-redirect: any /worktree invocation
      // (including no-args and `help`) jumps straight into
      // the config UI when no directories have been
      // configured yet. Printing a usage block that just
      // tells the user to run `/worktree config` would force
      // a second command for no benefit.
      if (configStore.list().length === 0) {
        if (parsed.kind === "add" || parsed.kind === "remove") {
          // Preserve the explicit warning for add/remove so
          // the user understands why the operation didn't
          // run — their `add <repo> <branch>` arguments are
          // dropped on the floor when we redirect.
          ctx.ui.notify(
            "No directories configured. Run /worktree config to add one.",
            "warning",
          );
        }
        await openConfigAndRescan();
        return;
      }

      if (parsed.kind === "usage") {
        ctx.ui.notify(usageText(), "info");
        return;
      }
      if (parsed.kind === "config") {
        await openConfigAndRescan();
        return;
      }

      if (parsed.kind === "add") {
        await runAdd(ctx, repos, parsed.repo, parsed.branch, paths);
        return;
      }
      if (parsed.kind === "remove") {
        await runRemove(ctx, repos, parsed.repo, parsed.branch, paths);
        return;
      }
    },
  });
}

// ── usage ──────────────────────────────────────────────────────────

function usageText(): string {
  return [
    "Usage:",
    "  /worktree help",
    "  /worktree config",
    "  /worktree add <repo> <branch>",
    "  /worktree remove <repo> <branch>",
  ].join("\n");
}

// ── argument autocompletion ────────────────────────────────────────

/**
 * Public for testing: derive autocomplete items for a `/worktree`
 * argument prefix. Values are returned in the form the runtime
 * expects (the entire post-slash text), so e.g. completing repo
 * for `add p` yields `add pie ` (note trailing space, ready for
 * the branch name).
 */
export function getCompletions(
  prefix: string,
  repos: string[],
  paths: PathContext,
): AutocompleteItem[] | null {
  // First token: subcommand
  if (!prefix.includes(" ")) {
    const subs = SUBCOMMANDS.filter((s) => s.startsWith(prefix));
    return subs.map((s) => ({
      value: s,
      label: s,
      description: subDescription(s),
    }));
  }

  const parts = prefix.split(/\s+/);
  const sub = parts[0];

  if ((sub === "add" || sub === "remove") && parts.length === 2) {
    const repoQuery = parts[1] ?? "";
    const matches = fuzzyMatchRepos(repoQuery, repos);
    // Hybrid value strategy: insert the short leaf when it
    // uniquely identifies the repo, otherwise insert the full
    // path so the picked item is unambiguously resolvable
    // without the user having to retype anything. Counts are
    // computed across the full `repos` set (not just the
    // filtered matches) because resolveRepo's ambiguity
    // check also runs against the full set — they have to
    // agree, or the user could pick `pie` from a single-row
    // dropdown that's nonetheless ambiguous against an
    // unfiltered repo elsewhere in the cache.
    const leafCounts = new Map<string, number>();
    for (const r of repos) {
      const l = repoLeaf(r);
      leafCounts.set(l, (leafCounts.get(l) ?? 0) + 1);
    }
    return matches.map((repo) => {
      const leaf = repoLeaf(repo);
      const ambiguous = (leafCounts.get(leaf) ?? 0) > 1;
      const inserted = ambiguous ? repo : leaf;
      return {
        value: `${sub} ${inserted} `,
        label: leaf,
        description: repo,
      };
    });
  }

  if (sub === "remove" && parts.length === 3) {
    const repoQuery = parts[1] ?? "";
    const branchQuery = parts[2] ?? "";
    const matched = fuzzyMatchRepos(repoQuery, repos);
    const repoPath = matched[0];
    if (!repoPath) return null;
    let branches: string[];
    try {
      branches = listExistingWorktreeBranches(repoPath, paths);
    } catch (err) {
      // Autocompletion has no UI context to surface a
      // notification, so log instead of silently dropping the
      // error (per AGENTS.md — errors must be reported
      // somewhere). Returning null tells the runtime to fall
      // back to no completions; the user can still type the
      // branch name manually and runRemove will report the
      // real error from git.
      console.error(
        `[/worktree] failed to list worktrees in ${repoPath}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
    const filtered = branches.filter((b) => b.startsWith(branchQuery));
    return filtered.map((b) => ({
      value: `remove ${repoLeaf(repoPath)} ${b}`,
      label: b,
      description: `worktree of ${repoLeaf(repoPath)}`,
    }));
  }

  return null;
}

function subDescription(sub: string): string {
  switch (sub) {
    case "help":
      return "show /worktree usage";
    case "config":
      return "add or remove scanned directories";
    case "add":
      return "create a new worktree";
    case "remove":
      return "remove an existing worktree";
    default:
      return "";
  }
}

// ── repo resolution ────────────────────────────────────────────────

/**
 * Resolve a user-supplied repo string to an absolute repo path.
 * The user typically types just the repo leaf (`pie`); we accept
 * an exact leaf match, a unique fuzzy leaf match, or an exact
 * full-path match. Ambiguity returns an error string.
 */
export function resolveRepo(
  query: string,
  repos: string[],
): { ok: true; repoPath: string } | { ok: false; error: string } {
  // Exact full-path match wins.
  const exactPath = repos.find((r) => r === query);
  if (exactPath) return { ok: true, repoPath: exactPath };

  // Exact leaf match.
  const exactLeaf = repos.filter((r) => repoLeaf(r) === query);
  if (exactLeaf.length === 1) return { ok: true, repoPath: exactLeaf[0] };
  if (exactLeaf.length > 1) {
    return {
      ok: false,
      error: `Ambiguous repo '${query}': matches ${exactLeaf.length} paths (${exactLeaf.join(", ")})`,
    };
  }

  // Fall back to fuzzy match — accept only when there's a single
  // top-ranked candidate that strictly contains the query in its
  // leaf, to avoid silently picking arbitrary paths.
  const ranked = fuzzyMatchRepos(query, repos);
  const leafContains = ranked.filter((r) =>
    repoLeaf(r).toLowerCase().includes(query.toLowerCase()),
  );
  if (leafContains.length === 1) return { ok: true, repoPath: leafContains[0] };

  if (ranked.length === 0)
    return { ok: false, error: `No repo matches '${query}'` };
  return {
    ok: false,
    error: `Ambiguous repo '${query}': matches ${ranked
      .slice(0, 5)
      .map(repoLeaf)
      .join(", ")}${ranked.length > 5 ? ", …" : ""}`,
  };
}

// ── shared add/remove plumbing ─────────────────────────────────────

/**
 * Resolve a repo query, notifying the caller's UI on failure.
 * Returns the resolved absolute repo path, or `null` if the
 * query was unresolvable (in which case an error notification
 * has already been emitted). Centralized so add/remove handle
 * resolution failures identically.
 */
function resolveRepoOrNotify(
  ctx: ExtensionCommandContext,
  repos: string[],
  query: string,
): string | null {
  const resolution = resolveRepo(query, repos);
  if (resolution.ok === false) {
    ctx.ui.notify(resolution.error, "error");
    return null;
  }
  return resolution.repoPath;
}

/**
 * Standard error notification for a failed `git worktree X`
 * invocation. Formatted in one place so add/remove stay in
 * sync if we ever change the wording or include more detail.
 */
function notifyGitFailure(
  ctx: ExtensionCommandContext,
  verb: "add" | "remove",
  result: GitResult,
): void {
  ctx.ui.notify(
    `git worktree ${verb} failed (exit ${result.code ?? "?"}): ${result.output}`,
    "error",
  );
}

// ── add ────────────────────────────────────────────────────────────

async function runAdd(
  ctx: ExtensionCommandContext,
  repos: string[],
  repoQuery: string,
  branch: string,
  paths: PathContext,
): Promise<void> {
  // Branch-name validation already happened in parseWorktreeArgs;
  // not duplicated here.
  const repoPath = resolveRepoOrNotify(ctx, repos, repoQuery);
  if (!repoPath) return;

  // Pre-flight: branch already exists locally.
  if (localBranchExists(repoPath, branch)) {
    ctx.ui.notify(
      `Branch already exists in ${basename(repoPath)}: ${branch}`,
      "error",
    );
    return;
  }

  // Pre-flight: target worktree directory already exists.
  const target = worktreeAbsolutePath(repoPath, branch, paths);
  if (existsSync(target)) {
    ctx.ui.notify(`Worktree directory already exists: ${target}`, "error");
    return;
  }

  const result = createWorktree({ repoPath, branch, paths });
  if (!result.git.ok) {
    notifyGitFailure(ctx, "add", result.git);
    return;
  }

  ctx.ui.notify(`Created ${result.worktreePath} (branch ${branch})`, "info");

  const opened = openInEditor(result.worktreePath);
  if (!opened.ok) {
    ctx.ui.notify(
      `Editor (${opened.attempted}) failed: ${opened.error ?? "unknown error"}`,
      "warning",
    );
  }
}

// ── remove ─────────────────────────────────────────────────────────

async function runRemove(
  ctx: ExtensionCommandContext,
  repos: string[],
  repoQuery: string,
  branch: string,
  paths: PathContext,
): Promise<void> {
  const repoPath = resolveRepoOrNotify(ctx, repos, repoQuery);
  if (!repoPath) return;

  const target = worktreeAbsolutePath(repoPath, branch, paths);
  if (!existsSync(target)) {
    ctx.ui.notify(`Worktree directory does not exist: ${target}`, "error");
    return;
  }

  const result = removeWorktree({ repoPath, branch, paths });
  if (!result.git.ok) {
    notifyGitFailure(ctx, "remove", result.git);
    return;
  }
  ctx.ui.notify(`Removed worktree: ${result.worktreePath}`, "info");
}

// ── config UI ─────────────────────────────────────────────────────

/**
 * Show the interactive config UI: a list of currently
 * configured directories plus an Input for adding a new one.
 *
 * Keys (per AGENTS.md keybinding rules):
 *   Enter   submit the input (add a directory)
 *   Esc     dismiss the UI
 *   d       delete the highlighted directory
 *   Up/Down move highlight in the directory list
 *
 * Resolves once the user dismisses the UI.
 */
export async function runConfigUi(
  ctx: ExtensionCommandContext,
  store: ConfigStore,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    return createConfigComponent(tui, theme, store, ctx, done);
  });
}

interface ConfigComponentDeps {
  store: ConfigStore;
  notify: (msg: string, level?: "info" | "warning" | "error") => void;
}

function createConfigComponent(
  tui: TUI,
  theme: Theme,
  store: ConfigStore,
  ctx: ExtensionCommandContext,
  done: (v: void) => void,
): Component & Focusable & { dispose?(): void } {
  const deps: ConfigComponentDeps = {
    store,
    notify: (msg, level) => ctx.ui.notify(msg, level),
  };
  return new ConfigComponent(tui, theme, deps, done);
}

class ConfigComponent implements Component, Focusable {
  // Focus propagation: when the host changes focus on this
  // container, forward it to the embedded Editor so its IME
  // candidate window appears in the right place. (See the
  // "Propagate Focusable for IME Support" gotcha in the
  // extension-dev-guide skill.)
  private _focused = true;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    if (this.editor) this.editor.focused = value;
  }
  private editor!: Editor;
  private text: Text;
  private cursor = 0;
  private busy = false;
  private message = "";

  constructor(
    private tui: TUI,
    private theme: Theme,
    private deps: ConfigComponentDeps,
    private done: (v: void) => void,
  ) {
    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (s) => theme.fg("accent", s),
        selectedText: (s) => theme.fg("accent", s),
        description: (s) => theme.fg("dim", s),
        scrollInfo: (s) => theme.fg("dim", s),
        noMatch: (s) => theme.fg("dim", s),
      },
    };
    this.editor = new Editor(tui, editorTheme, { paddingX: 1 });
    this.editor.focused = this._focused;
    // Path completion only — no slash commands to surface here.
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider([], process.cwd()),
    );
    this.editor.onSubmit = (text) => {
      void this.handleSubmit(text);
    };
    this.text = new Text("", 0, 0);
    this.refresh();
  }

  invalidate(): void {
    this.editor.invalidate();
    this.text.invalidate();
  }

  private async handleSubmit(raw: string): Promise<void> {
    const value = raw.trim();
    if (!value) return;
    if (this.busy) return;
    this.busy = true;
    try {
      const expanded = expandHome(value);
      const error = validateConfigDir(expanded);
      if (error) {
        this.deps.notify(`${expanded}: ${error}`, "error");
        this.message = `error: ${error}`;
        return;
      }
      const added = this.deps.store.add(expanded);
      this.message = added
        ? `Added ${expanded}`
        : `Already configured: ${expanded}`;
      this.editor.setText("");
    } finally {
      this.busy = false;
      this.refresh();
      this.tui.requestRender();
    }
  }

  private refresh(): void {
    const dirs = this.deps.store.list();
    if (this.cursor >= dirs.length) this.cursor = Math.max(0, dirs.length - 1);
    const lines: string[] = [];
    lines.push(
      this.theme.bold(
        this.theme.fg("accent", "/worktree config — directories to scan"),
      ),
    );
    lines.push(
      this.theme.fg(
        "dim",
        "enter: add  d: delete highlighted  ↑/↓: navigate  esc: done",
      ),
    );
    if (this.message) lines.push(this.theme.fg("dim", this.message));
    lines.push("");
    if (dirs.length === 0) {
      lines.push(this.theme.fg("dim", "  (no directories configured)"));
    } else {
      for (let i = 0; i < dirs.length; i++) {
        const prefix = i === this.cursor ? "▸ " : "  ";
        const line = `${prefix}${dirs[i]}`;
        lines.push(i === this.cursor ? this.theme.fg("accent", line) : line);
      }
    }
    lines.push("");
    lines.push(this.theme.fg("dim", "Add a directory:"));
    this.text.setText(lines.join("\n"));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      // Editor's escape may close the autocomplete dropdown first;
      // we let it handle escape in that case. When the editor is
      // idle (empty + no autocomplete open), escape dismisses.
      if (this.editor.getText().length === 0) {
        this.done();
        return;
      }
    }
    // Up/Down navigate the saved-dirs list above the editor,
    // BUT only when the editor's autocomplete dropdown is
    // closed. When the user has Tab-opened the path-completion
    // dropdown the same keys must navigate that dropdown —
    // otherwise they're stuck on the first suggestion. The
    // editor itself routes Up/Down to its dropdown when one
    // is open, so we just forward the input in that case.
    if (matchesKey(data, Key.up) && !this.editor.isShowingAutocomplete()) {
      if (this.cursor > 0) this.cursor--;
      this.refresh();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) && !this.editor.isShowingAutocomplete()) {
      const dirs = this.deps.store.list();
      if (this.cursor < dirs.length - 1) this.cursor++;
      this.refresh();
      this.tui.requestRender();
      return;
    }
    if (this.editor.getText().length === 0 && matchesKey(data, "d")) {
      const dirs = this.deps.store.list();
      const target = dirs[this.cursor];
      if (target) {
        this.deps.store.remove(target);
        this.message = `Removed ${target}`;
        this.refresh();
        this.tui.requestRender();
      }
      return;
    }
    this.editor.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    this.refresh();
    const top = this.text.render(width);
    const bottom = this.editor.render(width);
    return [...top, ...bottom].map((l) => truncateToWidth(l, width));
  }
}
