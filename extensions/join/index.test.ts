import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { createExtension, type JoinPi } from "./index.js";
import {
  readRegistry,
  withRegistryLock,
  writeRegistry,
  type Registry,
} from "./registry.js";

type RegisteredTool = Parameters<JoinPi["registerTool"]>[0];
type ToolResult = Awaited<ReturnType<RegisteredTool["execute"]>>;
type RegisteredCommand = Parameters<JoinPi["registerCommand"]>[1];
type EventHandler = Parameters<JoinPi["on"]>[1];
type MessageRenderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];
type SendMessageCall = {
  message: Parameters<JoinPi["sendMessage"]>[0];
  options?: Parameters<JoinPi["sendMessage"]>[1];
};
type MockUi = Pick<ExtensionUIContext, "notify" | "setWidget">;
type MockCtx = Pick<ExtensionCommandContext, "cwd"> & { ui: MockUi };

interface HarnessOptions {
  cwd?: string;
  failSteer?: boolean;
}

interface Harness {
  commands: Map<string, RegisteredCommand>;
  tools: Map<string, RegisteredTool>;
  events: Map<string, EventHandler[]>;
  renderers: Map<string, MessageRenderer>;
  messages: SendMessageCall[];
  ctx: MockCtx;
  widgets: Map<string, string | undefined>;
  widgetCalls: Array<{ key: string; value: string | undefined }>;
  notifications: Array<{ message: string; level?: string }>;
  shutdown(): Promise<void>;
}

let home: string;
const harnesses: Harness[] = [];
const extraServers: Server[] = [];
const extraPaths: string[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "join-pi-test-"));
  process.env.JOIN_PI_HOME = home;
});

afterEach(async () => {
  const errors: unknown[] = [];
  const shutdowns = await Promise.allSettled(
    harnesses.splice(0).map((harness) => harness.shutdown()),
  );
  errors.push(...rejectionReasons(shutdowns));

  const serverClosures = await Promise.allSettled(
    extraServers.splice(0).map(closeTestServer),
  );
  errors.push(...rejectionReasons(serverClosures));

  delete process.env.JOIN_PI_HOME;
  const removals = await Promise.allSettled([
    ...extraPaths.splice(0).map((path) => rm(path, { force: true })),
    rm(home, { recursive: true, force: true }),
  ]);
  errors.push(...rejectionReasons(removals));

  if (errors.length > 0)
    throw new AggregateError(errors, "Test teardown failed");
});

function rejectionReasons(results: PromiseSettledResult<unknown>[]): unknown[] {
  return results
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map((result) => result.reason);
}

function closeTestServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function startExtraServer(
  path: string,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Server> {
  const server = createServer(handler);
  extraServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return server;
}

function makeHarness({
  cwd = "/tmp/pie",
  failSteer = false,
}: HarnessOptions = {}): Harness {
  const commands = new Map<string, RegisteredCommand>();
  const tools = new Map<string, RegisteredTool>();
  const events = new Map<string, EventHandler[]>();
  const renderers = new Map<string, MessageRenderer>();
  const messages: Harness["messages"] = [];
  const widgets = new Map<string, string | undefined>();
  const widgetCalls: Harness["widgetCalls"] = [];
  const notifications: Harness["notifications"] = [];

  const api: JoinPi = {
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerMessageRenderer(customType, renderer) {
      renderers.set(customType, renderer);
    },
    on(name, handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    sendMessage(message, options) {
      if (failSteer && options?.deliverAs === "steer") {
        throw new Error("steering unavailable");
      }
      messages.push({ message, options });
    },
  };
  const ui: MockUi = {
    setWidget(key, value) {
      if (value !== undefined && !Array.isArray(value)) {
        throw new Error("Test setup failed: join widget must use text lines");
      }
      const text = value?.join("\n");
      widgets.set(key, text);
      widgetCalls.push({ key, value: text });
    },
    notify(message, level) {
      notifications.push({ message, level });
    },
  };
  const ctx: MockCtx = { cwd, ui };

  createExtension(api);
  const harness: Harness = {
    commands,
    tools,
    events,
    renderers,
    messages,
    ctx,
    widgets,
    widgetCalls,
    notifications,
    async shutdown() {
      for (const handler of events.get("session_shutdown") ?? []) {
        await handler(
          { type: "session_shutdown", reason: "quit" },
          ctx as ExtensionContext,
        );
      }
    },
  };
  harnesses.push(harness);
  return harness;
}

function resultText(result: ToolResult): string {
  const content = result.content[0];
  if (content?.type !== "text") {
    throw new Error("Test setup failed: tool did not return text content");
  }
  return content.text;
}

function requiredValue<T>(value: T | undefined, description: string): T {
  if (value === undefined)
    throw new Error(`Test setup failed: missing ${description}`);
  return value;
}

async function readChannelRegistry(channel: string): Promise<Registry> {
  return readRegistry(join(home, "channels", `${channel}.json`));
}

async function command(harness: Harness, args: string): Promise<void> {
  const registered = harness.commands.get("join");
  if (!registered) throw new Error("Missing command: join");
  await registered.handler(args, harness.ctx as ExtensionCommandContext);
}

async function makeJoinedPair({
  channel,
  cwd,
  secondFailSteer = false,
}: {
  channel: string;
  cwd: string;
  secondFailSteer?: boolean;
}): Promise<{ first: Harness; second: Harness }> {
  const first = makeHarness({ cwd });
  const second = makeHarness({ cwd, failSteer: secondFailSteer });
  await command(first, channel);
  await command(second, channel);
  return { first, second };
}

async function tool(
  harness: Harness,
  name: string,
  params: Record<string, string> = {},
): Promise<ToolResult> {
  const registered = harness.tools.get(name);
  if (!registered) throw new Error(`Missing tool: ${name}`);
  return registered.execute(
    "call",
    params,
    new AbortController().signal,
    vi.fn(),
    harness.ctx as ExtensionContext,
  );
}

describe("join extension", () => {
  it("joins the default channel with private storage and a generated name", async () => {
    const harness = makeHarness({ cwd: "/tmp/pie" });
    await command(harness, "");

    expect(harness.widgets.get("/join")).toBe(
      "/join 👽🪐🌎 · pie1 · peers: none",
    );
    const registryPath = join(home, "channels", "__default__.json");
    const registry = await readChannelRegistry("__default__");
    expect(registry.members[0]?.name).toBe("pie1");
    expect(
      (await stat(home)).mode & 0o777,
      "the storage root must allow owner access only",
    ).toBe(0o700);
    expect(
      (await stat(registryPath)).mode & 0o777,
      "the registry must allow owner access only",
    ).toBe(0o600);
    const localMember = requiredValue(
      registry.members[0],
      "local default-channel registry member",
    );
    expect(
      (await stat(localMember.sock)).mode & 0o777,
      "the Unix socket must allow owner access only",
    ).toBe(0o600);
  });

  it("refreshes status without another prompt when joining the current channel", async () => {
    const harness = makeHarness();
    await command(harness, "team");
    const calls = harness.widgetCalls.length;
    const messages = harness.messages.length;

    await command(harness, "team");

    expect(harness.widgetCalls).toHaveLength(calls + 1);
    expect(harness.messages).toHaveLength(messages);
  });

  it("adds the join protocol to the agent prompt without adding a transcript message", async () => {
    const harness = makeHarness();
    await command(harness, "team");

    expect(harness.messages).toEqual([]);
    const send = harness.tools.get("join_send");
    expect(send?.promptSnippet).toContain("join_send");
    expect(send?.promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("not a task"),
        expect.stringContaining("working directory plus a number"),
        expect.stringContaining("Both fields are required"),
        expect.stringContaining("join_list_peers"),
        expect.stringContaining("complete result"),
        expect.stringContaining("only learns the result"),
        expect.stringContaining("Do not acknowledge"),
        expect.stringContaining("use it and do not reply"),
        expect.stringContaining("Never send a message"),
      ]),
    );
  });

  it("describes the tools in terms of requests, results and questions", () => {
    const harness = makeHarness();
    const send = harness.tools.get("join_send");
    expect(send?.description).toContain("result");
    expect(send?.description).toContain("Do not use it for acknowledgements");
  });

  it("tells the receiver when a reply is and is not expected", async () => {
    const { first, second } = await makeJoinedPair({
      channel: "team",
      cwd: "/tmp/pie",
    });

    await tool(first, "join_send", { to: "pie2", text: "finish task 4" });

    const received = requiredValue(
      second.messages.at(-1)?.message,
      "received join message",
    );
    const content = String(received.content);
    expect(content).toContain(
      '[join message from peer "pie1" in channel "team"]',
    );
    expect(content).toContain("finish task 4");
    expect(content).toContain('reply to "pie1" with exactly one join_send');
    expect(content).toContain("do not reply");
    expect(received.details).toEqual({ from: "pie1", text: "finish task 4" });

    const renderer = requiredValue(
      second.renderers.get("join-message"),
      "join message renderer",
    );
    const renderedMessage = {
      role: "custom" as const,
      timestamp: 0,
      ...received,
    };
    const component = renderer(
      renderedMessage,
      { expanded: false } as Parameters<MessageRenderer>[1],
      {
        fg: (_color: string, text: string) => text,
      } as Parameters<MessageRenderer>[2],
    );
    expect(component.render(100).map((line) => line.trimEnd())).toEqual([
      '👽 message from "pie1"',
    ]);
    const expanded = renderer(
      renderedMessage,
      { expanded: true } as Parameters<MessageRenderer>[1],
      {
        fg: (_color: string, text: string) => text,
      } as Parameters<MessageRenderer>[2],
    )
      .render(100)
      .join("\n");
    expect(expanded).toContain("finish task 4");
    expect(expanded).not.toContain("If this is a request");
  });

  it("lists the known peers when a message is addressed to an unknown name", async () => {
    const { first } = await makeJoinedPair({
      channel: "team",
      cwd: "/tmp/pie",
    });

    const result = await tool(first, "join_send", {
      to: "pie3",
      text: "hello",
    });

    expect(resultText(result)).toBe(
      'Error: unknown peer "pie3". Known peers: pie2. Use one of those exact names.',
    );
  });

  it("connects two sessions and sends an attributed direct message", async () => {
    const { first, second } = await makeJoinedPair({
      channel: "team",
      cwd: "/tmp/pie",
    });

    expect(first.widgets.get("/join")).toBe(
      "/join team 👽🪐🌎 · pie1 · peers: pie2",
    );
    expect(second.widgets.get("/join")).toBe(
      "/join team 👽🪐🌎 · pie2 · peers: pie1",
    );

    const result = await tool(first, "join_send", {
      to: "pie2",
      text: "finish task 4",
    });
    expect(resultText(result)).toBe('Delivered message to "pie2".');
    expect(second.messages.at(-1)).toMatchObject({
      message: {
        customType: "join-message",
        content: expect.stringContaining("finish task 4"),
      },
      options: { triggerTurn: true, deliverAs: "steer" },
    });

    const peers = await tool(second, "join_list_peers");
    expect(JSON.parse(resultText(peers))).toEqual([
      { name: "pie1", lastMessagedYou: true },
    ]);
  });

  it("retries received messages as a follow-up when steering fails", async () => {
    const { first, second } = await makeJoinedPair({
      channel: "team",
      cwd: "/tmp/pie",
      secondFailSteer: true,
    });

    await tool(first, "join_send", { to: "pie2", text: "hello" });

    expect(second.messages.at(-1)).toMatchObject({
      message: { customType: "join-message" },
      options: { triggerTurn: true, deliverAs: "followUp" },
    });
  });

  it("removes a peer after a direct delivery fails", async () => {
    const { first } = await makeJoinedPair({
      channel: "team",
      cwd: "/tmp/pie",
    });
    const registry = await readChannelRegistry("team");
    const secondSocket = requiredValue(
      registry.members.find((member) => member.name === "pie2")?.sock,
      'socket for peer "pie2"',
    );
    await unlink(secondSocket);

    const result = await tool(first, "join_send", {
      to: "pie2",
      text: "hello",
    });
    expect(resultText(result)).toMatch(/^Delivery to "pie2" failed: .+/);
    expect(first.widgets.get("/join")).toBe(
      "/join team 👽🪐🌎 · pie1 · peers: none",
    );
    const updated = await readChannelRegistry("team");
    expect(updated.members.map((member) => member.name)).toEqual(["pie1"]);
  });

  it("reuses a stale member name after pruning it", async () => {
    await mkdir(join(home, "channels"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(home, "channels", "team.json"),
      JSON.stringify({
        members: [
          {
            name: "pie1",
            sock: join(home, "sock", "missing.sock"),
            pid: 2_147_483_647,
            sessionId: "stale-session",
            joinedAt: 0,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const harness = makeHarness({ cwd: "/tmp/pie" });

    await command(harness, "team");

    expect(harness.widgets.get("/join")).toBe(
      "/join team 👽🪐🌎 · pie1 · peers: none",
    );
  });

  it("quarantines an invalid registry and repairs root permissions", async () => {
    await chmod(home, 0o755);
    await mkdir(join(home, "channels"), { mode: 0o700 });
    await writeFile(join(home, "channels", "team.json"), "not json", {
      mode: 0o600,
    });
    const harness = makeHarness();

    await command(harness, "team");

    expect(harness.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("Repaired"),
        }),
        expect.objectContaining({
          message: expect.stringContaining("Invalid join registry moved"),
        }),
      ]),
    );
    expect(
      (await readdir(join(home, "channels"))).some((entry) =>
        entry.startsWith("team.json.invalid-"),
      ),
    ).toBe(true);
  });

  it("expires a contender older than five seconds even when its pid is alive", async () => {
    const lock = join(home, "registry.lock");
    const stale = `${lock}.stale-live-owner`;
    await writeFile(
      stale,
      JSON.stringify({
        pid: process.pid,
        createdAt: Date.now() - 6_000,
        token: "stale-live-owner",
        choosing: false,
        ticket: 1,
      }),
    );
    let entered = false;

    await withRegistryLock(lock, async () => {
      entered = true;
    });

    expect(
      entered,
      "the new contender must enter after it removes the expired contender",
    ).toBe(true);
    await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the previous registry readable when atomic rename fails", async () => {
    const registry = join(home, "registry.json");
    const previous = { members: [] };
    await writeFile(registry, `${JSON.stringify(previous)}\n`, { mode: 0o600 });

    await expect(
      writeRegistry(
        registry,
        {
          members: [
            {
              name: "pie1",
              sock: "/tmp/pie1.sock",
              pid: 1,
              sessionId: "session",
              joinedAt: 0,
            },
          ],
        },
        {
          rename: async () => {
            throw new Error("simulated crash before rename");
          },
        },
      ),
    ).rejects.toThrow("simulated crash before rename");

    await expect(readFile(registry, "utf8")).resolves.toBe(
      `${JSON.stringify(previous)}\n`,
    );
    expect(
      (await readdir(home)).filter((entry) => entry.includes(".tmp-")),
    ).toEqual([]);
  });

  it("serializes two simultaneous stale-lock reclaimers", async () => {
    const lock = join(home, "registry.lock");
    await writeFile(
      `${lock}.dead-owner`,
      JSON.stringify({
        pid: 2_147_483_647,
        createdAt: 0,
        token: "dead-owner",
        choosing: false,
        ticket: 1,
      }),
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let activeSections = 0;
    let maxActiveSections = 0;
    let operationCount = 0;
    const operation = async (): Promise<void> => {
      activeSections += 1;
      maxActiveSections = Math.max(maxActiveSections, activeSections);
      operationCount += 1;
      markEntered();
      if (operationCount === 1) await held;
      activeSections -= 1;
    };

    const contenders = [
      withRegistryLock(lock, operation),
      withRegistryLock(lock, operation),
    ];
    await entered;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      maxActiveSections,
      "only one stale-lock reclaimer may enter the critical section",
    ).toBe(1);
    release();
    await Promise.all(contenders);

    expect(
      maxActiveSections,
      "the critical sections must remain serialized after both contenders finish",
    ).toBe(1);
    expect(
      (await readdir(home)).filter((entry) =>
        entry.startsWith("registry.lock."),
      ),
    ).toEqual([]);
  });

  it("never unlinks unowned files or a live socket with another UUID", async () => {
    const outside = join(tmpdir(), `join-outside-${process.pid}.txt`);
    const sockets = join(home, "sock");
    const channels = join(home, "channels");
    await mkdir(sockets, { recursive: true, mode: 0o700 });
    await mkdir(channels, { recursive: true, mode: 0o700 });
    await writeFile(outside, "keep me");
    extraPaths.push(outside);
    const regularSocketName = join(sockets, "team-regular.sock");
    await writeFile(regularSocketName, "not a socket");
    const startingSocket = join(sockets, "team-starting.sock");
    const startingServer = await startExtraServer(
      startingSocket,
      (_request, response) => {
        response.writeHead(410, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Session is still starting" }));
      },
    );
    const reusedSocket = join(sockets, "team-reused.sock");
    const server = await startExtraServer(
      reusedSocket,
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            name: "replacement",
            pid: 999,
            sessionId: "new-uuid",
          }),
        );
      },
    );
    await writeFile(
      join(channels, "team.json"),
      JSON.stringify({
        members: [
          {
            name: "outside1",
            sock: outside,
            pid: 111,
            sessionId: "outside-uuid",
            joinedAt: 0,
          },
          {
            name: "old1",
            sock: reusedSocket,
            pid: 222,
            sessionId: "old-uuid",
            joinedAt: 0,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const harness = makeHarness();

    await command(harness, "team");

    await expect(readFile(outside, "utf8")).resolves.toBe("keep me");
    await expect(readFile(regularSocketName, "utf8")).resolves.toBe(
      "not a socket",
    );
    expect(
      server.listening,
      "UUID mismatch pruning must not stop the replacement peer server",
    ).toBe(true);
    expect(
      startingServer.listening,
      "orphan cleanup must preserve a concurrently starting server",
    ).toBe(true);
    expect(
      (await stat(startingSocket)).isSocket(),
      "orphan cleanup must preserve the starting server socket path",
    ).toBe(true);
  });

  it("removes hashed orphan sockets for the joined channel", async () => {
    const channel = "team";
    const sockets = join(home, "sock");
    await mkdir(sockets, { recursive: true, mode: 0o700 });
    const channelHash = createHash("sha256")
      .update(channel)
      .digest("hex")
      .slice(0, 6);
    const orphan = join(sockets, `h-${channelHash}-deadbeef.sock`);
    execFileSync(process.execPath, [
      "-e",
      'require("node:http").createServer().listen(process.argv[1], () => process.exit(0))',
      orphan,
    ]);
    expect(
      (await stat(orphan)).isSocket(),
      "the crash fixture must create a real orphaned Unix socket",
    ).toBe(true);
    const harness = makeHarness();

    await command(harness, channel);

    await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs process handlers only while joined", async () => {
    const baseline = {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
      exit: process.listenerCount("exit"),
    };
    const harness = makeHarness();
    expect(process.listenerCount("SIGINT")).toBe(baseline.sigint);

    await command(harness, "team");
    expect(process.listenerCount("SIGINT")).toBe(baseline.sigint + 1);
    expect(process.listenerCount("SIGTERM")).toBe(baseline.sigterm + 1);
    expect(process.listenerCount("exit")).toBe(baseline.exit + 1);

    await command(harness, "-leave");
    expect(process.listenerCount("SIGINT")).toBe(baseline.sigint);
    expect(process.listenerCount("SIGTERM")).toBe(baseline.sigterm);
    expect(process.listenerCount("exit")).toBe(baseline.exit);
  });

  it("renames, switches channels, and leaves", async () => {
    const { first, second } = await makeJoinedPair({
      channel: "alpha",
      cwd: "/tmp/pie",
    });
    await command(second, "-rename helper");

    expect(first.widgets.get("/join")).toBe(
      "/join alpha 👽🪐🌎 · pie1 · peers: helper",
    );
    expect(second.widgets.get("/join")).toBe(
      "/join alpha 👽🪐🌎 · helper · peers: pie1",
    );
    const alphaBeforeSwitch = await readChannelRegistry("alpha");
    const oldSocket = requiredValue(
      alphaBeforeSwitch.members.find((member) => member.name === "helper")
        ?.sock,
      'old-channel socket for renamed peer "helper"',
    );

    await command(second, "beta");
    expect(first.widgets.get("/join")).toBe(
      "/join alpha 👽🪐🌎 · pie1 · peers: none",
    );
    expect(second.widgets.get("/join")).toBe(
      "/join beta 👽🪐🌎 · pie1 · peers: none",
    );
    expect(await readChannelRegistry("alpha")).toMatchObject({
      members: [expect.objectContaining({ name: "pie1" })],
    });
    await expect(
      stat(oldSocket),
      "switching channels must remove the old Unix socket",
    ).rejects.toMatchObject({ code: "ENOENT" });
    const beta = await readChannelRegistry("beta");
    const betaSocket = requiredValue(
      beta.members[0]?.sock,
      "local beta-channel socket",
    );

    await command(second, "-leave");
    expect(second.widgets.get("/join")).toBeUndefined();
    expect(await readChannelRegistry("beta")).toEqual({ members: [] });
    await expect(
      stat(betaSocket),
      "leaving must remove the current Unix socket",
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid or colliding names", async () => {
    const { second } = await makeJoinedPair({
      channel: "team",
      cwd: "/tmp/pie",
    });

    await command(second, "-rename invalid name");
    await command(second, "-rename pie1");

    expect(second.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Names must match [a-z0-9-]+ and contain one token.",
          level: "error",
        }),
        expect.objectContaining({
          message: 'The name "pie1" is already in use.',
          level: "error",
        }),
      ]),
    );
  });

  it("removes process handlers during session shutdown", async () => {
    const baseline = process.listenerCount("SIGINT");
    const harness = makeHarness();
    await command(harness, "team");
    expect(process.listenerCount("SIGINT")).toBe(baseline + 1);

    await harness.shutdown();

    expect(process.listenerCount("SIGINT")).toBe(baseline);
  });

  it("filters dash completions and ignores channel text", async () => {
    const harness = makeHarness();
    const completions = harness.commands.get("join")?.getArgumentCompletions;
    const rename = await Promise.resolve(completions?.("-r"));
    const channel = await Promise.resolve(completions?.("channel"));
    expect(rename).toHaveLength(1);
    expect(rename?.[0]?.value.startsWith("-r")).toBe(true);
    expect(channel).toBeNull();
  });
});
