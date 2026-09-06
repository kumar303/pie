// Minimal client for `pi --mode rpc` (JSONL over stdin/stdout).
// See ~/.pi/pkg/pi-*/docs/rpc.md for the protocol.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

/**
 * Attach a strict JSONL reader (LF only; strips a trailing CR).
 * Node's readline also splits on U+2028/U+2029, which is not protocol compliant.
 */
function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    }
  });
  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.length > 0) onLine(buffer);
  });
}

export class PiRpcSession {
  /**
   * @param {object} options
   * @param {string} options.name   Label used in logs/transcripts.
   * @param {string} options.cwd    Working directory for the pi process.
   * @param {string[]} options.args CLI args (without `--mode rpc`).
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {string} [options.piBin]
   * @param {(entry: object) => void} [options.onEvent]
   */
  constructor(options) {
    this.name = options.name;
    this.events = []; // every event, with a monotonic seq and timestamp
    this.stderr = "";
    this.exited = false;
    this.exitInfo = undefined;
    this.pending = new Map();
    this.waiters = new Set();
    this.onEvent = options.onEvent;
    this.startedAt = Date.now();
    this.seq = 0;

    this.child = spawn(
      options.piBin ?? "pi",
      ["--mode", "rpc", ...options.args],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
      if (this.stderr.length > 200_000)
        this.stderr = this.stderr.slice(-100_000);
    });
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      for (const { reject } of this.pending.values()) {
        reject(
          new Error(`${this.name}: pi exited (code=${code}, signal=${signal})`),
        );
      }
      this.pending.clear();
      this.#notifyWaiters();
    });
    attachJsonlReader(this.child.stdout, (line) => this.#handleLine(line));
  }

  #handleLine(line) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      this.stderr += `\n[non-JSON stdout] ${line}`;
      return;
    }
    if (entry.type === "response" && entry.id && this.pending.has(entry.id)) {
      const { resolve, reject } = this.pending.get(entry.id);
      this.pending.delete(entry.id);
      if (entry.success) resolve(entry);
      else
        reject(
          new Error(
            `${this.name}: ${entry.command} failed: ${entry.error ?? "unknown error"}`,
          ),
        );
      return;
    }
    const record = {
      seq: this.seq++,
      at: Date.now() - this.startedAt,
      ...entry,
    };
    this.events.push(record);
    this.onEvent?.(record);
    this.#notifyWaiters();
  }

  #notifyWaiters() {
    for (const waiter of [...this.waiters]) waiter();
  }

  /** Send a command and wait for its response. */
  send(command) {
    if (this.exited)
      return Promise.reject(new Error(`${this.name}: pi already exited`));
    const id = randomUUID();
    const payload = JSON.stringify({ id, ...command }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(payload, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  /** Send a user prompt (or an extension slash command such as `/join`). */
  prompt(message, extra = {}) {
    return this.send({ type: "prompt", message, ...extra });
  }

  /**
   * Wait until `predicate(event)` is true for some event with seq >= fromSeq.
   * Resolves with the matching event, or rejects on timeout / process exit.
   */
  waitFor(predicate, { timeoutMs, fromSeq = 0, label = "event" }) {
    const find = () =>
      this.events.find((event) => event.seq >= fromSeq && predicate(event));
    const found = find();
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(
          new TimeoutError(
            `${this.name}: timed out after ${timeoutMs}ms waiting for ${label}`,
          ),
        );
      }, timeoutMs);
      const check = () => {
        const match = find();
        if (match) {
          clearTimeout(timer);
          this.waiters.delete(check);
          resolve(match);
        } else if (this.exited) {
          clearTimeout(timer);
          this.waiters.delete(check);
          reject(
            new Error(`${this.name}: pi exited while waiting for ${label}`),
          );
        }
      };
      this.waiters.add(check);
    });
  }

  /** Wait for the agent to fully settle (no retry / queued continuation left). */
  waitForSettled(options) {
    return this.waitFor((event) => event.type === "agent_settled", {
      ...options,
      label: options.label ?? "agent_settled",
    });
  }

  nextSeq() {
    return this.seq;
  }

  async abort() {
    if (this.exited) return;
    try {
      await this.send({ type: "abort" });
    } catch {
      // Best effort; the process may be shutting down.
    }
  }

  /** Terminate the process: close stdin, SIGTERM, then SIGKILL after a grace period. */
  async close({ graceMs = 3000 } = {}) {
    if (this.exited) return;
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (!this.exited) this.child.kill("SIGKILL");
    }, graceMs);
    await exited;
    clearTimeout(timer);
  }
}

export class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "TimeoutError";
  }
}
