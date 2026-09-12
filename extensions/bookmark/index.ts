import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  DynamicBorder,
  copyToClipboard,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  SelectList,
  Text,
  TruncatedText,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import {
  readBookmarks,
  removeBookmark,
  saveBookmark,
  type Bookmark,
} from "./store.ts";

// Narrow structural contracts let tests omit unused pi methods without casts.
export type BookmarkContext = Pick<ExtensionCommandContext, "cwd" | "hasUI"> & {
  ui: Pick<
    ExtensionCommandContext["ui"],
    "notify" | "custom" | "getToolsExpanded"
  >;
  sessionManager: Pick<
    ExtensionCommandContext["sessionManager"],
    "getSessionId" | "getBranch"
  >;
};
export interface BookmarkAPI {
  registerCommand(
    name: string,
    command: Omit<Parameters<ExtensionAPI["registerCommand"]>[1], "handler"> & {
      handler(args: string, ctx: BookmarkContext): Promise<void>;
    },
  ): void;
}

function exhaustive(value: never): never {
  throw new Error(`Unsupported agent response: ${JSON.stringify(value)}`);
}

function blockText(block: AssistantMessage["content"][number]): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "thinking":
      return block.thinking;
    case "toolCall":
      return `${block.name}\n${JSON.stringify(block.arguments, null, 2)}`;
    default:
      return exhaustive(block);
  }
}

function responseText(message: AssistantMessage): string {
  const content = message.content.map(blockText).filter(Boolean).join("\n\n");
  const error =
    message.stopReason === "error"
      ? `Error: ${message.errorMessage || "Unknown error"}`
      : message.stopReason === "aborted"
        ? message.errorMessage && message.errorMessage !== "Request was aborted"
          ? message.errorMessage
          : "Operation aborted"
        : "";
  return [content, error].filter(Boolean).join("\n\n");
}

