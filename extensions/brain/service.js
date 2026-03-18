/**
 * Brain pub/sub service.
 *
 * A Unix domain socket server that brokers messages between brain sessions.
 * Each pi process connects as a client. The service broadcasts messages
 * to all other connected clients.
 *
 * Message protocol: newline-delimited JSON over Unix domain socket.
 */

import { createServer, createConnection } from "node:net";
import { existsSync, unlinkSync, mkdirSync, rmdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { getDataDir } from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Types (JSDoc) ───────────────────────────────────────────────────

/**
 * @typedef {import("./store.js").AgentState} AgentState
 */

/**
 * @typedef {Object} StatusMessage
 * @property {"status"} type
 * @property {string} sessionId
 * @property {string} dir
 * @property {string | null} branch
 * @property {AgentState} state
 */

/**
 * @typedef {Object} SessionsChangedMessage
 * @property {"sessions_changed"} type
 */

/**
 * @typedef {Object} ErrorMessage
 * @property {"error"} type
 * @property {string} sessionId
 * @property {string} message
 */

/**
 * @typedef {StatusMessage | SessionsChangedMessage | ErrorMessage} PubSubMessage
 */

// ── Paths ───────────────────────────────────────────────────────────

/** @param {string} [dataDir] @returns {string} */
export function getSocketPath(dataDir) {
  const dd = dataDir ?? getDataDir();
  return join(dd, "service.sock");
}

/** @param {string} [dataDir] @returns {string} */
export function getLockDir(dataDir) {
  const dd = dataDir ?? getDataDir();
  return join(dd, "service.lock");
}

// ── Service (server side) ───────────────────────────────────────────

export class BrainService {
  /** @type {import("node:net").Server} */
  #server;
  /** @type {Set<import("node:net").Socket>} */
  #clients = new Set();
  /** @type {string} */
  #socketPath;

  /** @param {string} socketPath */
  constructor(socketPath) {
    this.#socketPath = socketPath;
    this.#server = createServer((socket) => this.#handleConnection(socket));
  }

  /** @param {import("node:net").Socket} socket */
  #handleConnection(socket) {
    this.#clients.add(socket);

    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (line.trim()) {
          this.#broadcast(line, socket);
        }
      }
    });

    socket.on("close", () => {
      this.#clients.delete(socket);
      if (this.#clients.size === 0) {
        this.stop();
      }
    });

    socket.on("error", () => {
      this.#clients.delete(socket);
    });
  }

  /**
   * Broadcast a raw JSON line to all clients except the sender.
   * @param {string} line
   * @param {import("node:net").Socket} sender
   */
  #broadcast(line, sender) {
    for (const client of this.#clients) {
      if (client !== sender && !client.destroyed) {
        try {
          client.write(line + "\n");
        } catch {
          // Client disconnected
        }
      }
    }
  }

  /** @returns {Promise<void>} */
  start() {
    return new Promise((resolve, reject) => {
      this.#server.on("error", reject);
      this.#server.listen(this.#socketPath, () => resolve());
    });
  }

  /** @returns {Promise<void>} */
  stop() {
    return new Promise((resolve) => {
      for (const client of this.#clients) {
        client.destroy();
      }
      this.#clients.clear();
      this.#server.close(() => {
        try {
          if (existsSync(this.#socketPath)) unlinkSync(this.#socketPath);
        } catch {}
        resolve();
      });
    });
  }

  /** @returns {number} */
  get clientCount() {
    return this.#clients.size;
  }
}

// ── Client ──────────────────────────────────────────────────────────

export class Client {
  /** @type {import("node:net").Socket | null} */
  #socket = null;
  /** @type {((msg: PubSubMessage) => void)[]} */
  #listeners = [];
  /** @type {((err: Error) => void)[]} */
  #errorListeners = [];
  /** @type {string} */
  #buffer = "";

