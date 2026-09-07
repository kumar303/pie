import { createHash, randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { chmod, readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { createServer, request, type Server } from "node:http";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionHandler,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import {
  ensureStorage,
  isCode,
  pathsFor,
  readRegistry,
  storageRoot,
  withRegistryLock,
  writeRegistry,
  type Member,
} from "./registry.js";

export interface JoinPi extends Pick<
  ExtensionAPI,
  "registerCommand" | "registerMessageRenderer" | "registerTool" | "sendMessage"
> {
  on(
    event: "session_shutdown",
    handler: ExtensionHandler<SessionShutdownEvent>,
  ): void;
}

type JoinContext = Pick<ExtensionCommandContext, "cwd" | "ui">;
type Peer = Member;

interface ActiveChannel {
  channel: string;
  member: Member;
  server: Server;
  peers: Map<string, Peer>;
  ctx: JoinContext;
}

interface HttpResult {
  status: number;
  body: unknown;
}

interface MemberHealth {
  original: Member;
  live: boolean;
}

const DEFAULT_CHANNEL = "__default__";
const JOIN_MESSAGE_TYPE = "join-message";
const STATUS_KEY = "/join";
const REQUEST_TIMEOUT_MS = 1_500;
const MAX_BODY_BYTES = 1024 * 1024;
const COMPLETIONS = ["-help", "-rename", "-leave"].map((value) => ({
  value,
  label: value,
}));

export function createExtension(pi: JoinPi): void {
  let active: ActiveChannel | undefined;
  let lastMessagedSessionId: string | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let handlersInstalled = false;

  const notifyError = (ctx: JoinContext, error: unknown): void => {
    ctx.ui.notify(errorMessage(error), "error");
  };

  pi.registerMessageRenderer(
    JOIN_MESSAGE_TYPE,
    (message, { expanded }, theme) => {
      const details = message.details as
        | { from?: string; text?: string }
        | undefined;
      const from = details?.from ?? "peer";
      const heading = theme.fg("accent", `[join message from peer "${from}"]`);
      if (!expanded) return new Text(heading, 0, 0);
      const text = stripTerminalSequences(details?.text ?? "");
      return new Text(`${heading}\n\n${theme.fg("muted", text)}`, 0, 0);
    },
  );

  const status = (): void => {
    if (!active) return;
    const channel = visibleChannel(active.channel);
    const prefix = channel ? `/join ${channel}` : "/join";
    const peerNames = [...active.peers.values()]
      .map((peer) => peer.name)
      .sort()
      .join(", ");
    active.ctx.ui.setWidget(STATUS_KEY, [
      `${prefix} 👽🪐🌎 · ${active.member.name} · peers: ${peerNames || "none"}`,
    ]);
  };

  const invalidRegistry =
    (ctx: JoinContext) =>
    (path: string): void => {
      ctx.ui.notify(`Invalid join registry moved to ${path}.`, "warning");
    };

  const removePeer = async (peer: Peer): Promise<void> => {
    if (!active) return;
    const current = active;
    current.peers.delete(peer.sessionId);
    if (lastMessagedSessionId === peer.sessionId)
      lastMessagedSessionId = undefined;
    const paths = pathsFor(current.channel);
    await withRegistryLock(paths.lock, async () => {
      const registry = await readRegistry(
        paths.registry,
        invalidRegistry(current.ctx),
      );
      registry.members = registry.members.filter(
        (member) => member.sessionId !== peer.sessionId,
      );
      await writeRegistry(paths.registry, registry);
    });
    status();
  };

  const postToPeer = async (
    peer: Peer,
    route: string,
    body: unknown,
    removeOnFailure: boolean,
  ): Promise<HttpResult> => {
    try {
      const result = await socketRequest(peer.sock, "POST", route, body);
      if (result.status < 200 || result.status >= 300) {
        throw new Error(responseError(result));
      }
      return result;
    } catch (error) {
      if (removeOnFailure && active?.peers.has(peer.sessionId)) {
        await removePeer(peer);
      }
      throw error;
    }
  };

  const closeActive = async (clearStatus: boolean): Promise<void> => {
    const leaving = active;
    if (!leaving) return;
    active = undefined;
    lastMessagedSessionId = undefined;

    await Promise.allSettled(
      [...leaving.peers.values()].map((peer) =>
        socketRequest(peer.sock, "POST", "/bye", {
          name: leaving.member.name,
          sessionId: leaving.member.sessionId,
        }),
      ),
    );

    const paths = pathsFor(leaving.channel);
    await withRegistryLock(paths.lock, async () => {
      const registry = await readRegistry(
        paths.registry,
        invalidRegistry(leaving.ctx),
      );
      registry.members = registry.members.filter(
        (member) => member.sessionId !== leaving.member.sessionId,
      );
      await writeRegistry(paths.registry, registry);
    }).catch((error: unknown) => notifyError(leaving.ctx, error));

    await closeServer(leaving.server);
    await unlink(leaving.member.sock).catch((error: unknown) => {
      if (!isCode(error, "ENOENT")) notifyError(leaving.ctx, error);
    });
    leaving.peers.clear();
    if (clearStatus) leaving.ctx.ui.setWidget(STATUS_KEY, undefined);
    removeProcessHandlers();
  };

  const receive = async (
    channel: ActiveChannel,
    from: string,
    sessionId: string,
    text: string,
  ): Promise<void> => {
    const peer = channel.peers.get(sessionId);
    if (!peer || peer.name !== from)
      throw new Error("Sender identity mismatch");
    lastMessagedSessionId = sessionId;
    const label = visibleChannel(channel.channel);
    const heading = label
      ? `[join message from peer "${peer.name}" in channel "${label}"]`
      : `[join message from peer "${peer.name}"]`;
    const guidance = `If this is a request, do the work, then reply to "${peer.name}" with exactly one join_send containing the result. If you need more information to do it, ask "${peer.name}" with exactly one join_send. If this is a result, an answer or an acknowledgement, do not reply.`;
    const peerText = stripTerminalSequences(text);
    const message = {
      customType: JOIN_MESSAGE_TYPE,
      content: `${heading}\n\n${peerText}\n\n[${guidance}]`,
      display: true,
      details: { from: peer.name, text: peerText },
    };
    try {
      pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
    } catch {
      pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
    }
  };

  const startServer = async (
    channel: string,
    member: Member,
    peers: Map<string, Peer>,
    ctx: JoinContext,
  ): Promise<Server> => {
    const server = createServer(async (req, res) => {
      try {
        const current = active;
        if (!current || current.member.sessionId !== member.sessionId) {
          sendJson(res, 410, { error: "Session is no longer joined" });
          return;
        }
        if (req.method === "GET" && req.url === "/ping") {
          sendJson(res, 200, {
            name: member.name,
            pid: member.pid,
            sessionId: member.sessionId,
          });
          return;
        }
        if (req.method !== "POST") {
          sendJson(res, 404, { error: "Unknown route" });
          return;
        }
        const body = await readBody(req);
        if (req.url === "/hello") {
          const peer = parseMember(body);
          if (peer.sessionId === member.sessionId) {
            throw new Error("Peer reused the local session UUID");
          }
          const collision = [...peers.values()].find(
            (known) =>
              known.sessionId !== peer.sessionId &&
              (known.name === peer.name ||
                known.sock === peer.sock ||
                known.pid === peer.pid),
          );
          if (collision) throw new Error("Peer identity collision");
          for (const [id, known] of peers) {
            if (id === peer.sessionId || known.sessionId === peer.sessionId) {
              peers.delete(id);
            }
          }
          peers.set(peer.sessionId, peer);
          status();
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.url === "/bye") {
          const value = record(body);
          const sessionId = requiredString(value, "sessionId");
          const name = sanitizeName(requiredString(value, "name"));
          const peer = peers.get(sessionId);
          if (!peer || peer.name !== name)
            throw new Error("Peer identity mismatch");
          peers.delete(sessionId);
          if (lastMessagedSessionId === sessionId)
            lastMessagedSessionId = undefined;
          status();
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.url === "/message") {
          const value = record(body);
          await receive(
            current,
            sanitizeName(requiredString(value, "from")),
            requiredString(value, "sessionId"),
            requiredString(value, "text"),
          );
          sendJson(res, 200, { delivered: true });
          return;
        }
        sendJson(res, 404, { error: "Unknown route" });
      } catch (error) {
        sendJson(res, 400, { error: errorMessage(error) });
      }
    });
    server.on("clientError", (error, socket) => {
      notifyError(ctx, error);
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(member.sock, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(member.sock, 0o600);
    return server;
  };

  const joinChannel = async (
    requestedChannel: string,
    ctx: JoinContext,
  ): Promise<void> => {
    const channel = normalizeChannel(requestedChannel);
    if (active?.channel === channel) {
      active.ctx = ctx;
      status();
      return;
    }
    if (active) await closeActive(true);

    const root = storageRoot();
    const repaired = await ensureStorage(root);
    if (repaired) {
      ctx.ui.notify(`Repaired insecure permissions on ${root}.`, "warning");
    }
    const paths = pathsFor(channel, root);
    let snapshot: Member[] = [];
    await withRegistryLock(paths.lock, async () => {
      snapshot = (await readRegistry(paths.registry, invalidRegistry(ctx)))
        .members;
    });

    const health = new Map<string, MemberHealth>();
    const protectedSockets = new Set<string>();
    for (const candidate of snapshot) {
      const live = await memberIsLive(candidate, protectedSockets);
      health.set(candidate.sessionId, { original: candidate, live });
    }
    await removeOrphanSockets(paths.sockets, channel, protectedSockets);

    let joined: ActiveChannel | undefined;
    try {
      await withRegistryLock(paths.lock, async () => {
        const registry = await readRegistry(
          paths.registry,
          invalidRegistry(ctx),
        );
        const live = registry.members.filter((candidate) => {
          const result = health.get(candidate.sessionId);
          if (!result) return true;
          if (!sameMember(candidate, result.original)) return true;
          return result.live;
        });
        const sessionId = randomUUID();
        const name = allocateName(ctx.cwd, live);
        const sock = socketPath(paths.sockets, channel, process.pid, sessionId);
        const member: Member = {
          name,
          sock,
          pid: process.pid,
          sessionId,
          joinedAt: Date.now(),
        };
        const peers = new Map(live.map((peer) => [peer.sessionId, peer]));
        const server = await startServer(channel, member, peers, ctx);
        joined = { channel, member, server, peers, ctx };
        active = joined;
        await writeRegistry(paths.registry, { members: [...live, member] });
      });
    } catch (error) {
      if (joined) {
        active = undefined;
        await closeServer(joined.server);
        try {
          await unlink(joined.member.sock);
        } catch (cleanupError) {
          if (!isCode(cleanupError, "ENOENT")) notifyError(ctx, cleanupError);
        }
      }
      throw error;
    }

    if (!joined) throw new Error("Join failed before the session started");
    installProcessHandlers();
    for (const peer of joined.peers.values()) {
      try {
        await postToPeer(peer, "/hello", joined.member, true);
      } catch (error) {
        notifyError(ctx, error);
      }
    }
    status();
  };

  const renameActive = async (
    rawName: string,
    ctx: JoinContext,
  ): Promise<void> => {
    if (!active)
      throw new Error("Join a channel before renaming this session.");
    const name = sanitizeName(rawName);
    if (name !== rawName || !/^[a-z0-9-]+$/.test(name)) {
      throw new Error("Names must match [a-z0-9-]+ and contain one token.");
    }
    if ([...active.peers.values()].some((peer) => peer.name === name)) {
      throw new Error(`The name "${name}" is already in use.`);
    }
    const current = active;
    const oldName = current.member.name;
    current.member.name = name;
    const paths = pathsFor(current.channel);
    try {
      await withRegistryLock(paths.lock, async () => {
        const registry = await readRegistry(
          paths.registry,
          invalidRegistry(ctx),
        );
        if (
          registry.members.some(
            (member) =>
              member.sessionId !== current.member.sessionId &&
              member.name === name,
          )
        ) {
          throw new Error(`The name "${name}" is already in use.`);
        }
        const local = registry.members.find(
          (member) => member.sessionId === current.member.sessionId,
        );
        if (!local) throw new Error("The local registry member is missing.");
        local.name = name;
        await writeRegistry(paths.registry, registry);
      });
    } catch (error) {
      current.member.name = oldName;
      throw error;
    }
    for (const peer of [...current.peers.values()]) {
      try {
        await postToPeer(peer, "/hello", current.member, true);
      } catch (error) {
        notifyError(ctx, error);
      }
    }
    status();
  };

  const cleanup = async (clearStatus = true): Promise<void> => {
    if (!cleanupPromise) {
      cleanupPromise = closeActive(clearStatus).finally(() => {
        cleanupPromise = undefined;
      });
    }
    await cleanupPromise;
  };

  const removeProcessHandlers = (): void => {
    if (!handlersInstalled) return;
    handlersInstalled = false;
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("exit", onExit);
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    void cleanup(false).finally(() => {
      removeProcessHandlers();
      if (process.listenerCount(signal) === 0) {
        process.kill(process.pid, signal);
      }
    });
  };
  const onSigint = (): void => onSignal("SIGINT");
  const onSigterm = (): void => onSignal("SIGTERM");
  const onExit = (): void => {
    if (active) {
      try {
        unlinkSync(active.member.sock);
      } catch (error) {
        if (!isCode(error, "ENOENT")) {
          active.ctx.ui.notify(errorMessage(error), "error");
        }
      }
    }
  };

  const installProcessHandlers = (): void => {
    if (handlersInstalled) return;
    handlersInstalled = true;
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    process.on("exit", onExit);
  };

  pi.on("session_shutdown", async () => {
    await cleanup();
    removeProcessHandlers();
  });

  pi.registerCommand("join", {
    description: "Join a message pool to collaborate with other agents",
    getArgumentCompletions: (prefix: string) => {
      const value = prefix.trim();
      if (value !== "" && !value.startsWith("-")) return null;
      return COMPLETIONS.filter((item) => item.value.startsWith(value));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        const value = stripTerminalSequences(args).trim();
        if (value === "-help") {
          ctx.ui.notify(joinUsage(), "info");
        } else if (value === "-leave") {
          if (!active) throw new Error("This session is not joined.");
          await cleanup();
        } else if (value === "-rename" || value.startsWith("-rename ")) {
          await renameActive(value.slice("-rename".length).trim(), ctx);
        } else if (value.startsWith("-")) {
          throw new Error(joinUsage());
        } else {
          await joinChannel(value || DEFAULT_CHANNEL, ctx);
        }
      } catch (error) {
        notifyError(ctx, error);
      }
    },
  });

  pi.registerTool({
    name: "join_send",
    label: "Send Join Message",
    description:
      "Send a request, a finished result, or a blocking question to exactly one known join peer by name. Do not use it for acknowledgements, thanks, greetings or progress updates.",
    promptSnippet:
      "join_send: send a request, result, or blocking question to one join peer",
    promptGuidelines: joinProtocol(),
    parameters: Type.Object({
      to: Type.String({ description: "The exact peer name" }),
      text: Type.String({
        description:
          "The message to send: a complete request, the complete result of a request, or a question you need answered to continue",
      }),
    }),
    async execute(_toolCallId, params) {
      if (!active) return toolText("Error: this session is not joined.");
      const to = sanitizeName(params.to);
      const peer = [...active.peers.values()].find((item) => item.name === to);
      if (!peer) return toolText(unknownPeerError(to, active));
      const sender = active.member;
      try {
        await postToPeer(
          peer,
          "/message",
          {
            from: sender.name,
            sessionId: sender.sessionId,
            text: stripTerminalSequences(params.text),
          },
          true,
        );
        return toolText(`Delivered message to "${peer.name}".`);
      } catch (error) {
        return toolText(
          `Delivery to "${peer.name}" failed: ${errorMessage(error)}`,
        );
      }
    },
  });

  pi.registerTool({
    name: "join_list_peers",
    label: "List Join Peers",
    description: "List the peers currently known to this joined session.",
    promptSnippet: "join_list_peers: list peers in the current join channel",
    promptGuidelines: [
      "Use join_list_peers before join_send when the requested join peer name is unknown, ambiguous, or may be misspelled.",
      "The join peer with `lastMessagedYou: true` sent the latest incoming message.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const peers = active
        ? [...active.peers.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((peer) => ({
              name: peer.name,
              lastMessagedYou: peer.sessionId === lastMessagedSessionId,
            }))
        : [];
      return toolText(JSON.stringify(peers));
    },
  });
}

export default function joinExtension(pi: ExtensionAPI): void {
  createExtension(pi);
}

function joinProtocol(): string[] {
  return [
    "Joining a channel is not a task. Do nothing with join_send or join_list_peers until a human or a join peer asks you for something.",
    'Join peers are other agents, named after their working directory plus a number (for example "website1"). Use these names with join_send.',
    "join_send({ to, text }) sends to exactly one join peer by name. Both fields are required.",
    "join_list_peers() lists the join peers currently known to this session.",
    "When a join peer asks you for something, do the work first. When it is finished, send the sender exactly one join_send containing the complete result. The sender only learns the result from that message.",
    "If you cannot do the work without more information, send the join peer exactly one join_send with your question, then stop and wait.",
    "Do not acknowledge a join message when it arrives. Do not send progress updates, thanks, confirmations, greetings, or emoji through join_send. A message that needs no action from the recipient must not be sent.",
    "When a join peer sends you a result you asked for, use it and do not reply through join_send.",
    "Never send a message through join_send unless a human or a join peer asked you to do something that needs it.",
  ];
}

function unknownPeerError(to: string, active: ActiveChannel): string {
  const known = [...active.peers.values()]
    .map((peer) => peer.name)
    .sort((a, b) => a.localeCompare(b));
  const hint = known.length
    ? `Known peers: ${known.join(", ")}. Use one of those exact names.`
    : "No peers are connected yet.";
  return `Error: unknown peer "${to}". ${hint}`;
}

function joinUsage(): string {
  return "Usage: /join [channel] | -rename <name> | -leave | -help";
}

function visibleChannel(channel: string): string {
  return channel === DEFAULT_CHANNEL ? "" : stripTerminalSequences(channel);
}

function normalizeChannel(raw: string): string {
  const value = stripTerminalSequences(raw).trim().toLowerCase();
  if (value === DEFAULT_CHANNEL) return value;
  if (!/^[a-z0-9-]+$/.test(value)) {
    throw new Error("Channels must match [a-z0-9-]+ and contain one token.");
  }
  return value;
}

function sameMember(left: Member, right: Member): boolean {
  return (
    left.name === right.name &&
    left.sock === right.sock &&
    left.pid === right.pid &&
    left.sessionId === right.sessionId &&
    left.joinedAt === right.joinedAt
  );
}

function allocateName(cwd: string, members: Member[]): string {
  const base =
    basename(cwd)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "pi";
  const names = new Set(members.map((member) => member.name));
  let index = 1;
  while (names.has(`${base}${index}`)) index += 1;
  return `${base}${index}`;
}

function sanitizeName(value: string): string {
  return stripTerminalSequences(value).trim().toLowerCase();
}

export function stripTerminalSequences(value: string): string {
  const escape = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const osc = new RegExp(
    `${escape}\\][^${bell}]*(?:${bell}|${escape}\\\\)`,
    "g",
  );
  const csi = new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g");
  const shortEscape = new RegExp(`${escape}[@-_]`, "g");
  const withoutEscapes = value
    .replace(osc, "")
    .replace(csi, "")
    .replace(shortEscape, "");
  return [...withoutEscapes]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (
        code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
      );
    })
    .join("");
}

function socketPath(
  directory: string,
  channel: string,
  pid: number,
  sessionId: string,
): string {
  const ordinary = join(directory, `${channel}-${pid}.sock`);
  if (Buffer.byteLength(ordinary) <= 100 && !existsSync(ordinary))
    return ordinary;
  const channelHash = createHash("sha256")
    .update(channel)
    .digest("hex")
    .slice(0, 6);
  const socketHash = createHash("sha256")
    .update(`${channel}:${pid}:${sessionId}`)
    .digest("hex")
    .slice(0, 8);
  return join(directory, `h-${channelHash}-${socketHash}.sock`);
}

async function removeOrphanSockets(
  directory: string,
  channel: string,
  protectedPaths: Set<string>,
): Promise<void> {
  const ordinaryPrefix = `${channel}-`;
  const hashedPrefix = `h-${createHash("sha256")
    .update(channel)
    .digest("hex")
    .slice(0, 6)}-`;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const belongsToChannel =
      entry.name.startsWith(ordinaryPrefix) ||
      entry.name.startsWith(hashedPrefix);
    if (
      !belongsToChannel ||
      !entry.name.endsWith(".sock") ||
      !entry.isSocket()
    ) {
      continue;
    }
    const path = join(directory, entry.name);
    if (protectedPaths.has(path)) continue;
    if (!(await socketIsConfirmedDead(path))) continue;
    await unlink(path).catch((error: unknown) => {
      if (!isCode(error, "ENOENT")) throw error;
    });
  }
}

async function memberIsLive(
  candidate: Member,
  protectedSockets: Set<string>,
): Promise<boolean> {
  try {
    const ping = await socketRequest(candidate.sock, "GET", "/ping");
    if (ping.status === 200) protectedSockets.add(candidate.sock);
    const identity = record(ping.body);
    return (
      ping.status === 200 &&
      requiredString(identity, "sessionId") === candidate.sessionId &&
      requiredString(identity, "name") === candidate.name &&
      requiredNumber(identity, "pid") === candidate.pid &&
      sanitizeName(candidate.name) === candidate.name
    );
  } catch {
    return false;
  }
}

function socketIsConfirmedDead(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ socketPath: socket, method: "GET", path: "/ping" });
    let receivedResponse = false;
    req.on("response", (response) => {
      receivedResponse = true;
      response.resume();
      resolve(false);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error("Socket liveness check timed out"));
    });
    req.on("error", (error) => {
      if (receivedResponse) return;
      resolve(isCode(error, "ENOENT") || isCode(error, "ECONNREFUSED"));
    });
    req.end();
  });
}

