/**
 * Client lifecycle helper — ensure the server is running, connect, and
 * expose a small API for the extension to use.
 *
 * Pulled out of index.ts so it's easy to drive from tests via a mocked
 * spawn/connect.
 */

import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Registry,
  detectInvalidState,
  isProcessAlive,
  pathsFor,
} from "./server/registry.ts";
import { IpcClient } from "./server/ipc-client.ts";
import type { ServerMessage } from "./server/protocol.ts";
import { errCode, errMessage, reportConsole } from "./server/errors.ts";
import { sleep } from "./server/util.ts";

export function defaultDataDir(): string {
  return join(homedir(), ".cache", "vs-code-but-chill_pi");
}

export interface EnsureServerDeps {
  dataDir: string;
  spawnServer: (dataDir: string) => { pid: number | undefined };
  /** Retry timing — override in tests. */
  retryDelayMs?: number;
  retryCount?: number;
}

export interface EnsureServerResult {
  client: IpcClient;
  respawned: boolean;
}

/**
 * Ensure the server is running at `dataDir` and return a connected client.
 * Heals invalid state (stale pid file, stale socket, dead-pid'd socket).
 */
export async function ensureServer(
  deps: EnsureServerDeps,
): Promise<EnsureServerResult> {
  const { dataDir } = deps;
  const paths = pathsFor(dataDir);
  const retryDelayMs = deps.retryDelayMs ?? 50;
  const retryCount = deps.retryCount ?? 40;

  // Prune any clearly-dead client refcount entries up front.
  try {
    const reg = new Registry(dataDir);
    reg.pruneDeadClients();
  } catch (err) {
    // Registry I/O failure here is unexpected but non-fatal — the
    // server-side tick prunes too. Surface so it's not silent.
    reportConsole("client registry prune failed", err);
  }

  // Try to connect first. A running server trumps anything else.
  {
    const c = new IpcClient();
    try {
      await c.connect(paths.socketPath);
      return { client: c, respawned: false };
    } catch {
      c.disconnect();
    }
  }

  // Inspect state and heal.
  const state = detectInvalidState(dataDir);
  if (
    state.pidFromFile &&
    isProcessAlive(state.pidFromFile) &&
    !state.socketExists
  ) {
    // Server process is up but the socket is missing → kill and respawn.
    try {
      process.kill(state.pidFromFile, "SIGTERM");
    } catch (err) {
      // ESRCH means it's already gone; other errors are worth seeing.
      if (errCode(err) !== "ESRCH") {
        reportConsole(
          `failed to signal stale server pid=${state.pidFromFile}`,
          err,
        );
      }
    }
  }

  // Remove stale socket (a dead server may leave it behind).
  try {
    if (existsSync(paths.socketPath)) unlinkSync(paths.socketPath);
  } catch (err) {
    // ENOENT is fine (race with another client); otherwise worth seeing.
    if (errCode(err) !== "ENOENT") {
      reportConsole("could not remove stale socket", err);
    }
  }

  deps.spawnServer(dataDir);

  // Retry connect
  let lastErr: unknown = null;
  for (let i = 0; i < retryCount; i++) {
    await sleep(retryDelayMs);
    const c = new IpcClient();
    try {
      await c.connect(paths.socketPath);
      return { client: c, respawned: true };
    } catch (err) {
      lastErr = err;
      c.disconnect();
    }
  }
  throw new Error(
    `vs-code-but-chill: failed to connect to server at ${paths.socketPath}: ${errMessage(lastErr)}`,
  );
}

/**
 * Map of per-type handlers keyed by `ServerMessage["type"]`. Each
 * handler receives the narrowed variant for its key.
 */
export type TypedMessageHandlers = {
  [K in ServerMessage["type"]]?: (
    msg: Extract<ServerMessage, { type: K }>,
  ) => void;
};

/** Convenience: register a message listener that dispatches by type. */
export function onTypedMessage(
  client: IpcClient,
  handlers: TypedMessageHandlers,
): void {
  client.onMessage((msg) => {
    // Each key in `handlers` expects its own narrowed variant, but the
    // dispatch here reads the key off `msg` which TS cannot correlate.
    // We hop through a single-variable narrowing to keep the call
    // site type-safe without `any`.
    const handler = handlers[msg.type] as
      | ((msg: ServerMessage) => void)
      | undefined;
    handler?.(msg);
  });
}
