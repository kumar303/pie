import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveJitiCli } from "./spawn.ts";

/**
 * Build a synthetic pnpm-like layout with `@mariozechner/pi-tui` and
 * `@mariozechner/jiti` side by side. Returns the absolute path to
 * pi-tui's package.json — the `anchor` the production code uses.
 *
 * realpathSync resolves the macOS `/var` ↔ `/private/var` symlink so
 * string comparisons line up.
 */
function makePnpmLikeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vscbc-spawn-")));
  const nm = join(root, "node_modules", "@mariozechner");
  const piTuiDir = join(nm, "pi-tui");
  mkdirSync(piTuiDir, { recursive: true });
  writeFileSync(
    join(piTuiDir, "package.json"),
    JSON.stringify({ name: "@mariozechner/pi-tui" }),
  );
  const jitiDir = join(nm, "jiti");
  mkdirSync(join(jitiDir, "lib"), { recursive: true });
  writeFileSync(
    join(jitiDir, "package.json"),
    JSON.stringify({ name: "@mariozechner/jiti" }),
  );
  const cli = join(jitiDir, "lib", "jiti-cli.mjs");
  writeFileSync(cli, "// fake");
  return {
    root,
    piTuiPkgPath: join(piTuiDir, "package.json"),
    jitiPkgPath: join(jitiDir, "package.json"),
    expectedCli: cli,
    jitiDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Build a deterministic resolver that simulates Node's
 * `createRequire(anchor).resolve(specifier)` without vitest's
 * host-project pollution. The map is keyed by `"anchor||specifier"`.
 */
function fakeResolver(rules: Record<string, string | Error>) {
  return vi.fn((specifier: string, anchor: string) => {
    const key = `${anchor}||${specifier}`;
    const v = rules[key];
    if (v instanceof Error) throw v;
    if (typeof v === "string") return v;
    const err = new Error(`Cannot find module '${specifier}' from '${anchor}'`);
    (err as Error & { code: string }).code = "MODULE_NOT_FOUND";
    throw err;
  });
}

describe("resolveJitiCli", () => {
  let fixture: ReturnType<typeof makePnpmLikeFixture>;
  beforeEach(() => {
    fixture = makePnpmLikeFixture();
  });
  afterEach(() => fixture.cleanup());

  it("finds jiti via an anchor package when the primary fromDir can't resolve it", () => {
    // Simulates the Nix/pnpm-hoisted case: fromDir's chain fails (no
    // jiti visible from the extension's own location), but the
    // pi-tui anchor can resolve it as a sibling.
    const anchor = fixture.piTuiPkgPath;
    const resolve = fakeResolver({
      // Primary anchor (fromDir/_anchor.js) fails for both specifiers.
      // pi-tui anchor resolves @mariozechner/jiti/package.json only.
      [`${anchor}||@mariozechner/jiti/package.json`]: fixture.jitiPkgPath,
    });
    const cli = resolveJitiCli({
      fromDir: "/nowhere",
      anchorPackages: [anchor],
      resolve,
    });
    expect(cli).toBe(fixture.expectedCli);
  });

  it("prefers the primary fromDir resolution when it succeeds", () => {
    const anchor = fixture.piTuiPkgPath;
    // Both resolvers can find jiti, but fromDir should win (tried first).
    // We encode that by only stubbing fromDir; the anchor rule is absent
    // so would throw — the test asserts the anchor was never consulted.
    const resolve = fakeResolver({
      [`/some/dev/path/_anchor.js||@mariozechner/jiti/package.json`]:
        fixture.jitiPkgPath,
    });
    const cli = resolveJitiCli({
      fromDir: "/some/dev/path",
      anchorPackages: [anchor],
      resolve,
    });
    expect(cli).toBe(fixture.expectedCli);
    // Called once for fromDir; never reached the pi-tui anchor.
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(
      "@mariozechner/jiti/package.json",
      "/some/dev/path/_anchor.js",
    );
  });

  it("falls back to plain `jiti` after `@mariozechner/jiti` fails", () => {
    // Rename the scoped pkg to plain 'jiti' in the fixture.
    const plain = join(fixture.root, "node_modules", "jiti");
    mkdirSync(join(plain, "lib"), { recursive: true });
    writeFileSync(
      join(plain, "package.json"),
      JSON.stringify({ name: "jiti" }),
    );
    const plainCli = join(plain, "lib", "jiti-cli.mjs");
    writeFileSync(plainCli, "// fake");

    const anchor = fixture.piTuiPkgPath;
    const resolve = fakeResolver({
      [`${anchor}||jiti/package.json`]: join(plain, "package.json"),
    });
    const cli = resolveJitiCli({
      fromDir: "/nowhere",
      anchorPackages: [anchor],
      resolve,
    });
    expect(cli).toBe(plainCli);
  });

  it("picks the first existing CLI variant (lib/jiti-cli.mjs → bin/jiti.mjs → bin/jiti.js)", () => {
    rmSync(join(fixture.jitiDir, "lib"), { recursive: true, force: true });
    mkdirSync(join(fixture.jitiDir, "bin"), { recursive: true });
    const binMjs = join(fixture.jitiDir, "bin", "jiti.mjs");
    writeFileSync(binMjs, "// fake");

    const anchor = fixture.piTuiPkgPath;
    const resolve = fakeResolver({
      [`${anchor}||@mariozechner/jiti/package.json`]: fixture.jitiPkgPath,
    });
    const cli = resolveJitiCli({
      fromDir: "/nowhere",
      anchorPackages: [anchor],
      resolve,
    });
    expect(cli).toBe(binMjs);
  });

  it("throws a helpful error when every candidate and anchor fails", () => {
    const resolve = fakeResolver({});
    expect(() =>
      resolveJitiCli({
        fromDir: "/nowhere",
        anchorPackages: ["/also/nowhere/package.json"],
        resolve,
      }),
    ).toThrow(/could not resolve.*jiti/i);
  });
});
