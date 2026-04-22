/**
 * IPC protocol types for vs-code-but-chill.
 *
 * Newline-delimited JSON over a Unix domain socket.
 */

export type TsServerMode = "full" | "partialSemantic";

// ── Client → server requests ────────────────────────────────────────

export interface HelloMsg {
  type: "hello";
  pid: number;
}
export interface ByeMsg {
  type: "bye";
  pid: number;
}
export interface StatusMsg {
  type: "status";
}
export interface LogsMsg {
  type: "logs";
  tail?: number;
}
export interface EventsMsg {
  type: "events";
}
export interface StopMsg {
  type: "stop";
}
export interface PingMsg {
  type: "ping";
}

export type ClientMessage =
  | HelloMsg
  | ByeMsg
  | StatusMsg
  | LogsMsg
  | EventsMsg
  | StopMsg
  | PingMsg;

// ── Server → client responses / events ──────────────────────────────

export interface StatusResponse {
  type: "status";
  uptimeSec: number;
  killed: number;
  watching: Array<{
    pid: number;
    rssMb: number;
    mode: TsServerMode;
    workspace: string | null;
    etimeSec: number;
  }>;
}

export interface LogLineResponse {
  type: "log";
  line: string;
}

export interface PongResponse {
  type: "pong";
}

export interface KilledEvent {
  type: "killed";
  pid: number;
  workspace: string | null;
  workspacePath?: string;
  rssMb: number;
  mode: TsServerMode;
  reason: string;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export interface AckResponse {
  type: "ack";
  of: string;
}

export type ServerMessage =
  | StatusResponse
  | LogLineResponse
  | PongResponse
  | KilledEvent
  | ErrorEvent
  | AckResponse;

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
