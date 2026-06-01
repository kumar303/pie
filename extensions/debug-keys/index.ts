import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

export type DebugKeysPi = Pick<ExtensionAPI, "registerCommand" | "sendMessage">;

type TerminalUnsubscribe = ReturnType<
  ExtensionCommandContext["ui"]["onTerminalInput"]
>;

const CUSTOM_TYPE = "debug-keys";
const STATUS_KEY = "debug-keys";

const COMMANDS = [
  {
    value: "on",
    label: "on",
    description: "Start printing key codes",
  },
  {
    value: "off",
    label: "off",
    description: "Stop printing key codes",
  },
];

function print(pi: DebugKeysPi, content: string): void {
  pi.sendMessage(
    {
      customType: CUSTOM_TYPE,
      content,
      display: true,
    },
    { triggerTurn: false },
  );
}

function usage(lead?: string): string {
  return [
    lead,
    "Usage: /debug-keys on|off",
    "",
    "Commands:",
    "  /debug-keys on   Start printing each raw terminal input sequence received by the extension.",
    "  /debug-keys off  Stop printing key codes.",
    "",
    "Output includes the JSON-escaped raw data.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function formatKeyData(data: string): string {
  return `/debug-keys: ${JSON.stringify(data)}`;
}

export function createExtension(pi: DebugKeysPi): void {
  let unsubscribe: TerminalUnsubscribe | undefined;
  let activeCtx: Pick<ExtensionCommandContext, "ui"> | undefined;

  const stop = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    activeCtx?.ui.setStatus(STATUS_KEY, undefined);
    activeCtx = undefined;
  };

  const start = (ctx: ExtensionCommandContext) => {
    if (unsubscribe) stop();
    activeCtx = ctx;
    unsubscribe = ctx.ui.onTerminalInput((data) => {
      print(pi, formatKeyData(data));
      return undefined;
    });
    ctx.ui.setStatus(STATUS_KEY, "/debug-keys on");
  };

  pi.registerCommand("debug-keys", {
    description: "Print key codes for extension development",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase();
      return COMMANDS.filter((command) => command.value.startsWith(normalized));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const command = args.trim().toLowerCase();

      if (command === "") {
        print(pi, usage());
        return;
      }

      if (command === "on") {
        start(ctx);
        print(pi, "/debug-keys: debug key logging enabled");
        return;
      }

      if (command === "off") {
        stop();
        print(pi, "/debug-keys: debug key logging disabled");
        return;
      }

      print(pi, usage(`Unknown debug-keys command: ${args.trim()}`));
    },
  });
}

export default function debugKeysExtension(pi: ExtensionAPI): void {
  createExtension(pi);
}
