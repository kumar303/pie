#!/usr/bin/env node
// Fail fast if any configured model is not known to pi on this machine.
import {
  bootstrapExtensions,
  resolveModel,
  resolveThinking,
  validateModel,
} from "../../lib/pi-cli.mjs";

const slots = [
  ["A", "PI_EVAL_MODEL_A"],
  ["B", "PI_EVAL_MODEL_B"],
  ["judge", "PI_EVAL_JUDGE_MODEL"],
];

let failed = false;
const extras = bootstrapExtensions();
console.log(
  `pi bootstrap extensions: ${extras.length ? extras.join(", ") : "(none)"}`,
);
console.log(`thinking level: ${resolveThinking()}`);

for (const [slot, envVar] of slots) {
  const model = resolveModel(slot);
  const check = await validateModel(model);
  if (check.ok) {
    console.log(`✔ ${slot.padEnd(5)} ${model}`);
  } else {
    failed = true;
    console.error(`✘ ${slot.padEnd(5)} ${model}: ${check.error}`);
    const suggestions = check.rows
      .slice(0, 8)
      .map((row) => `${row.provider}/${row.id}`);
    if (suggestions.length)
      console.error(`  candidates: ${suggestions.join(", ")}`);
    console.error(`  set ${envVar}=<provider/model> (see: pi --list-models)`);
    if (!suggestions.length && !process.env.PI_EVAL_EXTRA_EXTENSIONS) {
      console.error(
        "  if this machine reaches providers through a pi extension, set PI_EVAL_EXTRA_EXTENSIONS=/path/to/that/extension (see evals/README.md)",
      );
    }
  }
}

if (failed) process.exit(1);
