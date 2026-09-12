import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
  AssistantMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Text,
  TUI,
  type Component,
  type Terminal,
  visibleWidth,
} from "@earendil-works/pi-tui";
import bookmarkExtension, {
  type BookmarkAPI,
  type BookmarkContext,
} from "./index.ts";

const KEY = {
  escape: "\x1b",
  arrowUp: "\x1b[A",
  arrowDown: "\x1b[B",
  end: "\x1b[F",
  kitty: {
    d: "\x1b[100u",
    u: "\x1b[117u",
    g: "\x1b[103u",
    shiftG: "\x1b[103;2u",
  },
} as const;

const mocks = vi.hoisted(() => ({
  home: "",
  copy: vi.fn<(text: string) => Promise<void>>(),
}));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => mocks.home,
}));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
  copyToClipboard: mocks.copy,
}));

function response(
  content: AssistantMessage["content"],
  extra: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    timestamp: 1,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    ...extra,
  };
}
function textResponse(text: string) {
  return response([{ type: "text", text }]);
}

function harness({ live = false } = {}) {
  let terminalInput: ((data: string) => void) | undefined;
  const writes: string[] = [];
  const commands = new Map<
    string,
    Parameters<BookmarkAPI["registerCommand"]>[1]
  >();
  const pi = {
    registerCommand: (name, command) => {
      commands.set(name, command);
    },
  } satisfies BookmarkAPI;
  const terminal = {
    columns: 100,
    rows: 40,
    kittyProtocolActive: false,
    start(onInput: (data: string) => void) {
      terminalInput = onInput;
    },
    stop() {
      terminalInput = undefined;
    },
    async drainInput() {},
    write(data: string) {
      writes.push(data);
    },
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  } satisfies Terminal;
  const tui = new TUI(terminal);
  if (!live) vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  let component: (Component & { dispose?(): void }) | undefined;
  let closed = false;
  const entries: SessionEntry[] = [];
  let sessionId = "session-one";
  const notify = vi.fn<BookmarkContext["ui"]["notify"]>();
  const ui = {
    notify,
    getToolsExpanded: () => true,
    async custom<T>(
      factory: (
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        done: (value: T) => void,
      ) => Component | Promise<Component>,
      options?: Parameters<BookmarkContext["ui"]["custom"]>[1],
    ): Promise<T> {
      expect(options?.overlay).toBe(true);
      return new Promise<T>((resolve, reject) => {
        Promise.resolve(
          factory(tui, theme, new KeybindingsManager(), (value) => {
            closed = true;
            if (live) tui.hideOverlay();
            component?.dispose?.();
            component = undefined;
            resolve(value);
          }),
        ).then((value) => {
          component = value;
          if (live) {
            const overlayOptions =
              typeof options?.overlayOptions === "function"
                ? options.overlayOptions()
                : options?.overlayOptions;
            tui.showOverlay(component, overlayOptions);
          } else {
            component.render(terminal.columns);
          }
        }, reject);
      });
    },
    press: (key: string) => {
      if (live) terminalInput?.(key);
      else component?.handleInput?.(key);
    },
    render: (width = terminal.columns) => {
      if (!component) throw new Error("No overlay");
      return component.render(width);
    },
    plain: () => ui.render().map(stripVTControlCharacters).join("\n"),
    invalidate: () => component?.invalidate(),
  };
  const ctx = {
    cwd: "/project",
    hasUI: true,
    ui,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
  } satisfies BookmarkContext;
  bookmarkExtension(pi);
  const command = () => {
    const cmd = commands.get("bookmark");
    if (!cmd) throw new Error("Missing /bookmark");
    return cmd;
  };
  const invoke = (args = "") => command().handler(args, ctx);
  return {
    pi,
    ctx,
    ui,
    output: () => writes.join(""),
    clearOutput: () => {
      writes.length = 0;
    },
    [Symbol.dispose]() {
      tui.stop();
    },
    terminal,
    tui,
    notify,
    commands,
    invoke,
    complete: (prefix: string) => command().getArgumentCompletions?.(prefix),
    append(
      message:
        | AssistantMessage
        | ToolResultMessage
        | { role: "user"; content: string; timestamp: number },
    ) {
      const id = `entry-${entries.length}`;
      entries.push({
        type: "message",
        id,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        message,
      });
      return id;
    },
    setSession(id: string) {
      sessionId = id;
      entries.length = 0;
    },
    async show() {
      closed = false;
      const pending = invoke("show");
      await vi.waitFor(() => expect(component).toBeDefined());
      return {
        close: async () => {
          ui.press(KEY.escape);
          await pending;
          expect(closed).toBe(true);
        },
      };
    },
    stored() {
      const dir = join(mocks.home, ".local/share/bookmark-pi", sessionId);
      return readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
    },
  };
}

