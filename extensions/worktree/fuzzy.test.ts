/**
 * Edge-case unit tests for fuzzy ordering of repository paths.
 *
 * Last-resort unit tests (per AGENTS.md): the integration suite
 * already verifies that autocompletion *works* end to end; these
 * tests pin the exact ordering rules a reasonable user expects.
 */

import { describe, it, expect } from "vitest";
import { fuzzyMatchRepos, repoLeaf } from "./fuzzy.js";

describe("repoLeaf", () => {
  it("returns the last path segment", () => {
    expect(repoLeaf("/home/u/src/pie")).toBe("pie");
    expect(repoLeaf("/home/u/src/pie/")).toBe("pie");
  });

  it("returns empty for empty input", () => {
    expect(repoLeaf("")).toBe("");
  });
});

describe("fuzzyMatchRepos", () => {
  const repos = [
    "/home/u/src/github.com/kumar303/pie",
    "/home/u/src/github.com/kumar303/queue",
    "/home/u/src/github.com/shopify-playground/pie-incubator",
    "/home/u/src/github.com/shopify-playground/web",
  ];

  it("returns all repos when query is empty", () => {
    expect(fuzzyMatchRepos("", repos)).toEqual(repos);
  });

  it("ranks an exact leaf match first", () => {
    const result = fuzzyMatchRepos("pie", repos);
    expect(result[0]).toBe("/home/u/src/github.com/kumar303/pie");
    // pie-incubator should come after the exact match
    expect(result[1]).toBe(
      "/home/u/src/github.com/shopify-playground/pie-incubator",
    );
  });

  it("prefers a leaf prefix match over a leaf subsequence match", () => {
    // "incubator" starts with "in" → leaf prefix match (kind 1).
    // "spinner" contains 'i' then 'n' as a subsequence but
    // does NOT start with "in" → leaf subsequence match
    // (kind 2). The prefix match must rank higher.
    const r = fuzzyMatchRepos("in", ["/a/incubator", "/b/spinner"]);
    expect(r[0]).toBe("/a/incubator");
    expect(r[1]).toBe("/b/spinner");
  });

  it("prefers a leaf subsequence match over a full-path-only match", () => {
    // "shp" matches the leaf "shop" by subsequence, but only
    // the full path (not the leaf) of the other entry.
    const r = fuzzyMatchRepos("shp", [
      "/orgs/shopify-playground/web", // matches full path only
      "/orgs/example/shop", // matches the leaf
    ]);
    expect(r[0]).toBe("/orgs/example/shop");
    expect(r[1]).toBe("/orgs/shopify-playground/web");
  });

  it("falls back to full-path match when the leaf does not match", () => {
    // "shopify" doesn't appear in any leaf, but does in the full
    // path. We expect *some* match (the shopify-playground entries)
    // and the kumar303 entries to be excluded.
    const result = fuzzyMatchRepos("shopify", repos);
    expect(result).toContain(
      "/home/u/src/github.com/shopify-playground/pie-incubator",
    );
    expect(result).toContain("/home/u/src/github.com/shopify-playground/web");
    expect(result).not.toContain("/home/u/src/github.com/kumar303/pie");
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(fuzzyMatchRepos("zzzz-nothing", repos)).toEqual([]);
  });
});
