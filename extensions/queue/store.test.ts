import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileStore, ensureDefaults, type StoreIO } from "./store.js";
import { DEFAULT_PROMPTS } from "./index.js";

// ── In-memory StoreIO for unit tests ─────────────────────────────────

function memStore(initial: Record<string, string[]> = {}): StoreIO {
  const keys = new Map<string, string[]>();
  for (const [key, prompts] of Object.entries(initial)) {
    keys.set(key, [...prompts]);
  }

  return {
    listKeys: () => [...keys.keys()].sort(),
    load: (key) => {
      const prompts = keys.get(key);
      return prompts ? [...prompts] : undefined;
    },
    save: (_key, prompts) => {
      keys.set(_key, [...prompts]);
    },
    delete: (key) => {
      if (!keys.has(key)) return false;
      keys.delete(key);
      return true;
    },
    listSnapshots: () => [],
  };
}

// ── ensureDefaults (unit tests with memStore) ────────────────────────

describe("ensureDefaults", () => {
  it("seeds review-and-fix when store is empty", () => {
    const store = memStore();
    ensureDefaults(store, DEFAULT_PROMPTS);
    expect(store.listKeys()).toContain("review-and-fix");
    const prompts = store.load("review-and-fix");
    expect(prompts).toEqual(DEFAULT_PROMPTS);
  });

  it("does not overwrite existing keys", () => {
    const store = memStore({ "review-and-fix": ["custom"] });
    ensureDefaults(store, DEFAULT_PROMPTS);
    expect(store.load("review-and-fix")).toEqual(["custom"]);
  });

  it("does not seed when other keys exist", () => {
    const store = memStore({ "my-queue": ["A"] });
    ensureDefaults(store, DEFAULT_PROMPTS);
    expect(store.listKeys()).toEqual(["my-queue"]);
  });
});

// ── createFileStore (integration tests with real filesystem) ─────────

describe("createFileStore", () => {
  let tmpDir: string;
  let store: StoreIO;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "queue-test-"));
    store = createFileStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists no keys on empty directory", () => {
    expect(store.listKeys()).toEqual([]);
  });

  it("saves and loads prompts under a key", () => {
    store.save("my-key", ["prompt A", "prompt B"]);
    expect(store.load("my-key")).toEqual(["prompt A", "prompt B"]);
  });

  it("lists saved keys", () => {
    store.save("alpha", ["A"]);
    store.save("beta", ["B"]);
    const keys = store.listKeys();
    expect(keys).toContain("alpha");
    expect(keys).toContain("beta");
  });

  it("returns undefined for non-existent key", () => {
    expect(store.load("nope")).toBeUndefined();
  });

  it("overwrites existing key on save", () => {
    store.save("k", ["old"]);
    store.save("k", ["new"]);
    expect(store.load("k")).toEqual(["new"]);
  });

  it("creates a snapshot before overwriting", () => {
    store.save("k", ["original"]);
    store.save("k", ["updated"]);
    const snapshots = store.listSnapshots();
    expect(snapshots.length).toBe(1);
  });

  it("snapshot is a copy of all queues at that point in time", () => {
    store.save("a", ["A1"]);
    store.save("b", ["B1"]);
    // Overwriting "a" snapshots the full state { a: ["A1"], b: ["B1"] }
    store.save("a", ["A2"]);
    const snapshots = store.listSnapshots();
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].queues).toEqual({ a: ["A1"], b: ["B1"] });
  });

  it("includes a timestamp in each snapshot", () => {
    const before = Date.now();
    store.save("k", ["v1"]);
    store.save("k", ["v2"]);
    const after = Date.now();
    const snapshots = store.listSnapshots();
    expect(snapshots[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(snapshots[0].timestamp).toBeLessThanOrEqual(after);
  });

  it("does not create a snapshot on first save", () => {
    store.save("k", ["first"]);
    const snapshots = store.listSnapshots();
    expect(snapshots.length).toBe(0);
  });

  it("deletes a key", () => {
    store.save("k", ["A"]);
    store.delete("k");
    expect(store.load("k")).toBeUndefined();
    expect(store.listKeys()).toEqual([]);
  });

  it("creates a snapshot before deleting", () => {
    store.save("k", ["A"]);
    store.delete("k");
    const snapshots = store.listSnapshots();
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].queues).toEqual({ k: ["A"] });
  });

  it("returns false when deleting a non-existent key", () => {
    expect(store.delete("nope")).toBe(false);
  });

  it("returns true when deleting an existing key", () => {
    store.save("k", ["A"]);
    expect(store.delete("k")).toBe(true);
  });

  it("stores queues and snapshots in separate files", () => {
    store.save("alpha", ["A"]);
    store.save("alpha", ["A2"]); // triggers snapshot
    const files = readdirSync(tmpDir)
      .filter((f) => !f.endsWith(".tmp"))
      .sort();
    expect(files).toHaveLength(2);
    expect(files).toContain("queues.json");
    expect(files).toContain("snapshots.json");
  });

  it("does not create snapshots file until needed", () => {
    store.save("k", ["A"]);
    const files = readdirSync(tmpDir).filter((f) => !f.endsWith(".tmp"));
    expect(files).toEqual(["queues.json"]);
  });

  it("limits total snapshots to 100, removing oldest", () => {
    store.save("k", ["v0"]);
    for (let i = 1; i <= 110; i++) {
      store.save("k", [`v${i}`]);
    }
    const snapshots = store.listSnapshots();
    expect(snapshots.length).toBe(100);
    // Oldest should have been dropped; newest should be last
    expect(snapshots[99].queues).toEqual({ k: [`v109`] });
  });
});
