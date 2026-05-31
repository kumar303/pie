/**
 * /update-pr-description <github-pr-url>
 *
 * Fetches the PR description via `gh`, stores the original in a temp work
 * directory, asks the agent to produce an updated version, shows a
 * `delta`-rendered diff in a confirmation dialog, and either copies the
 * accepted result to the clipboard or lets the agent iterate via a
 * registered tool.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { exec as execCb } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface UpdatePrDeps {
  exec(
    cmd: string,
    args: string[],
    opts?: { input?: string; cwd?: string },
  ): Promise<ExecResult>;
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  readFile(path: string): Promise<string>;
  /**
   * Show an editable prompt to the user. Resolves to the edited text on
   * submit, or `undefined` if the user aborts. The implementation should
   * place the cursor at the top of the prefilled content (not the end).
   */
  editPrompt(
    ctx: { ui: MockUi },
    title: string,
    prefill: string,
  ): Promise<string | undefined>;
}

export interface CustomOptions {
  overlay?: boolean;
  overlayOptions?: {
    maxHeight?: string | number;
    width?: string | number;
    [key: string]: unknown;
  };
}

export interface DiffViewerTheme {
  bold: (s: string) => string;
  fg: (k: string, s: string) => string;
}

export interface DiffViewerTui {
  requestRender: () => void;
}

export interface MockUi {
  notify(msg: string, level: "info" | "warning" | "error"): void;
  confirm(title: string, body?: string): Promise<boolean>;
  custom<T>(fn: unknown, options?: CustomOptions): Promise<T>;
}

interface Session {
  tmpDir: string;
  originalPath: string;
  currentPath: string;
}

export interface MinimalPi {
  registerCommand(
    name: string,
    config: {
      description: string;
      handler: (args: string, ctx: unknown) => Promise<void> | void;
      getArgumentCompletions?: (
        prefix: string,
      ) => Array<{ value: string; label: string }>;
    },
  ): void;
  registerTool(def: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;
  }): void;
  sendUserMessage(content: string, options?: unknown): void;
}

// ── Prompt ───────────────────────────────────────────────────────────

export function buildUpdatePrompt(oldContent: string): string {
  return `Update the GitHub PR description below to reflect the latest changes on this branch. Be careful with your edit. Only change existing content if it's inaccurate or out of date. Wrap any newly added content in <details> tags. Do not list tests or files changed.

When your rewrite is ready, submit it by calling the \`update_pr_description\` tool with the complete new markdown in the \`new_content\` argument. Do not print the markdown in chat, do not write it to any other file, and do not use a different tool to update the PR.

The existing PR description to edit is delimited by the markers below. Everything between the markers — and only that content — is editable.

----- BEGIN PR DESCRIPTION -----
${oldContent}
----- END PR DESCRIPTION -----`;
}

// ── Default deps (real system) ───────────────────────────────────────

function defaultDeps(): UpdatePrDeps {
  return {
    exec: (cmd, args, opts) =>
      new Promise<ExecResult>((resolve) => {
        const child = execCb(
          [cmd, ...args.map(shellEscape)].join(" "),
          { cwd: opts?.cwd, maxBuffer: 50 * 1024 * 1024 },
          (err, stdout, stderr) => {
            const out =
              typeof stdout === "string" ? stdout : String(stdout ?? "");
            const errStr =
              typeof stderr === "string" ? stderr : String(stderr ?? "");
            const code = err as (Error & { code?: number }) | null;
            resolve({
              stdout: out,
              stderr: errStr,
              exitCode:
                code && typeof code.code === "number"
                  ? code.code
                  : code
                    ? 1
                    : 0,
            });
          },
        );
        if (opts?.input !== undefined) {
          child.stdin?.write(opts.input);
          child.stdin?.end();
        }
      }),
    mkdtemp: (prefix) => mkdtemp(join(tmpdir(), prefix)),
    writeFile: (p, d) => writeFile(p, d, "utf8"),
    readFile: (p) => readFile(p, "utf8"),
    editPrompt: defaultEditPrompt,
  };
}

/**
 * Default prompt editor: uses `ExtensionEditorComponent` via `ui.custom`
 * so we can move the cursor to the top of the prefilled text before the
 * editor is shown. (`ui.editor()` puts the cursor at the end, which
 * causes the view to scroll to the bottom on long prompts.)
 */
