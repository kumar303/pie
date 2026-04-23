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
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
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
}

export interface MockUi {
  notify(msg: string, level: "info" | "warning" | "error"): void;
  confirm(title: string, body?: string): Promise<boolean>;
  custom<T>(fn: unknown): Promise<T>;
}

interface Session {
  tmpDir: string;
  originalPath: string;
  currentPath: string;
}

interface MinimalPi {
  registerCommand(
    name: string,
    config: {
      description: string;
      handler: (args: string, ctx: unknown) => Promise<void> | void;
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
  return `Update the GitHub PR description below to reflect the latest changes on this branch. Be careful with your edit. Only change existing content if it's inaccurate or out of date. Wrap any newly added content in <details> tags.

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
  };
}

function shellEscape(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_\-./:=@]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ── Extension factory (testable) ────────────────────────────────────

export function createExtension(
  pi: MinimalPi,
  deps: UpdatePrDeps = defaultDeps(),
): void {
  let session: Session | null = null;

  pi.registerCommand("update-pr-description", {
    description:
      "Fetch a GitHub PR description and ask the agent to update it for the latest changes",
    handler: async (_args, rawCtx) => {
      const ctx = rawCtx as {
        ui: MockUi;
        cwd?: string;
        hasUI?: boolean;
      };

      // Discover the PR for the current branch via gh.
      const ghResult = await deps.exec(
        "gh",
        ["pr", "view", "--json", "body", "--jq", ".body"],
        { cwd: ctx.cwd },
      );
      if (ghResult.exitCode !== 0) {
        const msg =
          ghResult.stderr.trim() || `gh exited with code ${ghResult.exitCode}`;
        ctx.ui.notify(`Failed to fetch PR: ${msg}`, "error");
        return;
      }
      const originalBody = ghResult.stdout;

      // Create temp workdir and stash files.
      const tmpDir = await deps.mkdtemp("pi-update-pr-");
      const originalPath = join(tmpDir, "original.md");
      const currentPath = join(tmpDir, "current.md");
      await deps.writeFile(originalPath, originalBody);
      await deps.writeFile(currentPath, originalBody);

      session = {
        tmpDir,
        originalPath,
        currentPath,
      };

      ctx.ui.notify(
        `Fetched PR description (${originalBody.length} chars). Asking agent to update…`,
        "info",
      );

      pi.sendUserMessage(buildUpdatePrompt(originalBody));
    },
  });

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

      await deps.writeFile(session.currentPath, params.new_content);

      // Produce diff via `delta` and show it.
      const deltaResult = await deps.exec("delta", [
        session.originalPath,
        session.currentPath,
      ]);
      const diffText =
        deltaResult.stdout ||
        deltaResult.stderr ||
        "(no diff output from delta)";

      const accepted = await showDiffAndConfirm(ctx.ui, diffText);

      if (accepted) {
        await deps.exec("pbcopy", [], { input: params.new_content });
        const clearedSession = session;
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
async function showDiffAndConfirm(ui: MockUi, diff: string): Promise<boolean> {
  // Load pi-tui via dynamic import so the type-only top-level reference
  // never forces a runtime dependency on the peer package. Only the
  // import itself is guarded — any error from the render factory or
  // `ui.custom` is a real bug and must propagate to the caller.
  let tui: typeof import("@mariozechner/pi-tui");
  try {
    tui = await import("@mariozechner/pi-tui");
  } catch (err) {
    ui.notify(
      `Could not load @mariozechner/pi-tui (${
        err instanceof Error ? err.message : String(err)
      }); falling back to a plain confirm dialog.`,
      "warning",
    );
    return ui.confirm("Accept updated PR description?");
  }

  const { Text, matchesKey } = tui;
  return ui.custom<boolean>(
    (
      _tui: unknown,
      theme: unknown,
      _kb: unknown,
      done: (v: boolean) => void,
    ) => {
      const t = theme as {
        bold: (s: string) => string;
        fg: (k: string, s: string) => string;
      };
      const header = t.bold(
        t.fg("accent", "Updated PR description — enter:accept  esc:reject"),
      );
      const body = `${header}\n\n${diff}`;
      const text = new Text(body, 0, 0);
      return {
        render: (w: number) => text.render(w),
        invalidate: () => text.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, "escape")) {
            done(false);
            return;
          }
          if (matchesKey(data, "return")) {
            done(true);
            return;
          }
        },
      };
    },
  );
}

// ── Pi entrypoint ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  createExtension(pi as unknown as MinimalPi);
}

// Re-export for compatibility with test imports
export type { ExtensionCommandContext, ExtensionContext };
