# /critical-review

Perform a critical code review with specialist sub agents, filtered for review quality.

## Usage

```
/critical-review         Start a review
/critical-review -help   Show usage
/critical-review -fix    Start a review and implement all fixes
/critical-review -watch  Open the log viewer
/critical-review -abort  Abort an ongoing review
/critical-review -fix-loop  Fix and re-review until clean (max 10 iterations)
```

## Reviewer Selection

When a review starts, a selection screen lists the available reviewers:

- `space` — toggle a reviewer on/off
- `m` — edit the model for the highlighted reviewer (with autocomplete)
- `r` — edit the reasoning level (with autocomplete)
- `e` — edit the reviewer's prompt inline. Inside the prompt editor: `^S`
  (ctrl+s) saves the prompt to disk, `esc` returns keeping the edit in memory
  for this review only, and `shift+enter` inserts a new line. Edits made here
  are used for the review whether or not they are saved to disk.
- `n` — add a new reviewer. Prompts for a name (letters, numbers, `-` and `_`
  only; must be unique), then opens the same inline prompt editor. The new
  reviewer is kept in memory for this review unless you press `^S` to save it
  permanently to `~/.local/share/critical-review-pi/reviewers`.
- `enter` — start the review with the selected reviewers
- `esc` — cancel

## How It Works

1. **Gather context** — Fetches PR metadata and generates a diff using `gh` and `git`
2. **Run reviewers** — Specialist reviewer agents (defined as `.md` files) run in parallel, each analyzing the diff from their perspective
3. **Deduplicate** — Semantically similar issues across reviewers are merged
4. **Judge** — A skeptical critic agent evaluates each issue with full codebase access. Only real, actionable bugs survive
5. **Report** — Results are copied to clipboard and sent as an agent message

## Reviewers

Reviewers are defined as markdown files in `reviewers/`:

- `correctness.md` — Logic errors, null handling, edge cases
- `security.md` — Exploitable vulnerabilities
- `test-quality.md` — Tests that don't test what they claim

### Adding Custom Reviewers

Create a `.md` file in `reviewers/` with frontmatter:

```markdown
---
name: my-reviewer
description: What this reviewer checks for
tools: read, grep, find, ls, bash
can_edit_code: false
---

Your system prompt here telling the reviewer what to look for.
```

The model and reasoning level for each reviewer are configured separately (and
editable from the selection screen), not in the frontmatter.

## Requirements

- `gh` CLI tool (authenticated)
- Current branch must be a PR branch

## Fix Mode

`-fix` sends results prefaced with "Fix the following issues with TDD:" so the agent implements fixes.

`-fix-loop` repeatedly reviews and fixes until no issues remain (max 10 iterations).