beforeEach(() => {
  mocks.home = mkdtempSync(join(tmpdir(), "bookmark-test-"));
  mocks.copy.mockReset().mockResolvedValue();
  initTheme("dark", false);
});
afterEach(() => {
  rmSync(mocks.home, { recursive: true, force: true });
});

describe("/bookmark", () => {
  it("completes every argument and explains commands", async () => {
    const h = harness();
    expect(await h.complete("")).toEqual([
      { value: "help", label: "help" },
      { value: "show", label: "show" },
    ]);
    expect(await h.complete("sh")).toEqual([{ value: "show", label: "show" }]);
    expect(await h.complete("nope")).toBeNull();
    await h.invoke("help");
    expect(h.notify).toHaveBeenCalledWith(
      expect.stringContaining("/bookmark show"),
      "info",
    );
    await h.invoke("unknown");
    expect(h.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("/bookmark help"),
      "warning",
    );
  });
  it("stores the last assistant message, not a later user or tool message, and survives reload", async () => {
    const h = harness();
    h.append(textResponse("Old"));
    const last = response([
      {
        type: "thinking",
        thinking: "A thought",
        thinkingSignature: "signature",
      },
      { type: "text", text: "# Latest\n\n**Details**" },
    ]);
    h.append(last);
    h.append({ role: "user", content: "Next question", timestamp: 2 });
    await h.invoke();
    expect(h.stored()).toEqual([expect.objectContaining({ message: last })]);
    bookmarkExtension(h.pi);
    const overlay = await h.show();
    expect(h.ui.plain()).toContain("Latest");
    expect(h.ui.plain()).toContain("A thought");
    await overlay.close();
  });
  it("does not save when there is no assistant response", async () => {
    const h = harness();
    h.append({ role: "user", content: "Hello", timestamp: 1 });
    await h.invoke();
    expect(h.notify).toHaveBeenCalledWith(
      "No agent response to bookmark.",
      "warning",
    );
    await h.invoke("show");
    expect(h.notify).toHaveBeenLastCalledWith(
      "No bookmarks in this session.",
      "info",
    );
  });
  it("selects newest first, navigates both ways, copies raw content, and persists removal", async () => {
    const h = harness();
    h.append(textResponse("First\n\nOld body"));
    await h.invoke();
    h.append(textResponse("Second\n\n**New body**"));
    await h.invoke();
    const overlay = await h.show();
    expect(h.ui.plain()).toContain("New body");
    h.ui.press(KEY.arrowDown);
    expect(h.ui.plain()).toContain("Old body");
    h.ui.press("c");
    await vi.waitFor(() =>
      expect(mocks.copy).toHaveBeenCalledWith("First\n\nOld body"),
    );
    await vi.waitFor(() =>
      expect(h.ui.plain()).toContain("Copied to clipboard."),
    );
    h.ui.press(KEY.arrowUp);
    expect(h.ui.plain()).toContain("New body");
    h.ui.press("x");
    await vi.waitFor(() => expect(h.stored()).toHaveLength(1));
    expect(h.ui.plain()).toContain("Old body");
    await overlay.close();
    const again = await h.show();
    expect(h.ui.plain()).not.toContain("Second");
    h.ui.press("x");
    await vi.waitFor(() => expect(h.ui.plain()).toContain("No bookmarks"));
    await again.close();
  });
  it("keeps bookmarks isolated by current session ID", async () => {
    const h = harness();
    h.append(textResponse("Session one"));
    await h.invoke();
    h.setSession("session-two");
    await h.invoke("show");
    expect(h.notify).toHaveBeenLastCalledWith(
      "No bookmarks in this session.",
      "info",
    );
    h.append(textResponse("Session two"));
    await h.invoke();
    h.setSession("session-one");
    const overlay = await h.show();
    expect(h.ui.plain()).toContain("Session one");
    expect(h.ui.plain()).not.toContain("Session two");
    await overlay.close();
  });
  it.each([
    textResponse(
      "# Heading\n\n**bold** and _italic_\n\n```ts\nconst answer = 42;\n```\n\n- one\n- two\n\n| A | B |\n| - | - |\n| 1 | 2 |",
    ),
    response([
      { type: "thinking", thinking: "Consider **options**" },
      { type: "text", text: "The answer" },
    ]),
    response([
      {
        type: "thinking",
        thinking: "",
        redacted: true,
        thinkingSignature: "opaque",
      },
    ]),
    response([], { stopReason: "error", errorMessage: "Server unavailable" }),
    response([{ type: "text", text: "Partial answer" }], {
      stopReason: "aborted",
      errorMessage: "Request was aborted",
    }),
    response([{ type: "text", text: "Length-limited answer" }], {
      stopReason: "length",
    }),
  ])("uses native assistant rendering for response %#", async (message) => {
    const h = harness();
    h.append(message);
    await h.invoke();
    const overlay = await h.show();
    const native = new AssistantMessageComponent(
      message,
      false,
      getMarkdownTheme(),
    );
    // Compare the native content, not its transcript-only shell markers.
    const expected = native.children
      .flatMap((child) => child.render(100))
      .map((line) => line.trimEnd())
      .join("\n");
    const actual = h.ui
      .render()
      .map((line) => line.trimEnd())
      .join("\n");
    expect(actual).toContain(expected);
    h.ui.invalidate();
    expect(
      h.ui
        .render()
        .map((line) => line.trimEnd())
        .join("\n"),
    ).toContain(expected);
    await overlay.close();
  });
  it("renders tool-only responses and their saved results without executing tools", async () => {
    const h = harness();
    h.append(
      response(
        [
          {
            type: "toolCall",
            id: "tool-1",
            name: "bash",
            arguments: { command: "printf sample" },
          },
        ],
        { stopReason: "toolUse" },
      ),
    );
    h.append({
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "bash",
      content: [{ type: "text", text: "sample output" }],
      isError: false,
      timestamp: 2,
    });
    await h.invoke();
    const overlay = await h.show();
    expect(h.ui.plain()).toContain("printf sample");
    expect(h.ui.plain()).toContain("sample output");
    await overlay.close();
  });
  it("makes the entire long response reachable and keeps the legend on screen after resize", async () => {
    const h = harness();
    for (let i = 0; i < 12; i++) {
      h.append(
        textResponse(
          `Title ${i}\n\n${Array.from({ length: 100 }, (_, n) => `Line ${n} 漢字`).join("\n")}`,
        ),
      );
      await h.invoke();
    }
    const overlay = await h.show();
    h.ui.press("G");
    expect(h.ui.plain()).toContain("Line 99");
    h.terminal.rows = 20;
    h.terminal.columns = 45;
    const lines = h.ui.render();
    expect(lines.length).toBeLessThanOrEqual(18);
    expect(lines.every((line) => visibleWidth(line) <= 45)).toBe(true);
    expect(h.ui.plain()).toContain("Esc close");
    h.ui.press(KEY.arrowDown);
    expect(h.ui.plain()).toContain("Line 0");
    await overlay.close();
  });
  it.each([
    {
      name: "plain keys",
      down: "d",
      up: "u",
      top: "g",
      bottom: "G",
    },
    {
      name: "Kitty keys",
      down: KEY.kitty.d,
      up: KEY.kitty.u,
      top: KEY.kitty.g,
      bottom: KEY.kitty.shiftG,
    },
  ])("scrolls the response with $name", async (keys) => {
    const h = harness();
    h.append(
      textResponse(
        Array.from({ length: 100 }, (_, n) => `Response line ${n}`).join("\n"),
      ),
    );
    await h.invoke();
    const overlay = await h.show();
    const top = h.ui.plain();
    h.ui.press(keys.down);
    expect(h.ui.plain()).not.toBe(top);
    h.ui.press(keys.up);
    expect(h.ui.plain()).toBe(top);
    h.ui.press(keys.bottom);
    expect(h.ui.plain()).toContain("Response line 99");
    h.ui.press(keys.top);
    expect(h.ui.plain()).toBe(top);
    await overlay.close();
  });
  it("keeps transcript prompt markers out of the overlay without stripping colors or links", async () => {
    const h = harness();
    h.append(
      textResponse(
        "# Styled answer\n\n[Documentation](https://example.com/docs)",
      ),
    );
    await h.invoke();
    const overlay = await h.show();
    const rendered = h.ui.render().join("\n");
    expect(rendered).not.toContain("\x1b]133;");
    expect(rendered).toContain("\x1b[");
    expect(rendered).toContain("\x1b]8;;https://example.com/docs");
    await overlay.close();
  });
  it("closes through the real TUI and restores prompt input without shell-integration output", async () => {
    using h = harness({ live: true });
    const prompt = new Input();
    prompt.setValue("draft");
    h.tui.addChild(
      new Text(
        Array.from({ length: 50 }, (_, n) => `Transcript line ${n}`).join("\n"),
        0,
        0,
      ),
    );
    h.tui.addChild(prompt);
    h.tui.setFocus(prompt);
    h.tui.start();
    await vi.waitFor(() =>
      expect(stripVTControlCharacters(h.output())).toContain("draft"),
    );
    h.ui.press(KEY.end);
    h.clearOutput();
    h.append(textResponse("# Saved response\n\nDetails"));
    await h.invoke();
    const overlay = await h.show();
    await vi.waitFor(() => expect(h.output()).toContain("Bookmarks"));
    expect(h.output()).not.toContain("\x1b]133;");
    h.clearOutput();
    await overlay.close();
    h.ui.press("!");
    expect(prompt.getValue()).toBe("draft!");
    await vi.waitFor(() =>
      expect(stripVTControlCharacters(h.output())).toContain("draft!"),
    );
    expect(h.output()).toContain("Transcript line");
    expect(h.output()).not.toContain("\x1b]133;");
  });
  it("fills the overlay rectangle through response scrolling and terminal resizing", async () => {
    const h = harness();
    h.append(textResponse(`# Response\n\n${"A short line\n".repeat(100)}`));
    await h.invoke();
    const overlay = await h.show();
    expect(h.ui.render().map(visibleWidth)).toEqual(
      Array(h.ui.render().length).fill(h.terminal.columns),
    );
    h.ui.press("G");
    h.terminal.columns = 60;
    h.terminal.rows = 24;
    const resized = h.ui.render();
    expect(resized.map(visibleWidth)).toEqual(Array(resized.length).fill(60));
    expect(resized.join("\n")).not.toContain("\x1b]133;");
    await overlay.close();
  });
  it("reports clipboard errors without removing the bookmark", async () => {
    const h = harness();
    h.append(textResponse("Keep me"));
    await h.invoke();
    mocks.copy.mockRejectedValue(new Error("Clipboard unavailable"));
    const overlay = await h.show();
    h.ui.press("c");
    await vi.waitFor(() =>
      expect(h.notify).toHaveBeenCalledWith(
        expect.stringContaining("Clipboard unavailable"),
        "error",
      ),
    );
    expect(h.stored()).toHaveLength(1);
    expect(h.ui.plain()).toContain("Clipboard unavailable");
    await overlay.close();
  });
  it("reports corrupt storage instead of overwriting it", async () => {
    const h = harness();
    h.append(textResponse("Saved"));
    await h.invoke();
    const dir = join(mocks.home, ".local/share/bookmark-pi/session-one");
    const path = join(dir, readdirSync(dir)[0]);
    writeFileSync(path, "not json");
    await h.invoke("show");
    expect(h.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Failed to read bookmarks"),
      "error",
    );
    expect(readFileSync(path, "utf8")).toBe("not json");
  });
});
