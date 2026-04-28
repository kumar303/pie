/**
 * IPC protocol types for vs-code-but-chill.
 *
 * Newline-delimited JSON over a Unix domain socket.
 *
 * Scope is intentionally small: the extension uses IPC to (1) keep
 * the server alive while any pi session is attached, (2) ask for an
 * immediate `reap`, (3) ask for a graceful `stop`, and (4) receive
 * `killed` event notifications. Everything observable (logs, status)
 * is read from the on-disk log file instead of streamed.
 */

export type ProcessKind = "tsserver" | "eslint";

// ── Client → server requests ────────────────────────────────────────

export interface HelloMsg {
  type: "hello";
  pid: number;
}
export interface ByeMsg {
  type: "bye";
  pid: number;
}
export interface StopMsg {
  type: "stop";
}
export interface PingMsg {
  type: "ping";
}
/** Ask the server to run its monitoring tick once, immediately. */
export interface ReapMsg {
  type: "reap";
}

export type ClientMessage = HelloMsg | ByeMsg | StopMsg | PingMsg | ReapMsg;

// ── Server → client messages ─────────────────────────────────────────

export interface PongResponse {
  type: "pong";
}

/**
 * Broadcast when the server stops a monitored process. Every
 * connected client receives every stop — there's no opt-in; the
 * extension uses it to surface a UI toast.
 */
export interface KilledEvent {
  type: "killed";
  pid: number;
  kind: ProcessKind;
  workspace: string | null;
  workspacePath?: string;
  reason: string;
}

/**
 * Response to a `reap` request. `ok` indicates whether the tick ran
 * to completion; `killed` is the number of processes that were
 * stopped during this tick (0 is a valid success case and the
 * trigger for the "nothing to stop" UI notification).
 */
export interface ReapResponse {
  type: "reap";
  ok: boolean;
  killed: number;
  error?: string;
}

export type ServerMessage = PongResponse | KilledEvent | ReapResponse;

// ── Parsing helpers ───────────────────────────────────────────────────

/**
 * Parse a newline-delimited JSON line as a protocol message.
 *
 * The tagged union is checked only at the discriminator level: we
 * verify the shape is `{ type: string, ... }`, then return it as `T`.
 * Dispatchers use an exhaustive `switch (msg.type)` which treats any
 * unknown discriminator as a no-op, so a lightly-validated cast here
 * is sufficient — the worst that happens from a garbled peer is the
 * message gets dropped.
 *
 * Throws for malformed JSON and for messages missing the `type` tag,
 * so callers can surface them as protocol errors.
 */
export function parseProtocolMessage<T extends ClientMessage | ServerMessage>(
  line: string,
): T {
  const parsed: unknown = JSON.parse(line);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("type" in parsed) ||
    typeof parsed.type !== "string"
  ) {
    throw new Error("message has no string `type` discriminator");
  }
  return parsed as T;
}
