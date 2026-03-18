# Agent Guidelines

Pi extensions repo. Do not commit changes to git automatically.

- Run `npm install` before development
- Extensions live in `extensions/<name>/index.ts`
- To develop an extension locally, run `pi -e ./extensions/<name>/`
- All code must compile: run `npm run typecheck` and fix any errors before finishing
- Use [conventional commits](https://www.conventionalcommits.org/): `feat(git): ...`, `fix(git): ...`, `docs: ...`, `chore: ...`
- Update the README table when adding extensions
- Peer deps (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox`): use `import type`, never bundle
- If there's a test suite for the project, add all features with TDD according to the guidelines below

# TDD guidelines

- always write a failing test before fixing a bug or implementing a new feature
- do not add tests for static configuration such as UI layout that is not dynamic
