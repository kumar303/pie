/**
 * VS Code, but chill — pi extension.
 *
 * Thin client around a long-running background server that watches
 * `tsserver.js` processes and restarts oversized ones.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { Text, matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";
import { IpcClient } from "./server/ipc-client.ts";
import { defaultDataDir, ensureServer, onTypedMessage } from "./client.ts";
import { spawnServer } from "./spawn.ts";
import { errMessage, reportConsole } from "./server/errors.ts";
import { sleep } from "./server/util.ts";
import {
  initialState,
  applyFollow,
  onNewLine,
  onScrollUp,
  onScrollDown,
  onJumpTop,
  onJumpBottom,
} from "./log-viewer-state.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_MAIN = join(HERE, "server", "main.ts");

export default function (pi: ExtensionAPI) {
  const dataDir = defaultDataDir();
  let client: IpcClient | null = null;
  /** Tail of recent log lines for the viewer. */
  const recentLog: string[] = [];
  const MAX_RECENT = 2000;
  let notify:
    | ((msg: string, type?: "info" | "warning" | "error") => void)
    | null = null;
  /** Listeners interested in new log lines (for follow-mode viewer). */
  const logListeners = new Set<(line: string) => void>();

  function pushLog(line: string): void {
    recentLog.push(line);
    if (recentLog.length > MAX_RECENT) {
      recentLog.splice(0, recentLog.length - MAX_RECENT);
    }
    for (const l of logListeners) {
      try {
        l(line);
      } catch (err) {
        // Listener throwing is a bug — surface it and keep going so
        // one broken overlay doesn't silence the rest.
        reportConsole("log listener error", err);
      }
    }
  }

  async function connect(): Promise<void> {
    try {
      const { client: c } = await ensureServer({
        dataDir,
        spawnServer: (dir) => spawnServer(SERVER_MAIN, dir),
      });
      client = c;

      c.onError((err) => {
        notify?.(
          `vs-code-but-chill: server connection lost: ${err.message}`,
          "warning",
        );
      });

      onTypedMessage(c, {
        killed: (msg) => {
          const where = msg.workspacePath ?? msg.workspace ?? "<unknown>";
          const label = msg.kind === "eslint" ? "eslintServer" : "tsserver";
          notify?.(
            `/vs-code-but-chill: killed ${label} (${msg.rssMb} MB) in ${where}`,
            "info",
          );
          pushLog(
            `[killed] ${msg.kind} pid=${msg.pid} mode=${msg.mode} rss=${msg.rssMb}MB workspace=${where}`,
          );
        },
        error: (msg) => {
          notify?.(`vs-code-but-chill: ${msg.message}`, "warning");
          pushLog(`[error] ${msg.message}`);
        },
        log: (msg) => {
          pushLog(msg.line);
        },
      });

      c.send({ type: "hello", pid: process.pid });
      c.send({ type: "events" });
      // Prime with recent log lines
      c.send({ type: "logs", tail: 500 });
    } catch (err) {
      notify?.(
        `vs-code-but-chill: could not start server: ${errMessage(err)}`,
        "error",
      );
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    notify = (m, t) => ctx.ui.notify(m, t);
    await connect();
    ctx.ui.notify("/vs-code-but-chill: monitoring TS servers", "info");
  });

  pi.on("session_shutdown", async () => {
    if (client) {
      try {
        client.send({ type: "bye", pid: process.pid });
      } catch (err) {
        // IpcClient.send guards against a missing or destroyed socket,
        // but a write that races with remote close can still surface
        // EPIPE. Surface it so we don't lose the signal.
        reportConsole("sending bye during shutdown failed", err);
      }
      // Give the message a tick to flush before closing.
      await sleep(50);
      client.disconnect();
      client = null;
    }
  });

  pi.registerCommand("vs-code-but-chill", {
    description: "Monitor TS servers and stop them from eating too much memory",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0] ?? "";
      if (sub === "" || sub === "help") {
        if (!ctx.hasUI) {
          ctx.ui.notify("/vs-code-but-chill help requires TUI mode", "error");
          return;
        }
        await showHelp(ctx);
        return;
      }
      if (sub === "logs") {
        if (!ctx.hasUI) {
          ctx.ui.notify("/vs-code-but-chill logs requires TUI mode", "error");
          return;
        }
        await showLogs(ctx, recentLog, logListeners);
        return;
      }
      if (sub === "stop") {
        if (!client) {
          ctx.ui.notify("vs-code-but-chill: server is not running", "warning");
          return;
        }
        client.send({ type: "stop" });
        ctx.ui.notify(
          "vs-code-but-chill: stop sent; server will shut down",
          "info",
        );
        return;
      }
      ctx.ui.notify(
        `vs-code-but-chill: unknown subcommand '${sub}'. Try '/vs-code-but-chill help'.`,
        "warning",
      );
    },
  });
}

