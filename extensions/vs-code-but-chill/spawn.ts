/**
 * Helpers for spawning the vs-code-but-chill server as a detached
 * child process.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface SpawnResult {
  pid: number | undefined;
}

/**
 * Resolve the path to the jiti CLI (lib/jiti-cli.mjs). Pi bundles
 * `@mariozechner/jiti`, but we fall back to plain `jiti` if present.
 * Throws if neither is found.
 */
export function resolveJitiCli(
  baseRequire: NodeRequire = createRequire(import.meta.url),
): string {
  const candidates = ["@mariozechner/jiti/package.json", "jiti/package.json"];
  for (const c of candidates) {
    try {
      const pkgPath = baseRequire.resolve(c);
      const pkgDir = dirname(pkgPath);
      for (const rel of ["lib/jiti-cli.mjs", "bin/jiti.mjs", "bin/jiti.js"]) {
        const candidate = join(pkgDir, rel);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // not installed
    }
  }
  throw new Error("could not resolve a jiti CLI (@mariozechner/jiti or jiti)");
}

/**
 * Spawn the server detached. Returns the child's pid (or undefined
 * if spawn failed silently).
 */
export function spawnServer(
  serverMainPath: string,
  dataDir: string,
  options?: {
    jitiPath?: string;
    env?: NodeJS.ProcessEnv;
    logPath?: string;
  },
): SpawnResult {
  const jitiPath = options?.jitiPath ?? resolveJitiCli();
  const child = spawn(process.execPath, [jitiPath, serverMainPath, dataDir], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...(options?.env ?? {}) },
  });
  child.unref();
  return { pid: child.pid };
}
