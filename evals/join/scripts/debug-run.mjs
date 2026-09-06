#!/usr/bin/env node
// Run the join scenario once, outside promptfoo, and print the transcript.
// Usage: node join/scripts/debug-run.mjs [modelSlot|provider/model] ["prompt"]
//   PI_EVAL_DEBUG_EVENTS=1 prints every RPC event as it happens.
import JoinPairProvider from "../providers/join-pair.mjs";

const [, , modelArg = "A", promptArg] = process.argv;
const config = modelArg.includes("/")
  ? { model: modelArg }
  : { modelSlot: modelArg };
const provider = new JoinPairProvider({ id: "debug", config });
const prompt = promptArg ?? "Ask card-tricks1 to give you 5 random card tricks";

const logger = {
  debug: (message) => console.error(`[debug] ${message}`),
};
console.error(`model: ${provider.model} thinking: ${provider.thinking}`);
console.error(`prompt: ${prompt}`);
const response = await provider.callApi(prompt, { vars: {}, logger });
if (response.error) {
  console.error(`ERROR: ${response.error}`);
  process.exit(1);
}
console.log(response.output);
console.error(
  `\nstructured result keys: ${Object.keys(response.metadata).join(", ")}`,
);
console.error(
  JSON.stringify(
    {
      outcome: response.metadata.outcome,
      totals: response.metadata.totals,
      endedReason: response.metadata.endedReason,
    },
    null,
    2,
  ),
);