async function defaultEditPrompt(
  ctx: { ui: MockUi },
  title: string,
  prefill: string,
): Promise<string | undefined> {
  // Load pi-coding-agent lazily so tests and non-TUI contexts don't hard-
  // depend on it. Any failure falls back to the simple ui.editor() dialog.
  let ExtensionEditorComponent: new (
    tui: unknown,
    keybindings: unknown,
    title: string,
    prefill: string | undefined,
    onSubmit: (value: string) => void,
    onCancel: () => void,
  ) => unknown;
  try {
    const mod =
      (await import("@earendil-works/pi-coding-agent")) as unknown as {
        ExtensionEditorComponent: typeof ExtensionEditorComponent;
      };
    ExtensionEditorComponent = mod.ExtensionEditorComponent;
    if (!ExtensionEditorComponent) throw new Error("missing export");
  } catch (err) {
    ctx.ui.notify(
      `Could not load ExtensionEditorComponent (${
        err instanceof Error ? err.message : String(err)
      }); falling back to default editor dialog.`,
      "warning",
    );
    const ui = ctx.ui as MockUi & {
      editor?: (title: string, prefill?: string) => Promise<string | undefined>;
    };
    if (typeof ui.editor !== "function") return undefined;
    return ui.editor(title, prefill);
  }

  return ctx.ui.custom<string | undefined>(
    (
      tui: unknown,
      _theme: unknown,
      keybindings: unknown,
      done: (v: string | undefined) => void,
    ) => {
      const component = new ExtensionEditorComponent(
        tui,
        keybindings,
        title,
        prefill,
        (value) => done(value),
        () => done(undefined),
      ) as {
        editor?: {
          state?: {
            cursorLine?: number;
            cursorCol?: number;
          };
          scrollOffset?: number;
        };
      };
      // Move cursor to top of prefilled content so the editor scrolls
      // to the top instead of the bottom. We reach into the private
      // `editor` field because the underlying Editor exposes no public
      // API to move the cursor. This is fragile (breaks if pi-tui
      // renames the internals) but it is the only option today.
      const inner = component.editor;
      if (inner?.state) {
        inner.state.cursorLine = 0;
        inner.state.cursorCol = 0;
        inner.scrollOffset = 0;
      }
      return component as unknown as {
        render: (w: number) => string[];
        invalidate: () => void;
        handleInput: (data: string) => void;
      };
    },
  );
}

/**
 * Parse the output of `gh pr view --json body,url`.
 *
 * For backward compatibility we also accept a raw body string (the
 * previous format, produced by `--jq .body`). In that case the URL is
 * undefined.
 */
export function parseGhPrView(stdout: string): {
  body: string;
  url: string | undefined;
  parseWarning: string | undefined;
} {
  const trimmed = stdout.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        body?: unknown;
        url?: unknown;
      };
      return {
        body: typeof parsed.body === "string" ? parsed.body : "",
        url: typeof parsed.url === "string" ? parsed.url : undefined,
        parseWarning: undefined,
      };
    } catch (err) {
      return {
        body: stdout,
        url: undefined,
        parseWarning: `gh output looks like JSON but failed to parse: ${err instanceof Error ? err.message : err}`,
      };
    }
  }
  return { body: stdout, url: undefined, parseWarning: undefined };
}

function shellEscape(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_\-./:=@]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ── Extension factory (testable) ────────────────────────────────────

const SUBCOMMANDS = ["copy"] as const;

