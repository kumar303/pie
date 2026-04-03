# Agent Guidelines

Pi extensions repo. Do not commit changes to git automatically.

- Run `pnpm install` before development
- Extensions live in `extensions/<name>/index.ts`
- To develop an extension locally, run `pi -e ./extensions/<name>/`
- All tests must pass: run `pnpm test` after changes and fix errors
- All code must compile: run `pnpm run typecheck` and fix any errors
- All code must pass linting: run `pnpm run lint` and fix any errors
- After every change, run `pnpm run format` to reformat all files with Prettier
- Use [conventional commits](https://www.conventionalcommits.org/): `feat(git): ...`, `fix(git): ...`, `docs: ...`, `chore: ...`
- Update the README table when adding extensions
- Peer deps (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox`): use `import type`, never bundle
- Never catch and ignore errors unless they are expected; report all caught errors in a log or in the UI.

# TDD guidelines

- always write a failing test before fixing a bug or implementing a new feature
- do not add tests for static configuration such as UI layout that is not dynamic
