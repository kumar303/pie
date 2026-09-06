#!/usr/bin/env node
// Thin wrapper around the promptfoo CLI that keeps all promptfoo state
// (results database, cache, config) inside evals/.promptfoo instead of ~/.promptfoo,
// and turns off telemetry/update checks. Extra arguments pass straight through.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EVALS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configDir =
  process.env.PROMPTFOO_CONFIG_DIR ?? resolve(EVALS_ROOT, ".promptfoo");
mkdirSync(configDir, { recursive: true });

const env = {
  PROMPTFOO_DISABLE_TELEMETRY: "1",
  PROMPTFOO_DISABLE_UPDATE: "1",
  ...process.env,
  PROMPTFOO_CONFIG_DIR: configDir,
};

const bin = resolve(
  EVALS_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "promptfoo.cmd" : "promptfoo",
);
const child = spawn(bin, process.argv.slice(2), {
  stdio: "inherit",
  env,
  cwd: EVALS_ROOT,
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
