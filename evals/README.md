# evals

Behavioural evals for the extensions in this repo, built on [promptfoo](https://www.promptfoo.dev/docs/intro/).

Unlike the unit tests in `extensions/*/index.test.ts`, these run real `pi` sessions with real models and grade what the agents do. They are slow, cost tokens, and are not part of `pnpm test`.

| Suite                       | What it measures                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| [`join/`](./join/README.md) | Whether generic peer names like `card-tricks1` are enough for agents to use the join tools |

## Setup

```sh
cd evals
pnpm install
```

`pi` must be on your `PATH` (or set `PI_BIN=/path/to/pi`). Extensions under test are loaded from `../extensions/`, so run everything from this directory.

## Running

```sh
# check that the configured models exist on this machine, then run the suite
pnpm run eval:join

# one quick run per model (first scenario only) to check the plumbing
pnpm run eval:join:smoke

# summarise the last run as markdown (writes join/results/report.md)
pnpm run report:join

# browse runs in promptfoo's web UI
pnpm run view
```

`pnpm run eval:join` is `promptfoo eval -c join/promptfooconfig.yaml --no-cache`. Any extra promptfoo flags pass through, for example `pnpm run eval:join --repeat 5` or `--filter-metadata scenario=exact-name`.

Results land in `join/results/latest.json` (raw promptfoo output). promptfoo's own state (results database, cache) is kept in `evals/.promptfoo/`, not `~/.promptfoo`, via `bin/promptfoo.mjs`.

## Configuration

Everything is controlled with environment variables so the same config runs on any machine.

| Variable                   | Default                   | Purpose                                                                                        |
| -------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------- |
| `PI_EVAL_MODEL_A`          | `openai/gpt-5.6-sol`      | First model under test (`provider/model`, as printed by `pi --list-models`)                    |
| `PI_EVAL_MODEL_B`          | `anthropic/claude-opus-5` | Second model under test                                                                        |
| `PI_EVAL_JUDGE_MODEL`      | `anthropic/claude-opus-5` | Model used by the LLM judge (`llm-rubric`)                                                     |
| `PI_EVAL_THINKING`         | `medium`                  | Thinking level for the agents under test                                                       |
| `PI_EVAL_EXTRA_EXTENSIONS` | _(empty)_                 | Extra `-e` extensions every pi process needs on this machine (see below)                       |
| `PI_EVAL_TMPDIR`           | `/tmp`                    | Base for temp sandboxes. Keep it short: the join socket path must fit the OS socket-path limit |
| `PI_BIN`                   | `pi`                      | Path to the pi binary                                                                          |

Model names differ between machines and catalogues. `pnpm run validate-models` runs `pi --list-models` and fails with candidates when a name is missing or ambiguous:

```
✘ A     gpt-5.6-sol: "gpt-5.6-sol" is ambiguous; use provider/model. Candidates: openai/gpt-5.6-sol, openai-1m/gpt-5.6-sol, ...
```

### Machines that need a bootstrapping extension

Some machines can only reach model providers through an extra pi extension (for example an API proxy that registers providers and injects credentials). The evals start pi with `--no-extensions` so that nothing but the extension under test is loaded, which would also drop that proxy. Point `PI_EVAL_EXTRA_EXTENSIONS` at it and it is added to every pi process the evals start, including the judge and model validation:

```sh
export PI_EVAL_EXTRA_EXTENSIONS=/path/to/your/api-proxy-extension
pnpm run eval:join
```

Separate several paths with `:` or `,`. Do not add extensions that give the agents extra tools; that would change what the eval measures.

## How the agents are locked down

Every agent under test starts as:

```
pi --mode rpc --no-session --no-extensions --no-skills --no-prompt-templates --no-themes \
   --no-context-files --no-approve --offline \
   --no-builtin-tools --tools <only the tools of the extension under test> \
   -e ../extensions/<name> [-e $PI_EVAL_EXTRA_EXTENSIONS] \
   --model <model> --thinking <level> --append-system-prompt <seed file>
```

The agents cannot read, write, or run shell commands. Anything they need to know about their working directory is seeded into the system prompt from fixtures. Sessions are not saved. See `lib/pi-cli.mjs`.

## Layout

```
evals/
  bin/promptfoo.mjs        promptfoo CLI wrapper (project-local state, no telemetry)
  lib/pi-cli.mjs           lockdown flags, env-var config, model validation
  lib/pi-rpc.mjs           minimal client for `pi --mode rpc`
  lib/sandbox.mjs          temp dirs + child processes with atomic teardown
  join/                    one directory per suite
    promptfooconfig.yaml   scenarios, assertions, judge
    providers/             promptfoo providers (scenario runner, pi-backed judge)
    assertions/            deterministic checks
    prompts/               judge rubric
    fixtures/              static inputs copied into each sandbox
    scripts/               validate-models, debug-run, report
    results/               (gitignored) latest.json, report.md
```

## Adding a suite

1. Create `evals/<name>/promptfooconfig.yaml` plus `providers/`, `assertions/`, `fixtures/`.
2. Reuse `lib/pi-cli.mjs` for lockdown flags and `lib/sandbox.mjs` for temp dirs.
3. Return a readable transcript as the provider `output` and structured data as `metadata`; write deterministic assertions against `context.metadata` and let `llm-rubric` read the transcript.
4. Add `eval:<name>` and `report:<name>` scripts to `package.json` and a row to the table above.

## Troubleshooting

- `Model "x" is not available to pi` – run `pi --list-models x` and set `PI_EVAL_MODEL_A/B` to an exact `provider/model`.
- `Timed out ... waiting for /join to settle` or `/join reported an error: ENOENT ... .sock` – the sandbox path is too long for a Unix socket. Set `PI_EVAL_TMPDIR` to a short writable directory.
- Stray `pje-*` directories in `/tmp` or leftover `pi` processes mean a run was killed with `SIGKILL`; the sandbox cleans up on normal exit, `SIGINT`, `SIGTERM` and `SIGHUP`.
- To watch one scenario live: `PI_EVAL_DEBUG_EVENTS=1 pnpm run debug:join B` (prints every RPC event to stderr, transcript to stdout).
