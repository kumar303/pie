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

## Example

Run a slash command to prompt the agent. Afterwards, you can view a diff of the agent's changes and get the result on your clipboard with `pbcopy`.

```
/update-pr-description

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

 Tell the agent how to update your PR description • https://github.com/example/repo/pull/1234

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Update the GitHub PR description below to reflect the latest changes on this branch.
Be careful with your edit.
Only change existing content if it's inaccurate or out of date.
Wrap any newly added content in <details> tags.

When your rewrite is ready, submit it by calling the `update_pr_description` tool with the complete new markdown in the `new_content` argument. Do not print the markdown in chat, do not write it to any other file, and do not use a different
tool to update the PR.

The existing PR description to edit is delimited by the markers below. Everything between the markers — and only that content — is editable.

----- BEGIN PR DESCRIPTION -----

[original description would be here]

─── ↓ 228 more ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

 enter submit  shift+enter newline  escape/ctrl+c cancel  ctrl+g external editor
```

## Local development

Because of tool conflicts, you have to first run `/pie-kumar303-config` to disable `update-pr-description`, and then run the local version:

```
pi -e ./extensions/update-pr-description/
```
