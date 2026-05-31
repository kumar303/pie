/**
 * Helpers for spawning the vs-code-but-chill server as a detached
 * child process.
 */

import { spawn as defaultSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SpawnResult {
  pid: number | undefined;
}

export interface ResolveJitiCliOptions {
  /**
   * Directory to anchor the primary Node resolve from. Defaults to
   * this module's own directory — good for dev setups where jiti is
   * hoisted into the project's top-level `node_modules`.
   */
  fromDir?: string;
  /**
   * Fallback anchor `package.json` paths to retry resolution from.
   * Each entry is a concrete package.json that's guaranteed to be
   * reachable; jiti is looked up as its peer.
   *
   * Used because pi ships as a standalone bundle (e.g. via Nix) where
   * jiti lives under pi's own `node_modules/jiti` and
   * is only visible via sibling packages like `@earendil-works/pi-tui`
   * — which the extension imports, so its resolved location is a
   * reliable anchor.
   */
  anchorPackages?: string[];
  /**
   * Injection point for tests: resolve a specifier (`jiti/package.json`)
   * from an anchor path. Defaults to
   * `createRequire(anchor).resolve(specifier)`. Tests can supply a
   * deterministic implementation that isn't polluted by vitest's
   * host-project module-path injection.
   */
  resolve?: (specifier: string, anchor: string) => string;
}

/**
 * Resolve the path to the jiti CLI (lib/jiti-cli.mjs). Pi bundles
 * `jiti`, but we fall back to plain `jiti` if present.
 * Throws if neither is found.
 */
export function resolveJitiCli(opts: ResolveJitiCliOptions = {}): string {
  const candidates = ["jiti/package.json"];
  const fromDir = opts.fromDir ?? dirname(fileURLToPath(import.meta.url));
  // When the caller supplies `anchorPackages` explicitly (including
  // an empty array), skip defaults — the caller knows better, and
  // tests rely on this to isolate themselves from the real tree.
  const extraAnchors =
    opts.anchorPackages !== undefined
      ? opts.anchorPackages
      : defaultAnchorPackages();
  const anchors = [join(fromDir, "_anchor.js"), ...extraAnchors];

  const resolve =
    opts.resolve ??
    ((spec: string, anchor: string) => createRequire(anchor).resolve(spec));
  for (const anchor of anchors) {
    for (const c of candidates) {
      try {
        const pkgPath = resolve(c, anchor);
        const pkgDir = dirname(pkgPath);
        for (const rel of ["lib/jiti-cli.mjs", "bin/jiti.mjs", "bin/jiti.js"]) {
          const candidate = join(pkgDir, rel);
          if (existsSync(candidate)) return candidate;
        }
      } catch {
        // not visible from this anchor; try the next one
      }
    }
  }
  throw new Error(
    "could not resolve a jiti CLI " +
      `from ${fromDir} or anchors [${anchors.slice(1).join(", ") || "none"}]`,
  );
}

/**
 * Production anchor list. `@earendil-works/pi-tui` is a direct import
 * of this extension, so Node can always resolve it; we walk through
 * it to find jiti as a sibling — this is the case when pi is installed
 * via Nix or a similarly hermetic packaging.
 */
function defaultAnchorPackages(): string[] {
  const here = createRequire(import.meta.url);
  const out: string[] = [];
  for (const name of ["@earendil-works/pi-tui/package.json"]) {
    try {
      out.push(here.resolve(name));
    } catch {
      // ignore; the caller will try remaining anchors.
    }
  }
  return out;
}

/**
 * Minimal subset of `child_process.spawn`'s contract that
 * `spawnServer` actually uses. Tests inject a fake instead of
 * forking a real process.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    detached?: boolean;
    stdio?: "ignore";
    env?: NodeJS.ProcessEnv;
  },
) => { pid: number | undefined; unref: () => void };

export interface SpawnServerOptions {
  jitiPath?: string;
  env?: NodeJS.ProcessEnv;
  logPath?: string;
  /** Injection point for tests — defaults to `child_process.spawn`. */
  spawn?: SpawnFn;
}

/**
 * Spawn the server detached. Returns the child's pid (or undefined
 * if spawn failed silently).
 */
export function spawnServer(
  serverMainPath: string,
  dataDir: string,
  options?: SpawnServerOptions,
): SpawnResult {
  const jitiPath = options?.jitiPath ?? resolveJitiCli();
  const spawn = options?.spawn ?? defaultSpawn;
  const child = spawn(process.execPath, [jitiPath, serverMainPath, dataDir], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...(options?.env ?? {}) },
  });
  child.unref();
  return { pid: child.pid };
}
