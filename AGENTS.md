# Agent Guidelines

Pi extensions repo. Do not commit changes to git automatically.

- Extensions live in `extensions/<name>/index.ts`
- `.pi/extensions` symlinks to `./extensions` for local dev
- Use [conventional commits](https://www.conventionalcommits.org/): `feat(git): ...`, `fix(git): ...`, `docs: ...`, `chore: ...`
- Update the README table when adding extensions
- Peer deps (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox`): use `import type`, never bundle
