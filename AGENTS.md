# Agent Guidelines

This is **pie**, a Pi Package — a personal collection of [pi](https://pi.dev) extensions.

## Repo Structure

```
extensions/   # Pi extensions (.ts) — auto-loaded on pi install
```

## Commit Messages

This repo uses **[Conventional Commits](https://www.conventionalcommits.org/)**.

### Format

```
<type>(<optional scope>): <description>
```

### Types

| Type | When to use |
|------|-------------|
| `feat` | New extension or significant new capability |
| `fix` | Bug fix in an existing extension |
| `docs` | README, AGENTS.md, inline comments only |
| `chore` | Dependencies, CI config, repo housekeeping |
| `refactor` | Code restructure, no behavior change |

### Examples

```
feat(git): add interactive diff viewer
fix(git): handle untracked files in commit
docs: update README with new extension
chore: add .gitignore
```

## Adding an Extension

1. Create `extensions/<name>/index.ts` (or `extensions/<name>.ts` for single-file).
2. Update the table in `README.md`.
3. Commit with a conventional commit message.

## TypeScript Extension Syntax

### Skeleton

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
  // register tools, commands, event hooks here
}
```

- `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, and `@sinclair/typebox` are **peer dependencies** — use `import type` for the API and never bundle them.
- For multi-file extensions, import siblings with a `.js` extension: `import * as helpers from "./helpers.js"`.