function title(message: AssistantMessage): string {
  // Prefer the answer over its internal reasoning in the one-line index.
  const text = message.content.find(
    (block) => block.type === "text" && block.text.trim(),
  );
  return (
    (text ? blockText(text) : responseText(message)).trim().split(/\r?\n/)[0] ||
    "(Empty response)"
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function overlayLine(line: string, width: number): string {
  // AssistantMessageComponent adds shell-integration markers to transcript
  // rows. Replaying them in an overlay changes the terminal's prompt regions.
  // Keep native styling and OSC 8 links, but not these nonvisual prompt markers.
  const content = line
    .replaceAll("\x1b]133;A\x07", "")
    .replaceAll("\x1b]133;B\x07", "")
    .replaceAll("\x1b]133;C\x07", "");
  return truncateToWidth(content, width, "", true);
}

async function showBookmarks(
  ctx: BookmarkContext,
  sessionId: string,
  bookmarks: Bookmark[],
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      let selected = 0;
      let offset = 0;
      let previewHeight = 1;
      let previewLines = 0;
      let listHeight = 0;
      let list: SelectList;
      let preview: Component = new Container();
      let busy = false;
      let disposed = false;
      let status = "";
      let statusColor: "dim" | "success" | "error" = "dim";
      const border = new DynamicBorder((text: string) =>
        theme.fg("border", text),
      );

      const rebuildPreview = () => {
        offset = 0;
        const container = new Container();
        const bookmark = bookmarks[selected];
        if (!bookmark) {
          preview = container;
          return;
        }
        // Use the host's renderer, not a Markdown approximation. This preserves
        // thinking styles, provider errors, and future renderer improvements.
        container.addChild(
          new AssistantMessageComponent(
            bookmark.message,
            false,
            getMarkdownTheme(),
          ),
        );
        for (const block of bookmark.message.content) {
          switch (block.type) {
            case "text":
            case "thinking":
              // AssistantMessageComponent renders these in native transcript order.
              break;
            case "toolCall": {
              // Pi also renders tool rows after the assistant text. Undefined tool
              // definitions use built-in renderers or Pi's generic extension fallback.
              const tool = new ToolExecutionComponent(
                block.name,
                block.id,
                block.arguments,
                { showImages: true },
                undefined,
                tui,
                ctx.cwd,
              );
              tool.setExpanded(ctx.ui.getToolsExpanded());
              const result = bookmark.toolResults.find(
                (item) => item.toolCallId === block.id,
              );
              if (
                bookmark.message.stopReason === "aborted" ||
                bookmark.message.stopReason === "error"
              ) {
                tool.updateResult({
                  content: [
                    {
                      type: "text",
                      text:
                        bookmark.message.stopReason === "aborted"
                          ? "Operation aborted"
                          : bookmark.message.errorMessage || "Error",
                    },
                  ],
                  isError: true,
                });
              } else if (result) {
                tool.updateResult(result);
              }
              container.addChild(tool);
              break;
            }
            default:
              exhaustive(block);
          }
        }
        preview = container;
      };

      const rebuildList = () => {
        list = new SelectList(
          bookmarks.map((bookmark) => ({
            value: bookmark.id,
            label: title(bookmark.message),
          })),
          Math.max(1, listHeight),
          {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          },
        );
        list.setSelectedIndex(selected);
        list.onSelectionChange = (item) => {
          selected = bookmarks.findIndex(
            (bookmark) => bookmark.id === item.value,
          );
          rebuildPreview();
        };
      };
      rebuildList();
      rebuildPreview();

      return {
        render(width) {
          const height = Math.max(
            1,
            Math.min(
              tui.terminal.rows - 2,
              Math.max(18, Math.floor(tui.terminal.rows * 0.7)),
            ),
          );
          const legend = new TruncatedText(
            theme.fg(
              "dim",
              "↑↓ select · Esc close · x remove · c copy · u/d scroll · g/G top/bottom",
            ),
            2,
            1,
          ).render(width);
          const nextListHeight = Math.max(
            1,
            Math.min(bookmarks.length, 8, Math.floor(height / 5)),
          );
          if (nextListHeight !== listHeight) {
            listHeight = nextListHeight;
            rebuildList();
          }
          const listBox = new Box(2, 1);
          listBox.addChild(
            new Text(
              theme.fg("accent", theme.bold(`Bookmarks (${bookmarks.length})`)),
              0,
              0,
            ),
          );
          listBox.addChild(
            bookmarks.length
              ? list
              : new Text("No bookmarks in this session.", 0, 0),
          );
          const top = [
            ...border.render(width),
            ...listBox.render(width),
            ...border.render(width),
          ];
          previewHeight = Math.max(1, height - top.length - legend.length - 2);
          const body = preview.render(width);
          previewLines = body.length;
          offset = Math.max(0, Math.min(offset, body.length - previewHeight));
          const visible = body.slice(offset, offset + previewHeight);
          const position = theme.fg(
            status ? statusColor : "dim",
            status ||
              (body.length > previewHeight
                ? `Lines ${offset + 1}–${Math.min(offset + previewHeight, body.length)} of ${body.length}`
                : ""),
          );
          return [
            ...top,
            ...visible,
            ...Array(Math.max(0, previewHeight - visible.length)).fill(""),
            position,
            ...legend,
            ...border.render(width),
          ]
            .slice(0, height)
            .map((line) => overlayLine(line, width));
        },
        invalidate() {
          preview.invalidate();
          list.invalidate();
          border.invalidate();
        },
        dispose() {
          disposed = true;
        },
        handleInput(data) {
          if (matchesKey(data, "escape")) {
            disposed = true;
            done();
            return;
          }
          status = "";
          if (matchesKey(data, "x")) {
            const bookmark = bookmarks[selected];
            if (!bookmark) return;
            try {
              removeBookmark(sessionId, bookmark.id);
              bookmarks.splice(selected, 1);
              selected = Math.max(0, Math.min(selected, bookmarks.length - 1));
              rebuildList();
              rebuildPreview();
            } catch (error) {
              status = `Failed to remove bookmark: ${errorText(error)}`;
              statusColor = "error";
              ctx.ui.notify(status, "error");
            }
          } else if (matchesKey(data, "c")) {
            if (busy) return;
            const bookmark = bookmarks[selected];
            if (!bookmark) return;
            busy = true;
            status = "Copying to clipboard…";
            statusColor = "dim";
            void copyToClipboard(responseText(bookmark.message))
              .then(() => {
                status = "Copied to clipboard.";
                statusColor = "success";
                ctx.ui.notify("Bookmark copied to clipboard.", "info");
              })
              .catch((error: unknown) => {
                status = `Failed to copy bookmark: ${errorText(error)}`;
                statusColor = "error";
                ctx.ui.notify(status, "error");
              })
              .finally(() => {
                busy = false;
                if (!disposed) tui.requestRender();
              });
          } else if (matchesKey(data, "u")) {
            offset = Math.max(0, offset - previewHeight);
          } else if (matchesKey(data, "d")) {
            offset = Math.min(
              Math.max(0, previewLines - previewHeight),
              offset + previewHeight,
            );
          } else if (matchesKey(data, "g")) {
            offset = 0;
          } else if (matchesKey(data, "shift+g")) {
            offset = Math.max(0, previewLines - previewHeight);
          } else if (matchesKey(data, "up") || matchesKey(data, "down")) {
            list.handleInput(data);
          }
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions: { width: "90%", maxHeight: "100%" } },
  );
}

const HELP =
  "/bookmark — save the last agent response\n/bookmark show — browse this session's bookmarks\n/bookmark help — show this help\nOverlay: ↑↓ select, x remove, c copy, Esc close; u/d scroll, g/G top/bottom.";

export default function bookmark(pi: BookmarkAPI): void {
  pi.registerCommand("bookmark", {
    description: "Save the last agent response; show or help",
    getArgumentCompletions(prefix) {
      const items = ["help", "show"]
        .filter((arg) => arg.startsWith(prefix))
        .map((arg) => ({ value: arg, label: arg }));
      return items.length ? items : null;
    },
    async handler(args, ctx) {
      const command = args.trim();
      if (command === "help") {
        ctx.ui.notify(HELP, "info");
        return;
      }
      if (command !== "" && command !== "show") {
        ctx.ui.notify("Unknown argument. Use /bookmark help.", "warning");
        return;
      }
      const sessionId = ctx.sessionManager.getSessionId();
      if (command === "show") {
        if (!ctx.hasUI || ("mode" in ctx && ctx.mode !== "tui")) {
          ctx.ui.notify(
            "/bookmark show requires an interactive pi session.",
            "warning",
          );
          return;
        }
        let bookmarks: Bookmark[];
        try {
          bookmarks = readBookmarks(sessionId);
        } catch (error) {
          ctx.ui.notify(
            `Failed to read bookmarks: ${errorText(error)}`,
            "error",
          );
          return;
        }
        if (!bookmarks.length) {
          ctx.ui.notify("No bookmarks in this session.", "info");
          return;
        }
        await showBookmarks(ctx, sessionId, bookmarks);
        return;
      }
      const branch = ctx.sessionManager.getBranch();
      const entry = [...branch]
        .reverse()
        .find(
          (item) =>
            item.type === "message" && item.message.role === "assistant",
        );
      if (
        !entry ||
        entry.type !== "message" ||
        entry.message.role !== "assistant"
      ) {
        ctx.ui.notify("No agent response to bookmark.", "warning");
        return;
      }
      const toolCallIds = new Set(
        entry.message.content.flatMap((block) =>
          block.type === "toolCall" ? [block.id] : [],
        ),
      );
      const toolResults = branch.flatMap((item) =>
        item.type === "message" &&
        item.message.role === "toolResult" &&
        toolCallIds.has(item.message.toolCallId)
          ? [item.message]
          : [],
      );
      try {
        const existing = readBookmarks(sessionId);
        saveBookmark(sessionId, {
          id: entry.id,
          savedAt: Math.max(Date.now(), (existing[0]?.savedAt ?? 0) + 1),
          message: entry.message,
          toolResults,
        });
        ctx.ui.notify("Agent response bookmarked.", "info");
      } catch (error) {
        ctx.ui.notify(`Failed to save bookmark: ${errorText(error)}`, "error");
      }
    },
  });
}
// Check that pi can load the narrowed API without adapters.
const _extension: (pi: ExtensionAPI) => void = bookmark;