  /** @param {string} socketPath @returns {Promise<void>} */
  connect(socketPath) {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath, () => {
        this.#socket = socket;
        resolve();
      });
      socket.on("error", (err) => {
        if (!this.#socket) {
          // Pre-connection error — reject the connect promise
          reject(err);
        } else {
          // Post-connection error — notify error listeners
          for (const listener of this.#errorListeners) {
            listener(err);
          }
        }
      });
      socket.on("data", (data) => {
        this.#buffer += data.toString();
        let newlineIdx;
        while ((newlineIdx = this.#buffer.indexOf("\n")) !== -1) {
          const line = this.#buffer.slice(0, newlineIdx);
          this.#buffer = this.#buffer.slice(newlineIdx + 1);
          if (line.trim()) {
            try {
              const msg = JSON.parse(line);
              for (const listener of this.#listeners) {
                listener(msg);
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }
      });
    });
  }

  /** @param {PubSubMessage} msg */
  publish(msg) {
    if (!this.#socket || this.#socket.destroyed) return;
    this.#socket.write(JSON.stringify(msg) + "\n");
  }

  /** @param {(msg: PubSubMessage) => void} listener */
  onMessage(listener) {
    this.#listeners.push(listener);
  }

  /** @param {(err: Error) => void} listener */
  onError(listener) {
    this.#errorListeners.push(listener);
  }

  disconnect() {
    if (this.#socket) {
      this.#socket.destroy();
      this.#socket = null;
    }
    this.#listeners = [];
    this.#errorListeners = [];
  }

  /** @returns {boolean} */
  get connected() {
    return this.#socket !== null && !this.#socket.destroyed;
  }
}

// ── Lock helpers ────────────────────────────────────────────────────

/** Try to acquire lock via atomic mkdir. Returns true if acquired.
 * @param {string} [dataDir] @returns {boolean}
 */
export function tryAcquireLock(dataDir) {
  const lockDir = getLockDir(dataDir);
  try {
    mkdirSync(lockDir);
    return true;
  } catch {
    return false;
  }
}

/** Release the lock.
 * @param {string} [dataDir]
 */
export function releaseLock(dataDir) {
  const lockDir = getLockDir(dataDir);
  try {
    rmdirSync(lockDir);
  } catch {}
}

// ── Service lifecycle ───────────────────────────────────────────────

const CONNECT_RETRY_DELAY = 50;
const CONNECT_MAX_RETRIES = 20;

/**
 * @typedef {Object} EnsureServiceOptions
 * @property {string} [dataDir]
 */

/**
 * Ensure the brain service is running and return a connected client.
 *
 * The service runs as a detached child process so it outlives the pi
 * session that spawned it. If the socket connect fails, we clean up
 * any stale socket, acquire a lock, spawn the service, then retry.
 *
 * @param {EnsureServiceOptions} [opts]
 * @returns {Promise<Client>}
 */
export async function ensureService(opts) {
  const dd = opts?.dataDir ?? getDataDir();
  const socketPath = getSocketPath(dd);

  // Try to connect to an existing service
  const client = new Client();
  try {
    await client.connect(socketPath);
    return client;
  } catch {
    // Connection failed — service likely not running
  }

  // Clean up stale socket file (leftover from crashed service)
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch (err) {
      throw new Error(`Failed to remove stale socket ${socketPath}: ${err}`);
    }
  }

  // Try to acquire lock and spawn the service
  if (tryAcquireLock(dd)) {
    try {
      const serviceScript = join(__dirname, "service-main.js");
      const child = spawn(process.execPath, [serviceScript, dd], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch (err) {
      throw new Error(`Failed to spawn brain service: ${err}`);
    } finally {
      releaseLock(dd);
    }
  }
  // else: lock already held — another process is spawning the service

  // Connect (with retries to allow the service to start)
  let lastError;
  for (let i = 0; i < CONNECT_MAX_RETRIES; i++) {
    await new Promise((r) => setTimeout(r, CONNECT_RETRY_DELAY));
    try {
      await client.connect(socketPath);
      return client;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `Failed to connect to brain service at ${socketPath} after ${CONNECT_MAX_RETRIES} retries: ${lastError}`,
  );
}
