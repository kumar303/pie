// promptfoo grader provider backed by `pi -p`.
//
// Using pi for the judge (instead of promptfoo's built-in OpenAI/Anthropic
// providers) means the judge uses the same credentials, proxies and model
// catalogue as the agents under test, so the suite runs anywhere pi runs.
//
// The rendered rubric prompt is piped to pi's stdin. The provider extracts the
// first JSON object from the reply so promptfoo's llm-rubric parser always gets
// clean `{ "reason", "score", "pass" }` output.
import { spawn } from "node:child_process";
import {
  extensionArgs,
  lockdownArgs,
  piBin,
  REPO_ROOT,
  resolveModel,
  validateModel,
} from "../../lib/pi-cli.mjs";

const SYSTEM_PROMPT = [
  "You are a strict, careful evaluator of AI agent transcripts.",
  "You only respond with a single JSON object and no other text.",
].join(" ");

const validated = new Map();

export default class PiJudgeProvider {
  constructor(options = {}) {
    this.providerId = options.id ?? "pi-judge";
    this.config = options.config ?? {};
    this.model = this.config.model || resolveModel("judge");
    this.thinking = this.config.thinking || "medium";
    this.timeoutMs = this.config.timeoutMs ?? 180_000;
  }

  id() {
    return this.providerId;
  }

  toString() {
    return `[PiJudgeProvider ${this.model}]`;
  }

  async callApi(prompt) {
    if (!validated.has(this.model))
      validated.set(this.model, validateModel(this.model));
    const check = await validated.get(this.model);
    if (!check.ok)
      return {
        error: `Judge model "${this.model}" is not available to pi: ${check.error}`,
      };

    const args = [
      "-p",
      ...lockdownArgs(),
      ...extensionArgs([]),
      "--no-tools",
      "--model",
      this.model,
      "--thinking",
      this.thinking,
      "--system-prompt",
      SYSTEM_PROMPT,
    ];

    let raw;
    try {
      raw = await runPi(args, prompt, this.timeoutMs);
    } catch (error) {
      return { error: `pi judge failed: ${error.message}` };
    }
    const json = extractJson(raw);
    if (!json)
      return {
        error: `Judge did not return JSON. Raw output:\n${raw.slice(0, 2000)}`,
      };
    return {
      output: JSON.stringify(json),
      metadata: { judgeModel: this.model, rawJudgeOutput: raw },
    };
  }
}

function runPi(args, stdin, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(piBin(), args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(
          new Error(`pi exited with ${code}: ${stderr.trim().slice(-1000)}`),
        );
      else resolve(stdout);
    });
    child.stdin.end(stdin);
  });
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}