export function createExtension(
  pi: MinimalPi,
  deps: UpdatePrDeps = defaultDeps(),
): void {
  let session: Session | null = null;
  // Path of the most recently accepted current.md. Survives session
  // clearing so `/update-pr-description copy` can re-copy after an accept.
  let lastAcceptedPath: string | null = null;

  pi.registerCommand("update-pr-description", {
    description:
      "Automatically update a GitHub PR description; preview and approve all changes",
    getArgumentCompletions: (prefix: string) =>
      SUBCOMMANDS.filter((c) => c.startsWith(prefix)).map((c) => ({
        value: c,
        label: c,
      })),
    handler: async (args, rawCtx) => {
      const ctx = rawCtx as {
        ui: MockUi;
        cwd?: string;
        hasUI?: boolean;
      };

      if (args.trim() === "copy") {
        await handleCopy(ctx);
        return;
      }

      // Discover the PR for the current branch via gh.
      const ghResult = await deps.exec(
        "gh",
        ["pr", "view", "--json", "body,url"],
        { cwd: ctx.cwd },
      );
      if (ghResult.exitCode !== 0) {
        const msg =
          ghResult.stderr.trim() || `gh exited with code ${ghResult.exitCode}`;
        ctx.ui.notify(`Failed to fetch PR: ${msg}`, "error");
        return;
      }
      const {
        body: originalBody,
        url: prUrl,
        parseWarning,
      } = parseGhPrView(ghResult.stdout);
      if (parseWarning) ctx.ui.notify(parseWarning, "warning");

      // Create temp workdir and stash files.
      const tmpDir = await deps.mkdtemp("pi-update-pr-");
      const originalPath = join(tmpDir, "original.md");
      const currentPath = join(tmpDir, "current.md");
      await deps.writeFile(originalPath, normalizeForDiff(originalBody));
      await deps.writeFile(currentPath, normalizeForDiff(originalBody));

      session = {
        tmpDir,
        originalPath,
        currentPath,
      };

      ctx.ui.notify(
        `Fetched PR description (${originalBody.length} chars). Review the prompt before sending…`,
        "info",
      );

      const title = prUrl
        ? `Tell the agent how to update your PR description \u2022 ${prUrl}`
        : "Tell the agent how to update your PR description";
      const edited = await deps.editPrompt(
        ctx,
        title,
        buildUpdatePrompt(originalBody),
      );
      if (edited === undefined) {
        ctx.ui.notify("Aborted: no prompt sent.", "info");
        return;
      }

      pi.sendUserMessage(edited, { deliverAs: "followUp" });
    },
  });

  async function handleCopy(ctx: { ui: MockUi }): Promise<void> {
    const path = session?.currentPath ?? lastAcceptedPath;
    if (!path) {
      ctx.ui.notify(
        "No PR description to copy. Run /update-pr-description first.",
        "error",
      );
      return;
    }
    const content = await deps.readFile(path);
    const pb = await deps.exec("pbcopy", [], { input: content });
    if (pb.exitCode !== 0) {
      const msg = pb.stderr.trim() || `pbcopy exited with code ${pb.exitCode}`;
      ctx.ui.notify(`Failed to copy to clipboard: ${msg}`, "error");
      return;
    }
    ctx.ui.notify(
      `Copied PR description (${content.length} chars) to the clipboard.`,
      "info",
    );
  }

  pi.registerTool({
    name: "update_pr_description",
    label: "Update PR Description",
    description:
      "Write the updated PR description markdown to disk and show the user a diff. If the user accepts, the content is copied to the clipboard. If not, they can ask for more changes — call this tool again with the revised content.",
    parameters: Type.Object({
      new_content: Type.String({
        description: "The complete new PR description markdown",
      }),
    }),
    async execute(_toolCallId, rawParams, _signal, _onUpdate, rawCtx) {
      if (!session) {
        throw new Error(
          "No active /update-pr-description session. The user must run /update-pr-description first.",
        );
      }
      const params = rawParams as { new_content: string };
      const ctx = rawCtx as { ui: MockUi };

      await deps.writeFile(
        session.currentPath,
        normalizeForDiff(params.new_content),
      );

      const diffResult = await deps.exec("diff", [
        "-u",
        session.originalPath,
        session.currentPath,
      ]);

      if (diffResult.exitCode === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No changes detected — the PR description is already up to date.",
            },
          ],
        };
      }

      const deltaResult = await deps.exec("delta", ["--paging=never"], {
        input: diffResult.stdout,
      });
      const diffText =
        deltaResult.stdout ||
        deltaResult.stderr ||
        "(no diff output from delta)";

      const accepted = await showDiffAndConfirm(ctx.ui, diffText);

      if (accepted) {
        await deps.exec("pbcopy", [], {
          input: normalizeForDiff(params.new_content),
        });
        const clearedSession = session;
        lastAcceptedPath = clearedSession.currentPath;
        session = null;
        return {
          content: [
            {
              type: "text",
              text: `User accepted the updated PR description. Contents of ${clearedSession.currentPath} were copied to the clipboard. Do not make further changes.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: "User rejected the updated PR description. Wait for the user's feedback before calling this tool again with revised content.",
          },
        ],
      };
    },
  });
}

/**
 * Render the diff inside a custom TUI component and ask the user
 * whether to accept it. Keeps the TUI integration out of the exported
 * factory so tests can substitute a mock `ui.custom`.
 */
function normalizeForDiff(s: string): string {
  return s.replace(/\r\n/g, "\n").trim() + "\n";
}

const DIFF_VIEW_MAX_LINES = 30;
const DIFF_VIEW_PADDING = 2;
const DOWN_ARROW = "\x1b[B";
const UP_ARROW = "\x1b[A";

async function showDiffAndConfirm(ui: MockUi, diff: string): Promise<boolean> {
  // Load pi-tui via dynamic import so the type-only top-level reference
  // never forces a runtime dependency on the peer package. Only the
  // import itself is guarded — any error from the render factory or
  // `ui.custom` is a real bug and must propagate to the caller.
  let tui: typeof import("@earendil-works/pi-tui");
  try {
    tui = await import("@earendil-works/pi-tui");
  } catch (err) {
    ui.notify(
      `Could not load @earendil-works/pi-tui (${
        err instanceof Error ? err.message : String(err)
      }); falling back to a plain confirm dialog.`,
      "warning",
    );
    return ui.confirm("Accept updated PR description?");
  }

  const { truncateToWidth, wrapTextWithAnsi, matchesKey } = tui;
  return ui.custom<boolean>(
    (
      tuiHandle: unknown,
      theme: unknown,
      _kb: unknown,
      done: (v: boolean) => void,
    ) => {
      const tui = tuiHandle as DiffViewerTui;
      const t = theme as DiffViewerTheme;
      const rawDiffLines = diff.split("\n");
      let scrollOffset = 0;
      // Initialize from rawDiffLines so scroll keys work before the first render.
      let maxScroll = Math.max(0, rawDiffLines.length - DIFF_VIEW_MAX_LINES);

      return {
        render: (w: number) => {
          const pad = " ".repeat(DIFF_VIEW_PADDING);
          const innerWidth = w - DIFF_VIEW_PADDING * 2;

          // wrapTextWithAnsi preserves ANSI escape codes from delta's colored output.
          const diffLines = rawDiffLines.flatMap((line) => {
            const wrapped = wrapTextWithAnsi(line, innerWidth);
            return wrapped.length > 0 ? wrapped : [""];
          });
          maxScroll = Math.max(0, diffLines.length - DIFF_VIEW_MAX_LINES);
          if (scrollOffset > maxScroll) scrollOffset = maxScroll;

          const visibleLines = diffLines.slice(
            scrollOffset,
            scrollOffset + DIFF_VIEW_MAX_LINES,
          );
          const output: string[] = [];

          for (let i = 0; i < DIFF_VIEW_PADDING; i++) output.push("");

          for (const line of visibleLines) {
            output.push(pad + truncateToWidth(line, innerWidth));
          }

          if (diffLines.length > DIFF_VIEW_MAX_LINES) {
            const pos =
              maxScroll > 0 ? Math.round((scrollOffset / maxScroll) * 100) : 0;
            output.push(
              pad +
                truncateToWidth(
                  t.fg("muted", `── ${pos}% ── ↑/↓ scroll ──`),
                  innerWidth,
                ),
            );
          }

          output.push(
            pad +
              truncateToWidth(
                t.bold(
                  t.fg(
                    "accent",
                    "enter:accept  esc:reject  ↑/↓:scroll  d/u:page  g/G:top/bottom",
                  ),
                ),
                innerWidth,
              ),
          );

          for (let i = 0; i < DIFF_VIEW_PADDING; i++) output.push("");

          return output;
        },
        invalidate: () => {},
        handleInput: (data: string) => {
          if (matchesKey(data, "escape")) {
            done(false);
            return;
          }
          if (matchesKey(data, "return")) {
            done(true);
            return;
          }
          if (data === DOWN_ARROW || matchesKey(data, "j")) {
            if (scrollOffset < maxScroll) {
              scrollOffset++;
              tui.requestRender();
            }
            return;
          }
          if (data === UP_ARROW || matchesKey(data, "k")) {
            if (scrollOffset > 0) {
              scrollOffset--;
              tui.requestRender();
            }
            return;
          }
          if (matchesKey(data, "g")) {
            scrollOffset = 0;
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "shift+g")) {
            scrollOffset = maxScroll;
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "d")) {
            scrollOffset = Math.min(
              maxScroll,
              scrollOffset + DIFF_VIEW_MAX_LINES,
            );
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "u")) {
            scrollOffset = Math.max(0, scrollOffset - DIFF_VIEW_MAX_LINES);
            tui.requestRender();
            return;
          }
        },
      };
    },
    {
      overlay: true,
      overlayOptions: { width: "90%", maxHeight: "90%" },
    },
  );
}

// ── Pi entrypoint ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  createExtension(pi as unknown as MinimalPi);
}

// Re-export for compatibility with test imports
export type { ExtensionCommandContext, ExtensionContext };
