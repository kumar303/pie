// Helpers for launching pi in a locked-down, eval-friendly configuration.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export const DEFAULTS = {
  modelA: "openai/gpt-5.6-sol",
  modelB: "anthropic/claude-opus-5",
  judgeModel: "anthropic/claude-sonnet-4-6",
  thinking: "off",
};

export function piBin() {
  return process.env.PI_BIN || "pi";
}

/**
 * Extra extensions that must be loaded for pi to work on this machine at all
 * (for example an API proxy that registers providers). Colon or comma separated.
 */
export function bootstrapExtensions() {
  const raw = process.env.PI_EVAL_EXTRA_EXTENSIONS ?? "";
  return raw
    .split(/[:,]/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) =>
      resolve(value.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")),
    );
}

export function resolveModel(which) {
  if (which === "judge")
    return process.env.PI_EVAL_JUDGE_MODEL || DEFAULTS.judgeModel;
  if (which === "A") return process.env.PI_EVAL_MODEL_A || DEFAULTS.modelA;
  if (which === "B") return process.env.PI_EVAL_MODEL_B || DEFAULTS.modelB;
  throw new Error(`Unknown model slot: ${which}`);
}

export function resolveThinking() {
  return process.env.PI_EVAL_THINKING || DEFAULTS.thinking;
}

/** Flags that turn off every feature the agent under test does not need. */
export function lockdownArgs() {
  return [
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--offline",
  ];
}

export function extensionArgs(extensionPaths) {
  const args = [];
  for (const path of [...bootstrapExtensions(), ...extensionPaths]) {
    if (!existsSync(path))
      throw new Error(`Extension path does not exist: ${path}`);
    args.push("-e", path);
  }
  return args;
}

/**
 * Split "provider/model" into its parts. pi accepts "provider/id" in --model,
 * so we pass it straight through, but the validator needs both halves.
 */
export function splitModel(model) {
  const index = model.indexOf("/");
  if (index === -1) return { provider: undefined, id: model };
  return { provider: model.slice(0, index), id: model.slice(index + 1) };
}

/**
 * Check that `pi --list-models` reports an exact provider/model match.
 * Returns { ok, rows } where rows are the matching table rows.
 */
export async function validateModel(model) {
  const { provider, id } = splitModel(model);
  const args = [...lockdownArgs(), ...extensionArgs([]), "--list-models", id];
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(piBin(), args, {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (error) {
    return { ok: false, rows: [], error: error.message };
  }
  const rows = stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 2)
    .map(([rowProvider, rowId]) => ({ provider: rowProvider, id: rowId }));
  const matches = rows.filter(
    (row) =>
      row.id === id && (provider === undefined || row.provider === provider),
  );
  if (matches.length === 0)
    return { ok: false, rows, error: `No exact match for ${model}` };
  if (provider === undefined && matches.length > 1) {
    return {
      ok: false,
      rows,
      error: `"${model}" is ambiguous; use provider/model. Candidates: ${matches
        .map((row) => `${row.provider}/${row.id}`)
        .join(", ")}`,
    };
  }
  return { ok: true, rows: matches };
}
