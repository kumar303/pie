/**
 * Storage for yanked prompts.
 *
 * Persists up to MAX_PROMPTS prompts in a JSON file under
 * ~/.cache/yanked-pi-extension/v1/prompts.json
 *
 * Newest prompts are at the end of the array. When the limit
 * is exceeded, the oldest (first) entry is ejected.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const MAX_PROMPTS = 10;

export interface YankedPrompt {
  text: string;
  timestamp: number;
}

export interface StoreIO {
  read(): YankedPrompt[];
  write(prompts: YankedPrompt[]): void;
}

/**
 * Create a StoreIO backed by a JSON file on disk.
 */
export function createFileStore(
  dir: string = join(homedir(), ".cache", "yanked-pi-extension", "v1"),
): StoreIO {
  const filePath = join(dir, "prompts.json");

  return {
    read(): YankedPrompt[] {
      try {
        const data = readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(data);
        if (!Array.isArray(parsed)) return [];
        return parsed;
      } catch {
        return [];
      }
    },
    write(prompts: YankedPrompt[]): void {
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, JSON.stringify(prompts, null, 2), "utf-8");
    },
  };
}

/**
 * Push a prompt onto the store. Ejects the oldest if at capacity.
 * Returns the updated list.
 */
export function pushPrompt(store: StoreIO, text: string): YankedPrompt[] {
  const prompts = store.read();
  prompts.push({ text, timestamp: Date.now() });
  while (prompts.length > MAX_PROMPTS) {
    prompts.shift();
  }
  store.write(prompts);
  return prompts;
}

/**
 * Pop the most recent prompt from the store.
 * Returns the prompt text, or null if the store is empty.
 */
export function popPrompt(store: StoreIO): string | null {
  const prompts = store.read();
  if (prompts.length === 0) return null;
  const last = prompts.pop()!;
  store.write(prompts);
  return last.text;
}

/**
 * List all prompts, oldest first.
 */
export function listPrompts(store: StoreIO): YankedPrompt[] {
  return store.read();
}

/**
 * Remove a prompt at a specific index.
 * Returns the removed prompt text, or null if the index is invalid.
 */
export function removePromptAt(store: StoreIO, index: number): string | null {
  const prompts = store.read();
  if (index < 0 || index >= prompts.length) return null;
  const [removed] = prompts.splice(index, 1);
  store.write(prompts);
  return removed.text;
}
