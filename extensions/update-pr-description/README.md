# update-pr-description

Pi extension that provides `/update-pr-description`.

## What it does

1. Discovers the PR for the current branch via `gh pr view --json body --jq .body`.
2. Creates a temp working directory and stores the original body as
   `original.md` plus a working copy `current.md`.
3. Asks the agent to rewrite the markdown to reflect the latest changes on
   the branch, wrapping any newly added content in `<details>` tags.
4. Registers an `update_pr_description` tool the agent uses to submit its
   rewrite. The extension writes it to `current.md` and shows a `delta` diff
   in a confirmation dialog.
5. On accept: the new body is piped to `pbcopy`. On reject: the agent
   receives a hint to wait for user feedback so you can iterate.

## Requirements

- [`gh`](https://cli.github.com/) on your `PATH`
- [`delta`](https://github.com/dandavison/delta) on your `PATH`
- `pbcopy` (macOS; adapt for other platforms as needed)

## Local development

```
pi -e ./extensions/update-pr-description/
```
