# join eval: peer-name discoverability

The [join extension](../../extensions/join/README.md) names each session after its working directory: `website1`, `card-tricks1`, … This suite asks one question:

> Is that generic name enough for an agent to work out how to use `join_send` / `join_list_peers` when a human says "Ask card-tricks1 to …"?

It does not test anything else about the extension.

## Scenario

1. Two temp directories are created from `fixtures/`: `website/` (a magician's résumé page) and `card-tricks/` (a JSON list of card tricks). Both live under one sandbox root so teardown is one delete.
2. One locked-down `pi --mode rpc` starts in each directory with **only** `join_send` and `join_list_peers` (no read/write/bash). Each agent's system prompt is seeded with the contents of its own directory. `JOIN_PI_HOME` points inside the sandbox so real join channels are never touched.
3. `/join` runs in `card-tricks` first, then `website`. The runner waits up to 30 s for both agents to go quiet (they sometimes start talking to each other unprompted).
4. The prompt is sent to `website1`. Everything both agents do is recorded until both are quiet for 6 s, an agent uses 8 turns, or 4 minutes pass.
5. Processes are killed and the sandbox is removed.

Three prompt variants (`tests` in `promptfooconfig.yaml`):

| scenario           | prompt                                                    | what it probes                                             |
| ------------------ | --------------------------------------------------------- | ---------------------------------------------------------- |
| `exact-name`       | Ask **card-tricks1** to give you 5 random card tricks     | the baseline: name matches the peer exactly                |
| `misspelled-name`  | Ask **cart-tricks1** to give you 5 random card tricks     | recovery from a wrong name (`join_list_peers`, retry)      |
| `descriptive-name` | Ask **the card-tricks agent** to give you 5 random tricks | mapping a description to a peer name without being told it |

Each variant runs against both models, 3 times each (`evaluateOptions.repeat`).

## Scoring

Two layers, following promptfoo's model: deterministic assertions over the recorded tool calls, plus an LLM judge over the transcript. Per-test score is the weighted mean; a test passes at ≥ 0.7.

| metric             | weight | source                               | what it means                                                                                     |
| ------------------ | -----: | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `request_sent`     |      3 | `join-checks.mjs:websiteSentRequest` | `website1` delivered a `join_send` to `card-tricks1`                                              |
| `reply_sent`       |      3 | `join-checks.mjs:cardTricksReplied`  | `card-tricks1` delivered a `join_send` back to `website1` after the request                       |
| `tool_correctness` |      2 | `join-checks.mjs:toolUseCorrect`     | 1 − failed calls / total calls (unknown peer, bad args, nonexistent tool)                         |
| `turn_efficiency`  |      2 | `join-checks.mjs:turnEfficiency`     | mean of 1/turns-to-request and 1/turns-to-reply (1.0 = both on their first turn)                  |
| `chatter`          |      1 | `join-checks.mjs:noExtraChatter`     | 1 / (1 + extra `join_send` calls beyond the request and the reply), incl. greetings after `/join` |
| `completion`       |      1 | `join-checks.mjs:completedCleanly`   | the human got a final answer from `website1` after the reply arrived                              |
| `judge`            |      3 | `llm-rubric` via `pi-judge.mjs`      | holistic 0–1 score from `prompts/judge-rubric.txt`; pass ≥ 0.7; names confusion signals           |

The judge runs through `pi -p` (`providers/pi-judge.mjs`) so it uses the same credentials and model catalogue as the agents. Change it with `PI_EVAL_JUDGE_MODEL`.

The provider's `output` is a readable summary + transcript (what the judge and the web UI see). The structured result (`outcome`, per-agent turns, every tool call with arguments and result, `endedReason`, token usage) is in `response.metadata` and drives the deterministic checks.

## Running

From `evals/`:

```sh
pnpm run eval:join            # full matrix: 3 scenarios × 2 models × 3 repeats
pnpm run eval:join:smoke      # 1 scenario × 2 models × 1 repeat
pnpm run report:join          # join/results/report.md from join/results/latest.json
pnpm run view                 # promptfoo web UI
pnpm run debug:join B         # one scenario, no promptfoo; A|B|judge or provider/model
```

See [../README.md](../README.md) for model configuration and the `PI_EVAL_EXTRA_EXTENSIONS` special case.

## Reading the results

`pnpm run report:join` prints one row per model × scenario:

- **1st-turn request / reply** – the direct answer to the question. If these are near 100% and tool errors are 0, the name is discoverable.
- **join-phase msgs** – messages the agents sent each other before the human typed anything. Not a naming problem, but a cost of the `/join` instructions.
- **extra msgs** and **ended by cap** – how much back-and-forth followed the answer, and whether the runner had to stop it.
- **judge** – reads the transcript and lists every confusion or noise signal it saw; check the "Judge reasons" section for the concrete quotes.

A run is only informative about _naming_ if `request_sent`/`reply_sent` and `tool_correctness` differ between scenarios or models. Chatter and turn caps are separate signals about the join instructions.

## Latest results

See [FINDINGS.md](./FINDINGS.md) for the analysis of the most recent run.

## Files

```
promptfooconfig.yaml      scenarios, providers, assertions, judge config
providers/join-pair.mjs   scenario runner (sandbox, two pi RPC sessions, analysis, transcript)
providers/pi-judge.mjs    llm-rubric grader backed by `pi -p`
assertions/join-checks.mjs deterministic checks (read context.metadata)
prompts/judge-rubric.txt  judge instructions
fixtures/website/         index.html – fake résumé of an Edinburgh magician
fixtures/card-tricks/     card-tricks.json – 12 well-known tricks
scripts/validate-models.mjs, debug-run.mjs, report.mjs
```
