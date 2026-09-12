import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

export interface Bookmark {
  id: string;
  savedAt: number;
  message: AssistantMessage;
  toolResults: ToolResultMessage[];
}

function directory(sessionId: string): string {
  return join(
    homedir(),
    ".local",
    "share",
    "bookmark-pi",
    encodeURIComponent(sessionId),
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validBlock(value: unknown): boolean {
  if (!object(value)) return false;
  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "thinking":
      return typeof value.thinking === "string";
    case "toolCall":
      return (
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        object(value.arguments)
      );
    default:
      return false;
  }
}

function validResult(value: unknown): boolean {
  return (
    object(value) &&
    value.role === "toolResult" &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    typeof value.isError === "boolean" &&
    Array.isArray(value.content) &&
    value.content.every(
      (block: unknown) =>
        object(block) &&
        ((block.type === "text" && typeof block.text === "string") ||
          (block.type === "image" &&
            typeof block.data === "string" &&
            typeof block.mimeType === "string")),
    )
  );
}

function validBookmark(value: unknown): value is Bookmark {
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    typeof value.savedAt !== "number" ||
    !object(value.message)
  )
    return false;
  const message = value.message;
  return (
    message.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.every(validBlock) &&
    typeof message.stopReason === "string" &&
    ["stop", "length", "toolUse", "error", "aborted"].includes(
      message.stopReason,
    ) &&
    (message.errorMessage === undefined ||
      typeof message.errorMessage === "string") &&
    Array.isArray(value.toolResults) &&
    value.toolResults.every(validResult)
  );
}

export function readBookmarks(sessionId: string): Bookmark[] {
  const dir = directory(sessionId);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const bookmarks = names
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      const path = join(dir, name);
      let source: string;
      try {
        source = readFileSync(path, "utf8");
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
      const value: unknown = JSON.parse(source);
      if (
        !validBookmark(value) ||
        name !== `${encodeURIComponent(value.id)}.json`
      )
        throw new Error(`Invalid bookmark: ${path}`);
      return [value];
    });
  return bookmarks.sort(
    (a, b) => b.savedAt - a.savedAt || b.id.localeCompare(a.id),
  );
}

export function saveBookmark(sessionId: string, bookmark: Bookmark): void {
  const dir = directory(sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${encodeURIComponent(bookmark.id)}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(bookmark)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      if (!isMissing(cleanupError)) {
        throw new AggregateError(
          [error, cleanupError],
          `Failed to save bookmark and clean up ${temporary}: ${String(error)}; ${String(cleanupError)}`,
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
}

export function removeBookmark(sessionId: string, id: string): void {
  try {
    unlinkSync(join(directory(sessionId), `${encodeURIComponent(id)}.json`));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
