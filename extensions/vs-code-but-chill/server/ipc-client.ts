/**
 * IPC client for vs-code-but-chill.
 */

import { createConnection, type Socket } from "node:net";
import { parseProtocolMessage } from "./protocol.ts";
import type { ClientMessage, ServerMessage } from "./protocol.ts";
import { reportStderr } from "./errors.ts";
import { createLineFramer } from "./util.ts";

export class IpcClient {
  #socket: Socket | null = null;
  #listeners: Array<(msg: ServerMessage) => void> = [];
  #errorListeners: Array<(err: Error) => void> = [];

  connect(socketPath: string): Promise<void> {
    if (this.#socket) {
      this.#socket.destroy();
      this.#socket = null;
    }
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath, () => {
        this.#socket = socket;
        resolve();
      });
      const framer = createLineFramer();
      socket.on("error", (err) => {
        if (!this.#socket || this.#socket !== socket) {
          reject(err);
        } else {
          for (const l of this.#errorListeners) l(err);
        }
      });
      socket.on("data", (data) => {
        for (const line of framer(data.toString())) {
          try {
            const msg = parseProtocolMessage<ServerMessage>(line);
            for (const l of this.#listeners) l(msg);
          } catch (err) {
            // Malformed JSON from the server indicates a protocol mismatch.
            // Surface to stderr; there's no log file on the client side.
            reportStderr("server sent malformed JSON", err);
          }
        }
      });
      socket.on("close", () => {
        const prev = this.#socket;
        this.#socket = null;
        if (prev === socket) {
          for (const l of this.#errorListeners) {
            l(new Error("socket closed"));
          }
        }
      });
    });
  }

  send(msg: ClientMessage): void {
    if (!this.#socket || this.#socket.destroyed) return;
    this.#socket.write(JSON.stringify(msg) + "\n");
  }

  onMessage(listener: (msg: ServerMessage) => void): void {
    this.#listeners.push(listener);
  }

  onError(listener: (err: Error) => void): void {
    this.#errorListeners.push(listener);
  }

  disconnect(): void {
    if (this.#socket) {
      this.#socket.destroy();
      this.#socket = null;
    }
    this.#listeners = [];
    this.#errorListeners = [];
  }

  get connected(): boolean {
    return this.#socket !== null && !this.#socket.destroyed;
  }
}
