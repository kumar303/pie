/**
 * Storage for prompt queues.
 *
 * Queues are stored in ~/.pi/agent/queue/queues.json.
 * Snapshots are stored separately in ~/.pi/agent/queue/snapshots.json.
 * Each snapshot is a timestamped copy of the entire queues state.
 * Snapshots are capped at 100 total, oldest removed first.
 *
 * Writes use a temp file + rename for atomicity.
 *
 * The StoreIO interface enables in-memory test doubles.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ────────────────────────────────────────────────────────────

export interface Snapshot {
  timestamp: number;
  queues: Record<string, string[]>;
}

export interface StoreIO {
  listKeys(): string[];
  load(key: string): string[] | undefined;
  save(key: string, prompts: string[]): void;
  delete(key: string): boolean;
  rename(oldKey: string, newKey: string): boolean;
  listSnapshots(): Snapshot[];
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_STORE_DIR = join(homedir(), ".pi", "agent", "queue", "v1");
const QUEUES_FILE = "queues.json";
const SNAPSHOTS_FILE = "snapshots.json";
const MAX_SNAPSHOTS = 100;

// ── File-backed store ────────────────────────────────────────────────

export function createFileStore(dir: string = DEFAULT_STORE_DIR): StoreIO {
  const queuesPath = join(dir, QUEUES_FILE);
  const snapshotsPath = join(dir, SNAPSHOTS_FILE);

  function ensureDir(): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  function readQueues(): Record<string, string[]> {
    if (!existsSync(queuesPath)) return {};
    const raw = JSON.parse(readFileSync(queuesPath, "utf-8"));
    return (raw as Record<string, string[]>) ?? {};
  }

  function writeQueues(data: Record<string, string[]>): void {
    ensureDir();
    const tmpPath = queuesPath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmpPath, queuesPath);
  }

  function readSnapshots(): Snapshot[] {
    if (!existsSync(snapshotsPath)) return [];
    const raw = JSON.parse(readFileSync(snapshotsPath, "utf-8"));
    return Array.isArray(raw) ? (raw as Snapshot[]) : [];
  }

  function writeSnapshots(data: Snapshot[]): void {
    ensureDir();
    const tmpPath = snapshotsPath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmpPath, snapshotsPath);
  }

  function takeSnapshot(queues: Record<string, string[]>): void {
    const snaps = readSnapshots();
    snaps.push({ timestamp: Date.now(), queues: { ...queues } });
    if (snaps.length > MAX_SNAPSHOTS) {
      snaps.splice(0, snaps.length - MAX_SNAPSHOTS);
    }
    writeSnapshots(snaps);
  }

  return {
    listKeys(): string[] {
      return Object.keys(readQueues()).sort();
    },

    load(key: string): string[] | undefined {
      const prompts = readQueues()[key];
      return prompts ? [...prompts] : undefined;
    },

    save(key: string, prompts: string[]): void {
      const queues = readQueues();

      // Snapshot the full state before mutating
      if (queues[key]) {
        takeSnapshot(queues);
      }

      queues[key] = [...prompts];
      writeQueues(queues);
    },

    delete(key: string): boolean {
      const queues = readQueues();
      if (!queues[key]) return false;

      takeSnapshot(queues);
      delete queues[key];
      writeQueues(queues);
      return true;
    },

    rename(oldKey: string, newKey: string): boolean {
      const queues = readQueues();
      if (!queues[oldKey]) return false;

      takeSnapshot(queues);
      queues[newKey] = queues[oldKey];
      delete queues[oldKey];
      writeQueues(queues);
      return true;
    },

    listSnapshots(): Snapshot[] {
      return readSnapshots();
    },
  };
}

// ── Default seeding ──────────────────────────────────────────────────

/**
 * Ensure default prompt queues exist. If the store has no keys,
 * seeds a `review-and-fix` key with the provided default prompts.
 */
export function ensureDefaults(store: StoreIO, defaultPrompts: string[]): void {
  const keys = store.listKeys();
  if (keys.length === 0) {
    store.save("review-and-fix", [...defaultPrompts]);
  }
}
