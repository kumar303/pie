/**
 * Brain Extension
 *
 * Invoke with `/brain`. Shows a three-panel TUI for browsing recent project
 * directories and their tool output logs.
 *
 * Tracks session activity (working/idle) and logs tool output for each
 * pi session directory.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  registerSession,
  recordFocus,
  writeStatus,
  readSessions,
  readLog,
  appendLog,
  pruneOldSessions,
  getDataDir,
  getGitBranch,
  type DirEntry,
} from "./store.js";
import { BrainComponent } from "./brain.js";

export default function (pi: ExtensionAPI) {
  // ── Per-session state ───────────────────────────────────────────

  let sessionId: string | null = null;
  let sessionDir: string | null = null;
  let logBuffer: { toolName: string; output: string }[] = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  function flushLogBuffer(): void {
    if (!sessionId || logBuffer.length === 0) return;
    for (const entry of logBuffer) {
      appendLog(sessionId, entry.toolName, entry.output);
    }
    logBuffer = [];
  }

  function startFlushTimer(): void {
    if (flushTimer) return;
    flushTimer = setInterval(flushLogBuffer, 2000);
  }

  function stopFlushTimer(): void {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  }

  // ── Event listeners ─────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    sessionDir = ctx.cwd;

    if (sessionId && sessionDir) {
      registerSession(sessionId, sessionDir);
      startFlushTimer();
    }

    // Prune old sessions in the background (non-blocking)
    try {
      pruneOldSessions();
    } catch {
      // Ignore pruning errors
    }
  });

  pi.on("agent_start", async (_event, _ctx) => {
    if (sessionId) {
      writeStatus(sessionId, "working");
    }
  });

  pi.on("agent_end", async (_event, _ctx) => {
    if (sessionId) {
      writeStatus(sessionId, "idle");
    }
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (!sessionId) return;

    // Extract text content from tool result
    const textParts = event.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text);
    const output = textParts.join("\n");

    if (output) {
      logBuffer.push({ toolName: event.toolName, output });
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    flushLogBuffer();
    stopFlushTimer();
    if (sessionId) {
      writeStatus(sessionId, "idle");
    }
  });

  // ── /brain command ──────────────────────────────────────────────

  pi.registerCommand("brain", {
    description: "Browse recent project directories and their tool output logs",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Brain requires TUI mode", "error");
        return;
      }

      // Flush any pending log entries before showing the UI
      flushLogBuffer();

      const data = readSessions();

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        // Enable clear-on-shrink for clean transitions
        (tui as any).setClearOnShrink?.(true);

        const component = new BrainComponent(
          tui,
          theme,
          () => {
            component.dispose();
            done(undefined);
          },
          (dir: DirEntry) => {
            // Record focus timestamp
            if (dir.sessionId) {
              recordFocus(dir.sessionId, dir.dir);
            }

            // Open in $EDITOR
            openInEditor(dir.dir, ctx);
          },
          data,
          (sid: string) => readLog(sid),
          () => readSessions(),
          { cwd: ctx.cwd, cwdBranch: getGitBranch(ctx.cwd) },
        );

        return {
          render: (w: number) => component.render(w),
          invalidate: () => component.invalidate(),
          handleInput: (inputData: string) => {
            component.handleInput(inputData);
          },
        };
      });
    },
  });
}

// ── Editor opening ────────────────────────────────────────────────

function openInEditor(dir: string, ctx: ExtensionContext): void {
  const editor = process.env.EDITOR || "vi";
  const absolutePath = resolve(dir);

  try {
    // On macOS, GUI editors like `code` (VS Code) can't connect to the
    // running instance via their CLI because VSCODE_IPC_HOOK_CLI isn't
    // available in pi's process environment. Use `open -a` to reliably
    // open files in GUI editors via macOS Launch Services.
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
      ctx.ui.notify(
        `Failed to open ${dir}: ${result.error.message}`,
        "error",
      );
    } else if (result.status !== null && result.status !== 0) {
      const detail =
        ((result.stderr || result.stdout || "") as string).trim() ||
        `exit ${result.status}`;
      ctx.ui.notify(`Failed to open ${dir}: ${detail}`, "error");
    }
  } catch (err: any) {
    ctx.ui.notify(`Failed to open ${dir}: ${err.message}`, "error");
  }
}