async function showHelp(ctx: ExtensionCommandContext): Promise<void> {
  const lines = [
    "vs-code-but-chill — keep TypeScript servers from eating too much memory",
    "",
    "  /vs-code-but-chill        — show this help",
    "  /vs-code-but-chill help   — show this help",
    "  /vs-code-but-chill logs   — open the log viewer (follow mode; ↑/↓, g/G, q)",
    "  /vs-code-but-chill stop   — stop the background server",
    "",
    "Thresholds (override via env):",
    "  VSCBC_FULL_MB      default 2500  — full semantic tsserver",
    "  VSCBC_PARTIAL_MB   default 800   — partialSemantic tsserver",
    "  VSCBC_TICK_MS      default 20min — scan interval",
    "  VSCBC_MIN_ETIME_S  default 300   — skip procs younger than this",
    "",
    "Data dir: ~/.cache/vs-code-but-chill_pi/",
    "",
    "Press q or Esc to dismiss.",
  ];
  await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
    const text = new Text("", 0, 0);
    const rebuild = () => {
      const styled = lines
        .map((l, i) => (i === 0 ? theme.bold(theme.fg("accent", l)) : l))
        .join("\n");
      text.setText(styled);
    };
    rebuild();
    return {
      render: (w: number) => text.render(w),
      invalidate: () => {
        rebuild();
        text.invalidate();
      },
      handleInput: (data: string) => {
        if (
          matchesKey(data, Key.escape) ||
          matchesKey(data, "q") ||
          matchesKey(data, Key.enter)
        ) {
          done(undefined);
        }
      },
    };
  });
}

async function showLogs(
  ctx: ExtensionCommandContext,
  buffer: string[],
  listeners: Set<(line: string) => void>,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    let state = initialState();
    let lastWidth = 80;
    const height = 20;
    const text = new Text("", 0, 0);
    const bodyHeight = () => Math.max(1, height - 3);

    const listener = (line: string) => {
      buffer.push(line);
      state = onNewLine(state);
      rebuild();
      tui.requestRender();
    };
    listeners.add(listener);

    const rebuild = () => {
      state = applyFollow(state, buffer.length, bodyHeight());
      const w = lastWidth;
      const visible = buffer
        .slice(state.offset, state.offset + bodyHeight())
        .map((l) => truncateToWidth(l, w));
      const statusRaw =
        (state.followMode
          ? "-- follow --"
          : `-- paused${state.pendingCount > 0 ? ` (${state.pendingCount} new)` : ""} --`) +
        `  lines ${state.offset + 1}-${state.offset + visible.length} / ${buffer.length}`;
      const status = state.followMode
        ? theme.fg("dim", truncateToWidth(statusRaw, w))
        : theme.fg("accent", truncateToWidth(statusRaw, w));
      const header = theme.bold(
        theme.fg("accent", truncateToWidth("vs-code-but-chill logs", w)),
      );
      const hints = theme.fg(
        "dim",
        truncateToWidth("↑/↓ scroll · g top · G bottom · q/esc close", w),
      );
      text.setText([header, ...visible, status, hints].join("\n"));
    };

    rebuild();

    return {
      render: (w: number) => {
        if (w !== lastWidth) {
          lastWidth = w;
          rebuild();
        }
        return text.render(w);
      },
      invalidate: () => {
        rebuild();
        text.invalidate();
      },
      handleInput: (data: string) => {
        if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
          listeners.delete(listener);
          done(undefined);
          return;
        }
        if (matchesKey(data, Key.up)) {
          state = onScrollUp(state);
          rebuild();
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.down)) {
          state = onScrollDown(state, buffer.length, bodyHeight());
          rebuild();
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "g")) {
          state = onJumpTop(state);
          rebuild();
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.shift("g"))) {
          state = onJumpBottom(state, buffer.length, bodyHeight());
          rebuild();
          tui.requestRender();
          return;
        }
      },
    };
  });
}
