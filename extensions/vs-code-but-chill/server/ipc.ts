/**
 * IPC server for vs-code-but-chill.
 *
 * Listens on a Unix domain socket and speaks newline-delimited JSON.
 * The server is transport-only; callers supply handlers for hello/bye
 * and data providers for status and logs.
 */

import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { errMessage, reportStderr } from "./errors.ts";
import { createLineFramer } from "./util.ts";
import { parseProtocolMessage } from "./protocol.ts";
import type {
  ClientMessage,
  ServerMessage,
  StatusResponse,
  KilledEvent,
  ErrorEvent,
} from "./protocol.ts";

export interface IpcServerHandlers {
  onHello: (pid: number) => void;
  onBye: (pid: number) => void;
  getStatus: () => Omit<StatusResponse, "type">;
  getLogs: (tail?: number) => string[];
  onStop?: () => void;
}

interface ConnectionState {
  socket: Socket;
  clientPid?: number;
  subscribedToEvents: boolean;
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

  get eventSubscriberCount(): number {
    let n = 0;
    for (const c of this.#connections) if (c.subscribedToEvents) n++;
    return n;
  }

  /** Write one JSON-encoded message to every event-subscriber. */
  #broadcastToSubscribers(msg: ServerMessage): void {
    const line = JSON.stringify(msg) + "\n";
    for (const conn of this.#connections) {
      if (!conn.subscribedToEvents) continue;
      try {
        conn.socket.write(line);
      } catch {
        // Peer disconnected — socket "close"/"error" handlers prune.
      }
    }
  }

  broadcastEvent(event: KilledEvent | ErrorEvent): void {
    this.#broadcastToSubscribers(event);
  }

  /** Push a live log line to all event-subscribers. */
  broadcastLog(logLine: string): void {
    this.#broadcastToSubscribers({ type: "log", line: logLine });
  }

  #handleConnection(socket: Socket): void {
    const state: ConnectionState = {
      socket,
      subscribedToEvents: false,
    };
    this.#connections.add(state);
    const framer = createLineFramer();

    socket.on("data", (data) => {
      for (const line of framer(data.toString())) {
        try {
          const msg = parseProtocolMessage<ClientMessage>(line);
          this.#dispatch(state, msg);
        } catch (err) {
          // Malformed JSON indicates a protocol mismatch or a misbehaving
          // client — not an expected condition. Tell the peer and log.
          reportStderr("ipc parse error", err);
          this.#send(state, {
            type: "error",
            message: `malformed message: ${errMessage(err)}`,
          });
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
        this.#send(state, { type: "ack", of: "hello" });
        break;
      case "bye":
        this.#handlers.onBye(msg.pid);
        this.#send(state, { type: "ack", of: "bye" });
        break;
      case "status": {
        const s = this.#handlers.getStatus();
        this.#send(state, { type: "status", ...s });
        break;
      }
      case "logs": {
        const lines = this.#handlers.getLogs(msg.tail);
        for (const line of lines) {
          this.#send(state, { type: "log", line });
        }
        break;
      }
      case "events":
        state.subscribedToEvents = true;
        this.#send(state, { type: "ack", of: "events" });
        break;
      case "ping":
        this.#send(state, { type: "pong" });
        break;
      case "stop":
        this.#send(state, { type: "ack", of: "stop" });
        if (this.#handlers.onStop) this.#handlers.onStop();
        break;
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
