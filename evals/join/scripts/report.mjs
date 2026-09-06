#!/usr/bin/env node
// Summarise a promptfoo results file for the join suite into a markdown report.
// Usage: node join/scripts/report.mjs [results/latest.json] [results/report.md]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE = resolve(HERE, "..");
const [, , inputArg = "results/latest.json", outputArg = "results/report.md"] =
  process.argv;
// Paths resolve against the suite directory (evals/join) unless they exist relative to cwd.
const inputPath = existsSync(resolve(inputArg))
  ? resolve(inputArg)
  : resolve(SUITE, inputArg);
const outputPath = resolve(
  dirname(inputPath),
  outputArg.startsWith("results/")
    ? outputArg.slice("results/".length)
    : outputArg,
);

const file = JSON.parse(readFileSync(inputPath, "utf8"));
const results = file.results?.results ?? file.results ?? [];
if (!Array.isArray(results) || results.length === 0) {
  console.error(`No results found in ${inputPath}`);
  process.exit(1);
}

const groups = new Map();
for (const row of results) {
  const model = row.provider?.label ?? row.provider?.id ?? "unknown";
  const scenario =
    row.testCase?.metadata?.scenario ?? row.vars?.peer_name ?? "default";
  const key = `${model}\u0000${scenario}`;
  if (!groups.has(key)) groups.set(key, { model, scenario, rows: [] });
  groups.get(key).rows.push(row);
}

const mean = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
const fmt = (value, digits = 2) =>
  Number.isNaN(value) ? "–" : value.toFixed(digits);
const pct = (value) =>
  Number.isNaN(value) ? "–" : `${Math.round(value * 100)}%`;
const count = (rows, predicate) => rows.filter(predicate).length;

function metadataOf(row) {
  return row.response?.metadata ?? {};
}

function judgeOf(row) {
  const components = row.gradingResult?.componentResults ?? [];
  return components.find(
    (component) => component.assertion?.type === "llm-rubric",
  );
}

const lines = [];
lines.push(`# join eval report`);
lines.push("");
lines.push(
  `Source: \`${inputArg}\` (${results.length} runs, ${file.results?.timestamp ?? file.timestamp ?? "unknown time"})`,
);
lines.push("");
lines.push(
  `Question: is a generic peer name like \`card-tricks1\` enough for agents to work out how to use the join tools?`,
);
lines.push("");

// --- Headline table ---------------------------------------------------------
lines.push("## Headline");
lines.push("");
lines.push(
  "| model | scenario | n | pass | score | request sent | reply sent | 1st-turn request | 1st-turn reply | tool errors | extra msgs | join-phase msgs | ended by cap | judge |",
);
lines.push(
  "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
);
for (const group of [...groups.values()].sort(
  (a, b) =>
    a.model.localeCompare(b.model) || a.scenario.localeCompare(b.scenario),
)) {
  // promptfoo also sets `error` on threshold failures; only rows without scenario data are harness errors.
  const rows = group.rows.filter((row) => metadataOf(row).agents);
  const errored = group.rows.length - rows.length;
  const md = rows.map(metadataOf);
  lines.push(
    [
      group.model,
      group.scenario,
      `${group.rows.length}${errored ? ` (${errored} err)` : ""}`,
      pct(mean(group.rows.map((row) => (row.success ? 1 : 0)))),
      fmt(mean(rows.map((row) => row.score ?? 0))),
      pct(mean(md.map((m) => (m.outcome.websiteSentRequest ? 1 : 0)))),
      pct(mean(md.map((m) => (m.outcome.cardTricksReplied ? 1 : 0)))),
      pct(mean(md.map((m) => (m.agents.website.turns.toTarget === 1 ? 1 : 0)))),
      pct(
        mean(md.map((m) => (m.agents.cardTricks.turns.toTarget === 1 ? 1 : 0))),
      ),
      fmt(mean(md.map((m) => m.totals.toolErrors)), 1),
      fmt(mean(md.map((m) => m.totals.extraSends)), 1),
      fmt(
        mean(
          md.map(
            (m) =>
              m.agents.website.extraSendsInJoinPhase +
              m.agents.cardTricks.extraSendsInJoinPhase,
          ),
        ),
        1,
      ),
      pct(
        mean(
          md.map((m) => (String(m.endedReason).startsWith("turn_cap") ? 1 : 0)),
        ),
      ),
      fmt(
        mean(
          rows
            .map((row) => judgeOf(row)?.score ?? NaN)
            .filter((v) => !Number.isNaN(v)),
        ),
      ),
    ]
      .join(" | ")
      .replace(/^/, "| ")
      .concat(" |"),
  );
}
lines.push("");
lines.push(
  "Columns: *1st-turn request/reply* = the agent's very first task-phase turn contained the correct `join_send`; *extra msgs* = `join_send` calls beyond the one request and one reply; *join-phase msgs* = unprompted messages sent between `/join` and the task prompt; *ended by cap* = the scenario had to be stopped by the per-agent turn limit.",
);
lines.push("");

