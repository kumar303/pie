import { describe, it, expect } from "vitest";
import {
  MAX_PROMPTS,
  pushPrompt,
  popPrompt,
  listPrompts,
  removePromptAt,
  type StoreIO,
  type YankedPrompt,
} from "./store.ts";

/** In-memory StoreIO for testing. */
function memStore(initial: YankedPrompt[] = []): StoreIO {
  let data = [...initial];
  return {
    read: () => [...data],
    write: (prompts) => {
      data = [...prompts];
    },
  };
}

describe("pushPrompt", () => {
  it("adds a prompt to an empty store", () => {
    const store = memStore();
    pushPrompt(store, "hello world");
    const prompts = store.read();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toBe("hello world");
    expect(prompts[0].timestamp).toBeGreaterThan(0);
  });

  it("appends newest prompts at the end", () => {
    const store = memStore();
    pushPrompt(store, "first");
    pushPrompt(store, "second");
    const prompts = store.read();
    expect(prompts[0].text).toBe("first");
    expect(prompts[1].text).toBe("second");
  });

  it("ejects the oldest prompt when at capacity", () => {
    const store = memStore();
    for (let i = 0; i < MAX_PROMPTS; i++) {
      pushPrompt(store, `prompt-${i}`);
    }
    expect(store.read()).toHaveLength(MAX_PROMPTS);

    pushPrompt(store, "overflow");
    const prompts = store.read();
    expect(prompts).toHaveLength(MAX_PROMPTS);
    // oldest ("prompt-0") should be gone
    expect(prompts[0].text).toBe("prompt-1");
    expect(prompts[prompts.length - 1].text).toBe("overflow");
  });

  it("returns the updated list", () => {
    const store = memStore();
    const result = pushPrompt(store, "test");
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("test");
  });
});

describe("popPrompt", () => {
  it("returns null for an empty store", () => {
    const store = memStore();
    expect(popPrompt(store)).toBeNull();
  });

  it("returns and removes the most recent prompt", () => {
    const store = memStore();
    pushPrompt(store, "first");
    pushPrompt(store, "second");

    expect(popPrompt(store)).toBe("second");
    expect(store.read()).toHaveLength(1);
    expect(store.read()[0].text).toBe("first");
  });

  it("leaves an empty store after popping the last prompt", () => {
    const store = memStore();
    pushPrompt(store, "only");

    expect(popPrompt(store)).toBe("only");
    expect(store.read()).toHaveLength(0);
  });
});

describe("listPrompts", () => {
  it("returns an empty array for an empty store", () => {
    const store = memStore();
    expect(listPrompts(store)).toEqual([]);
  });

  it("returns prompts in order (oldest first)", () => {
    const store = memStore();
    pushPrompt(store, "a");
    pushPrompt(store, "b");
    pushPrompt(store, "c");

    const list = listPrompts(store);
    expect(list.map((p) => p.text)).toEqual(["a", "b", "c"]);
  });
});

describe("removePromptAt", () => {
  it("returns null for an invalid index", () => {
    const store = memStore();
    expect(removePromptAt(store, 0)).toBeNull();
    expect(removePromptAt(store, -1)).toBeNull();
  });

  it("removes the prompt at the given index", () => {
    const store = memStore();
    pushPrompt(store, "a");
    pushPrompt(store, "b");
    pushPrompt(store, "c");

    expect(removePromptAt(store, 1)).toBe("b");
    expect(store.read().map((p) => p.text)).toEqual(["a", "c"]);
  });

  it("returns null when index is out of bounds", () => {
    const store = memStore();
    pushPrompt(store, "a");
    expect(removePromptAt(store, 5)).toBeNull();
  });
});
