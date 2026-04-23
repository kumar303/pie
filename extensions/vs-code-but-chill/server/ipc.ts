/**
 * IPC server for vs-code-but-chill.
 *
 * Listens on a Unix domain socket and speaks newline-delimited JSON.
 * The server is transport-only; callers supply handlers for hello/bye
 * and reap.
 *
 * Scope is deliberately narrow (see protocol.ts): hello/bye refcount
 * the server's lifetime, reap triggers an on-demand tick, stop
 * triggers a graceful shutdown, ping/pong is a cheap health check.
 * `killed` events are broadcast to every connected client without
 * any explicit subscription — the extension uses them to surface UI
 * toasts, and a client that doesn't care simply ignores them.
 */

import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { errMessage, reportStderr } from "./errors.ts";
import { createLineFramer } from "./util.ts";
import { parseProtocolMessage } from "./protocol.ts";
import type { ClientMessage, ServerMessage, KilledEvent } from "./protocol.ts";

export interface IpcServerHandlers {
  onHello: (pid: number) => void;
  onBye: (pid: number) => void;
  onStop?: () => void;
  /**
   * Handle an immediate "reap now" request from a client. Must run
   * the monitoring tick once and return its outcome. The handler can
   * signal failure two ways — by throwing (which the server catches
   * and reports) or by returning `{ ok: false, error }` (the shape
   * that lets main.ts share exactly one error path between the
   * interval tick and the reap-on-demand path).
   */
  onReap?: () => Promise<{
    ok: boolean;
    killed: number;
    error?: string;
  }>;
}

interface ConnectionState {
  socket: Socket;
  clientPid?: number;
}

export class IpcServer {
  #server: Server;
  #socketPath: string;
  #handlers: IpcServerHandlers;
  #connections = new Set<ConnectionState>();

  constructor(socketPath: string, handlers: IpcServerHandlers) {
    this.#socketPath = socketPath;
    this.#handlers = handlers;
    this.#server = createServer((socket) => this.#handleConnection(socket));
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        this.#server.off("error", onError);
        reject(err);
      };
      this.#server.on("error", onError);
      this.#server.listen(this.#socketPath, () => {
        this.#server.off("error", onError);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const conn of this.#connections) {
        try {
          conn.socket.destroy();
        } catch {
          // Socket already destroyed
        }
      }
      this.#connections.clear();
      this.#server.close(() => {
        try {
          if (existsSync(this.#socketPath)) unlinkSync(this.#socketPath);
        } catch (err) {
          // A failure here leaves a stale socket the next server run
          // must clean up — worth surfacing.
          reportStderr(`could not unlink socket ${this.#socketPath}`, err);
        }
        resolve();
      });
    });
  }

  get clientPids(): number[] {
    const pids: number[] = [];
    for (const c of this.#connections) {
      if (c.clientPid !== undefined) pids.push(c.clientPid);
    }
    return pids;
  }

  /** Broadcast a `killed` event to every connected client. */
  broadcastKilled(event: KilledEvent): void {
    const line = JSON.stringify(event) + "\n";
    for (const conn of this.#connections) {
      try {
        conn.socket.write(line);
      } catch {
        // Peer disconnected — socket "close"/"error" handlers prune.
      }
    }
  }

  #handleConnection(socket: Socket): void {
    const state: ConnectionState = { socket };
    this.#connections.add(state);
    const framer = createLineFramer();

    socket.on("data", (data) => {
      for (const line of framer(data.toString())) {
        try {
          const msg = parseProtocolMessage<ClientMessage>(line);
          this.#dispatch(state, msg);
        } catch (err) {
          // Malformed JSON indicates a protocol mismatch or a
          // misbehaving client. We don't have a generic error channel
          // anymore; log it and drop the line.
          reportStderr("ipc parse error", err);
        }
      }
    });

    socket.on("close", () => {
      this.#connections.delete(state);
    });
    socket.on("error", () => {
      this.#connections.delete(state);
    });
  }

  #dispatch(state: ConnectionState, msg: ClientMessage): void {
    switch (msg.type) {
      case "hello":
        state.clientPid = msg.pid;
        this.#handlers.onHello(msg.pid);
        break;
      case "bye":
        this.#handlers.onBye(msg.pid);
        break;
      case "ping":
        this.#send(state, { type: "pong" });
        break;
      case "stop":
        if (this.#handlers.onStop) this.#handlers.onStop();
        break;
      case "reap": {
        const onReap = this.#handlers.onReap;
        if (!onReap) {
          this.#send(state, {
            type: "reap",
            ok: false,
            killed: 0,
            error: "server does not support reap",
          });
          break;
        }
        // Fire and forget the async run; send the response when it
        // settles. `state` may be gone by the time we reply, which
        // `#send` tolerates.
        void (async () => {
          try {
            const result = await onReap();
            this.#send(state, {
              type: "reap",
              ok: result.ok,
              killed: result.killed,
              ...(result.error ? { error: result.error } : {}),
            });
          } catch (err) {
            this.#send(state, {
              type: "reap",
              ok: false,
              killed: 0,
              error: errMessage(err),
            });
          }
        })();
        break;
      }
    }
  }

  #send(state: ConnectionState, msg: ServerMessage): void {
    try {
      state.socket.write(JSON.stringify(msg) + "\n");
    } catch {
      // Client disconnected
    }
  }
}