// --- Named metric means -----------------------------------------------------
lines.push("## Metric means (0–1, from promptfoo named scores)");
lines.push("");
const metricNames = [
  ...new Set(results.flatMap((row) => Object.keys(row.namedScores ?? {}))),
];
lines.push(`| model | scenario | ${metricNames.join(" | ")} |`);
lines.push(`|---|---|${metricNames.map(() => "---:").join("|")}|`);
for (const group of groups.values()) {
  const cells = metricNames.map((name) =>
    fmt(
      mean(
        group.rows
          .map((row) => row.namedScores?.[name])
          .filter((v) => typeof v === "number"),
      ),
    ),
  );
  lines.push(`| ${group.model} | ${group.scenario} | ${cells.join(" | ")} |`);
}
lines.push("");

// --- Tool call details ------------------------------------------------------
lines.push("## Tool usage");
lines.push("");
for (const group of groups.values()) {
  const md = group.rows.map(metadataOf).filter((m) => m.agents);
  if (!md.length) continue;
  const toolNames = {};
  const errors = [];
  for (const m of md) {
    for (const agentKey of ["website", "cardTricks"]) {
      for (const call of m.agents[agentKey].toolCalls) {
        const label = `${m.agents[agentKey].name}:${call.name}`;
        toolNames[label] = (toolNames[label] ?? 0) + 1;
        if (!call.ok)
          errors.push(
            `${m.agents[agentKey].name} ${call.name}(${JSON.stringify(call.args)}) -> ${call.result}`,
          );
      }
    }
  }
  lines.push(`### ${group.model} — ${group.scenario}`);
  lines.push("");
  lines.push(
    `Tool calls across ${md.length} run(s): ${
      Object.entries(toolNames)
        .map(([k, v]) => `${k} ×${v}`)
        .join(", ") || "none"
    }`,
  );
  lines.push("");
  lines.push(
    `Ended by: ${Object.entries(
      md.reduce(
        (acc, m) => ({
          ...acc,
          [m.endedReason]: (acc[m.endedReason] ?? 0) + 1,
        }),
        {},
      ),
    )
      .map(([k, v]) => `${k} ×${v}`)
      .join(", ")}`,
  );
  lines.push("");
  lines.push(
    `Agents quiet before the task was typed: ${count(md, (m) => m.joinPhaseQuiet)}/${md.length}`,
  );
  lines.push("");
  if (errors.length) {
    lines.push("Tool errors:");
    for (const error of errors.slice(0, 20)) lines.push(`- ${error}`);
    lines.push("");
  }
  const requests = md.map((m) => m.request?.text).filter(Boolean);
  if (requests.length) {
    lines.push("Request messages website1 sent:");
    for (const text of requests) lines.push(`- ${oneLine(text, 220)}`);
    lines.push("");
  }
}

// --- Judge reasons ----------------------------------------------------------
lines.push("## Judge reasons");
lines.push("");
for (const group of groups.values()) {
  lines.push(`### ${group.model} — ${group.scenario}`);
  lines.push("");
  for (const row of group.rows) {
    const judge = judgeOf(row);
    if (row.error) {
      lines.push(`- ERROR: ${oneLine(row.error, 300)}`);
    } else if (judge) {
      lines.push(`- (${fmt(judge.score)}) ${oneLine(judge.reason ?? "", 600)}`);
    }
  }
  lines.push("");
}

const report = lines.join("\n");
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, report);
console.log(report);
console.error(`\nWrote ${outputPath}`);

function oneLine(text, max) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