function socketRequest(
  socket: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<HttpResult> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        method,
        path,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(new Error("Peer response exceeded the size limit"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({
              status: res.statusCode ?? 500,
              body: text ? JSON.parse(text) : {},
            });
          } catch {
            reject(new Error("Peer returned invalid JSON"));
          }
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(
        new Error(`Peer request timed out after ${REQUEST_TIMEOUT_MS}ms`),
      );
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function readBody(req: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES)
      throw new Error("Request body exceeded the size limit");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function parseMember(value: unknown): Member {
  const body = record(value);
  const rawName = requiredString(body, "name");
  const name = sanitizeName(rawName);
  if (name !== rawName || !/^[a-z0-9-]+$/.test(name)) {
    throw new Error("Peer name is invalid");
  }
  return {
    name,
    sock: stripTerminalSequences(requiredString(body, "sock")),
    pid: requiredNumber(body, "pid"),
    sessionId: requiredString(body, "sessionId"),
    joinedAt: typeof body.joinedAt === "number" ? body.joinedAt : Date.now(),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected a JSON object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string")
    throw new Error(`Missing string field: ${key}`);
  return value[key];
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  if (typeof value[key] !== "number")
    throw new Error(`Missing number field: ${key}`);
  return value[key];
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function responseError(result: HttpResult): string {
  try {
    const body = record(result.body);
    return typeof body.error === "string"
      ? body.error
      : `Peer returned HTTP ${result.status}`;
  } catch {
    return `Peer returned HTTP ${result.status}`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function toolText(text: string): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, never>;
} {
  return { content: [{ type: "text", text }], details: {} };
}
