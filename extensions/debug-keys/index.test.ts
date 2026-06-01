import { describe, it, expect } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import debugKeysExtension, { type DebugKeysPi } from "./index.ts";

type CommandConfig = Parameters<DebugKeysPi["registerCommand"]>[1];
type TerminalInputHandler = Parameters<
  ExtensionUIContext["onTerminalInput"]
>[0];

interface SentMessage {
  message: Parameters<DebugKeysPi["sendMessage"]>[0];
  options?: Parameters<DebugKeysPi["sendMessage"]>[1];
}

interface MockPi extends DebugKeysPi {
  commands: Map<string, CommandConfig>;
  messages: SentMessage[];
  runCommand(name: string, args: string, ctx: MockCtx): Promise<void> | void;
}

interface MockCtx extends Pick<ExtensionCommandContext, "cwd" | "hasUI"> {
  ui: Pick<ExtensionUIContext, "notify" | "onTerminalInput" | "setStatus"> & {
    notifications: Array<{
      message: string;
      level: "info" | "warning" | "error";
    }>;
    statuses: Map<string, string | undefined>;
    terminalHandlers: Set<TerminalInputHandler>;
    fireTerminalInput(
      data: string,
    ): Array<{ consume?: boolean; data?: string } | undefined>;
  };
}

function makeMockPi(): MockPi {
  const commands = new Map<string, CommandConfig>();
  const messages: SentMessage[] = [];
  return {
    commands,
    messages,
    registerCommand(name, config) {
      commands.set(name, config);
    },
    sendMessage(message, options) {
      messages.push({ message, options });
    },
    runCommand(name, args, ctx) {
      const command = commands.get(name);
      if (!command) throw new Error(`Command not registered: ${name}`);
      return command.handler(args, ctx as unknown as ExtensionCommandContext);
    },
  };
}

function makeMockCtx(): MockCtx {
  const terminalHandlers = new Set<TerminalInputHandler>();
  const ui: MockCtx["ui"] = {
    notifications: [],
    statuses: new Map(),
    terminalHandlers,
    notify(message, level = "info") {
      ui.notifications.push({ message, level });
    },
    setStatus(key, text) {
      ui.statuses.set(key, text);
    },
    onTerminalInput(handler) {
      terminalHandlers.add(handler);
      return () => terminalHandlers.delete(handler);
    },
    fireTerminalInput(data) {
      return [...terminalHandlers].map((handler) => handler(data));
    },
  };
  return { cwd: "/tmp/project", hasUI: true, ui };
}

function setup() {
  const pi = makeMockPi();
  debugKeysExtension(pi as unknown as ExtensionAPI);
  const ctx = makeMockCtx();
  return { pi, ctx };
}

function messageText(pi: MockPi): string {
  return pi.messages.map((m) => String(m.message.content)).join("\n");
}

describe("/debug-keys", () => {
  it("registers the command with on/off argument completions", async () => {
    const { pi } = setup();
    const command = pi.commands.get("debug-keys");

    expect(command?.description).toMatch(/key/i);
    await expect(
      Promise.resolve(command?.getArgumentCompletions?.("")),
    ).resolves.toEqual([
      { value: "on", label: "on", description: "Start printing key codes" },
      { value: "off", label: "off", description: "Stop printing key codes" },
    ]);
    await expect(
      Promise.resolve(command?.getArgumentCompletions?.("o")),
    ).resolves.toEqual([
      { value: "on", label: "on", description: "Start printing key codes" },
      { value: "off", label: "off", description: "Stop printing key codes" },
    ]);
    await expect(
      Promise.resolve(command?.getArgumentCompletions?.("of")),
    ).resolves.toEqual([
      { value: "off", label: "off", description: "Stop printing key codes" },
    ]);
  });

  it("prints persistent usage when invoked without arguments", () => {
    const { pi, ctx } = setup();

    pi.runCommand("debug-keys", "", ctx);

    expect(messageText(pi)).toContain("Usage: /debug-keys on|off");
    expect(pi.messages[0].message.display).toBe(true);
    expect(pi.messages[0].options).toEqual({ triggerTurn: false });
  });

  it("is off by default and does not print terminal input", () => {
    const { pi, ctx } = setup();

    ctx.ui.fireTerminalInput("a");

    expect(pi.messages).toEqual([]);
    expect(ctx.ui.terminalHandlers.size).toBe(0);
  });

  it("prints each key's stringified raw data after /debug-keys on", () => {
    const { pi, ctx } = setup();

    pi.runCommand("debug-keys", "on", ctx);
    const results = ctx.ui.fireTerminalInput("a");
    ctx.ui.fireTerminalInput("\x1b[A");

    expect(results).toEqual([undefined]);
    expect(pi.messages.map((m) => m.message.content)).toEqual([
      "/debug-keys: debug key logging enabled",
      '/debug-keys: "a"',
      '/debug-keys: "\\u001b[A"',
    ]);
    expect(ctx.ui.statuses.get("debug-keys")).toBe("/debug-keys on");
  });

  it("stops printing key codes after /debug-keys off", () => {
    const { pi, ctx } = setup();

    pi.runCommand("debug-keys", "on", ctx);
    ctx.ui.fireTerminalInput("a");
    pi.runCommand("debug-keys", "off", ctx);
    ctx.ui.fireTerminalInput("b");

    const text = messageText(pi);
    expect(text).toContain('/debug-keys: "a"');
    expect(text).not.toContain('/debug-keys: "b"');
    expect(text).toContain("debug key logging disabled");
    expect(ctx.ui.terminalHandlers.size).toBe(0);
    expect(ctx.ui.statuses.get("debug-keys")).toBeUndefined();
  });

  it("shows usage for unknown subcommands", () => {
    const { pi, ctx } = setup();

    pi.runCommand("debug-keys", "wat", ctx);

    expect(messageText(pi)).toContain("Usage: /debug-keys on|off");
    expect(messageText(pi)).toContain("Unknown debug-keys command: wat");
  });
});
