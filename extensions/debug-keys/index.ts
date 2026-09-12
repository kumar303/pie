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
    "Usage: /debug-keys on [count]|off",
    "",
    "Commands:",
    "  /debug-keys on [count]  Start printing raw terminal input, then stop after the optional positive key count.",
    "  /debug-keys off         Stop printing key codes.",
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

  const start = (ctx: ExtensionCommandContext, count?: number) => {
    if (unsubscribe) stop();
    activeCtx = ctx;
    let remaining = count;
    unsubscribe = ctx.ui.onTerminalInput((data) => {
      print(pi, formatKeyData(data));
      if (remaining !== undefined) {
        remaining -= 1;
        if (remaining === 0) stop();
      }
      return undefined;
    });
    ctx.ui.setStatus(
      STATUS_KEY,
      count === undefined ? "/debug-keys on" : `/debug-keys on ${count}`,
    );
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

      const onMatch = /^on(?:\s+(\d+))?$/.exec(command);
      if (onMatch) {
        const count = onMatch[1] === undefined ? undefined : Number(onMatch[1]);
        if (
          count !== undefined &&
          (!Number.isSafeInteger(count) || count < 1)
        ) {
          print(pi, usage(`Invalid debug-keys count: ${onMatch[1]}`));
          return;
        }

        start(ctx, count);
        const limit =
          count === undefined
            ? ""
            : ` for ${count} ${count === 1 ? "keystroke" : "keystrokes"}`;
        print(pi, `/debug-keys: debug key logging enabled${limit}`);
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
