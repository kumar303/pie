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
import { watch, type FSWatcher } from "node:fs";
import { IpcClient } from "./server/ipc-client.ts";
import { defaultDataDir, ensureServer, onTypedMessage } from "./client.ts";
import { pathsFor } from "./server/registry.ts";
import { spawnServer } from "./spawn.ts";
import { errMessage, reportConsole } from "./server/errors.ts";
import { sleep } from "./server/util.ts";
import { readLogTail } from "./log-file-reader.ts";
import {
  initialState,
  applyFollow,
  onNewLine,
  onScrollUp,
  onScrollDown,
  onPageUp,
  onPageDown,
  onJumpTop,
  onJumpBottom,
} from "./log-viewer-state.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_MAIN = join(HERE, "server", "main.ts");

const STATUS_KEY = "vs-code-but-chill";
const STATUS_TEXT = "🍦✨ /vs-code-but-chill";

const SUBCOMMANDS: Array<{
  value: string;
  label: string;
  description: string;
}> = [
  { value: "help", label: "help", description: "Show help" },
  { value: "logs", label: "logs", description: "Open the log viewer" },
  {
    value: "reap",
    label: "reap",
    description: "Run a monitoring check immediately",
  },
  {
    value: "start",
    label: "start",
    description: "Start the background server (no-op if running)",
  },
  { value: "stop", label: "stop", description: "Stop the background server" },
];

export default function (pi: ExtensionAPI) {
  const dataDir = defaultDataDir();
  const logFilePath = pathsFor(dataDir).logFile;
  let client: IpcClient | null = null;
  let notify:
    | ((msg: string, type?: "info" | "warning" | "error") => void)
    | null = null;

  // Dedupe concurrent connect() calls — pi has been observed to fire
  // session_start twice in quick succession, and two blind connects
  // would orphan the earlier socket.
  let connectInFlight: Promise<boolean> | null = null;

  function connect(): Promise<boolean> {
    if (connectInFlight) return connectInFlight;
    if (client) return Promise.resolve(true);
    connectInFlight = doConnect().finally(() => {
      connectInFlight = null;
    });
    return connectInFlight;
  }

  async function doConnect(): Promise<boolean> {
    try {
      const { client: c } = await ensureServer({
        dataDir,
        spawnServer: (dir) => spawnServer(SERVER_MAIN, dir),
      });
      client = c;

      c.onError((err) => {
        // A socket close during our own teardown isn't a failure.
        if (shuttingDown) return;
        notify?.(
          `/vs-code-but-chill: server connection lost: ${err.message}`,
          "warning",
        );
      });

      onTypedMessage(c, {
        killed: (msg) => {
          const where = msg.workspacePath ?? msg.workspace ?? "<unknown>";
          const label = msg.kind === "eslint" ? "eslintServer" : "tsserver";
          notify?.(
            `/vs-code-but-chill: stopped idle ${label} in ${where}`,
            "info",
          );
        },
        reap: (msg) => {
          const next = pendingReaps.shift();
          if (next) next({ ok: msg.ok, killed: msg.killed, error: msg.error });
        },
      });

      c.send({ type: "hello", pid: process.pid });
      return true;
    } catch (err) {
      notify?.(
        `/vs-code-but-chill: could not start server: ${errMessage(err)}`,
        "error",
      );
      return false;
    }
  }

  let clearStatus: (() => void) | null = null;
  // Set during our own teardown so the connection-lost handler stays quiet.
  let shuttingDown = false;

  // FIFO queue of one-shot listeners for `reap` responses. Lets
  // overlapping /reap requests resolve in send order.
  const pendingReaps: Array<
    (r: { ok: boolean; killed: number; error?: string }) => void
  > = [];

  pi.on("session_start", (_event, ctx) => {
    // pi runs lifecycle hooks serially; awaiting connect() (~2s cold
    // start) would block the prompt. Fire-and-forget.
    notify = (m, t) => ctx.ui.notify(m, t);
    void (async () => {
      const ok = await connect();
      if (ok) {
        // Status bar is the only indicator — no startup notification.
        ctx.ui.setStatus(STATUS_KEY, STATUS_TEXT);
        clearStatus = () => ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    })();
  });

  /**
   * Drop the status indicator and disconnect. `sendBye=true` on session
   * end; `false` on explicit /stop where the server is already exiting.
   */
  async function teardown(opts: { sendBye: boolean }): Promise<void> {
    shuttingDown = true;
    if (clearStatus) {
      clearStatus();
      clearStatus = null;
    }
    if (client) {
      if (opts.sendBye) {
        try {
          client.send({ type: "bye", pid: process.pid });
        } catch (err) {
          // A write racing with remote close can surface EPIPE.
          reportConsole("sending bye during shutdown failed", err);
        }
      }
      // Let the bye flush before closing the socket.
      await sleep(50);
      client.disconnect();
      client = null;
    }
  }

  pi.on("session_shutdown", () => {
    // Fire-and-forget so we don't delay pi's exit; the server will
    // notice the dropped connection even without a clean bye.
    void teardown({ sendBye: true });
  });

  pi.registerCommand("vs-code-but-chill", {
    description: "Monitor TS servers and stop them from eating too much memory",
    getArgumentCompletions: (prefix: string) => {
      const needle = prefix.trim().toLowerCase();
      return SUBCOMMANDS.filter((s) =>
        s.value.toLowerCase().startsWith(needle),
      );
    },
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
        await showLogs(ctx, logFilePath);
        return;
      }
      if (sub === "reap") {
        // The command can dispatch before session_start's background
        // connect finishes; wait on it rather than spawning a fresh one.
        if (!client && connectInFlight) {
          await connectInFlight;
        }
        if (!client) {
          ctx.ui.notify("/vs-code-but-chill: server is not running", "warning");
          return;
        }
        // Don't await the response: pi serializes handlers and a tick
        // can take seconds. Surface the outcome as a later notification,
        // with a timeout so a dead socket doesn't leave the user hanging.
        const timeoutMs = Number(process.env.VSCBC_REAP_TIMEOUT_MS) || 60_000;
        let settled = false;
        const resolver = (result: {
          ok: boolean;
          killed: number;
          error?: string;
        }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (!result.ok) {
            ctx.ui.notify(
              `/vs-code-but-chill: reap failed${
                result.error ? ": " + result.error : ""
              }`,
              "warning",
            );
            return;
          }
          if (result.killed === 0) {
            ctx.ui.notify(
              "/vs-code-but-chill: reap ran — nothing to stop",
              "info",
            );
          } else {
            ctx.ui.notify(
              `/vs-code-but-chill: reap stopped ${result.killed} process${
                result.killed === 1 ? "" : "es"
              }`,
              "info",
            );
          }
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          // Remove so a late response doesn't bind to this resolver.
          const i = pendingReaps.indexOf(resolver);
          if (i >= 0) pendingReaps.splice(i, 1);
          ctx.ui.notify(
            `/vs-code-but-chill: reap timed out after ${Math.round(
              timeoutMs / 1000,
            )}s — no response from server`,
            "warning",
          );
        }, timeoutMs);
        pendingReaps.push(resolver);
        client.send({ type: "reap" });
        ctx.ui.notify("/vs-code-but-chill: reap requested…", "info");
        return;
      }
      if (sub === "start") {
        if (client) return;
        // Fire-and-forget for the same reason as session_start.
        shuttingDown = false;
        void (async () => {
          const ok = await connect();
          if (ok) {
            ctx.ui.setStatus(STATUS_KEY, STATUS_TEXT);
            clearStatus = () => ctx.ui.setStatus(STATUS_KEY, undefined);
            ctx.ui.notify(
              "/vs-code-but-chill: start sent; monitor running",
              "info",
            );
          }
        })();
        return;
      }
      if (sub === "stop") {
        // Same rationale as reap: wait on the in-flight connect.
        if (!client && connectInFlight) {
          await connectInFlight;
        }
        if (!client) {
          ctx.ui.notify("/vs-code-but-chill: server is not running", "warning");
          return;
        }
        client.send({ type: "stop" });
        ctx.ui.notify(
          "/vs-code-but-chill: stop sent; server will shut down",
          "info",
        );
        // No `bye` — /stop already asked the server to exit. Teardown
        // clears our status and suppresses the connection-lost warning.
        void teardown({ sendBye: false });
        return;
      }
      ctx.ui.notify(
        `/vs-code-but-chill: unknown subcommand '${sub}'. Try '/vs-code-but-chill help'.`,
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
    "  /vs-code-but-chill logs   — open the log viewer (follow mode; ↑/↓, d/u, g/G, q)",
    "  /vs-code-but-chill reap   — run a monitoring check immediately",
    "  /vs-code-but-chill start  — start the background server (no-op if running)",
    "  /vs-code-but-chill stop   — stop the background server",
    "",
    "Thresholds (override via env):",
    "  VSCBC_FULL_MB      default 2500  — full semantic tsserver",
    "  VSCBC_PARTIAL_MB   default 800   — partialSemantic tsserver",
    "  VSCBC_TICK_MS      default 1200000 (20min, in ms) — scan interval",
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

/** Max lines to keep in-memory for the viewer. */
const LOG_VIEWER_CAP = 2000;

async function showLogs(
  ctx: ExtensionCommandContext,
  logFilePath: string,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    let state = initialState();
    let lastWidth = 80;
    const height = 20;
    const text = new Text("", 0, 0);
    const bodyHeight = () => Math.max(1, height - 3);

    // Seed the buffer by reading the log file once. Follow mode
    // refreshes the tail whenever the file changes.
    let buffer: string[] = readLogTail(logFilePath, LOG_VIEWER_CAP);

    /**
     * Re-read the file tail and diff against the buffer. New lines
     * count as "arrivals" so paused viewers see their pending count
     * go up without the offset jumping.
     */
    const refresh = () => {
      const fresh = readLogTail(logFilePath, LOG_VIEWER_CAP);
      // Heuristic: if the fresh tail is longer, the difference is new.
      // After rotation the tail shrinks — reset to avoid confusing the
      // user with negative pending counts.
      let newCount = 0;
      if (fresh.length >= buffer.length) {
        newCount = Math.max(0, fresh.length - buffer.length);
      }
      buffer = fresh;
      for (let i = 0; i < newCount; i++) {
        state = onNewLine(state);
      }
      rebuild();
      tui.requestRender();
    };

    let watcher: FSWatcher | null = null;
    try {
      // `fs.watch` emits on both content change and rename (which is
      // how rotation looks). Swallow errors during close.
      watcher = watch(logFilePath, { persistent: false }, () => refresh());
      watcher.on("error", (err) => {
        // Not user-actionable; surface to console so it's visible in
        // development.
        reportConsole("log file watch error", err);
      });
    } catch (err) {
      // `watch` throws if the file doesn't exist yet. That's fine —
      // we'll just render the seeded (possibly empty) buffer and let
      // the user re-open the viewer once the server has written.
      reportConsole("log file watch init failed", err);
    }

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
        truncateToWidth(
          "↑/↓ scroll · d/u page · g top · G bottom · q/esc close",
          w,
        ),
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
          if (watcher) {
            try {
              watcher.close();
            } catch {
              // Already closed — nothing to do.
            }
          }
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
        if (matchesKey(data, "u")) {
          state = onPageUp(state, bodyHeight());
          rebuild();
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "d")) {
          state = onPageDown(state, buffer.length, bodyHeight());
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
