# worktree

A simple `git worktree` manager. Invoke with `/worktree`.

## Commands

| Command                            | Action                                            |
| ---------------------------------- | ------------------------------------------------- |
| `/worktree` or `/worktree help`    | Show usage.                                       |
| `/worktree config`                 | Add/remove the directories scanned for git repos. |
| `/worktree add <repo> <branch>`    | Create a new worktree and open it in `$EDITOR`.   |
| `/worktree remove <repo> <branch>` | Remove an existing worktree directory.            |

## Where things live

All state for the extension lives under

```
~/.local/share/worktree-pi/
├── config.json          # { "dirs": ["/path/to/scan-root", ...] }
└── trees/               # all worktrees go here
```

Worktrees are organized inside `trees/` so they mirror the
on-disk layout of the source repos. The path under `trees/`
is the repo's path with two simplifications:

- If the repo is under your home directory, the home prefix
  is dropped (so paths stay short for the common case).
- Otherwise the leading `/` is dropped so the rest can sit
  under `trees/`.

The worktree directory itself is named `<repo>_<branch>`.

### Examples

| Repo path                           | Branch        | Worktree path                                                                   |
| ----------------------------------- | ------------- | ------------------------------------------------------------------------------- |
| `~/src/github.com/kumar303/pie`     | `some-branch` | `~/.local/share/worktree-pi/trees/src/github.com/kumar303/pie_some-branch`      |
| `/Volumes/some/other/place/example` | `some-branch` | `~/.local/share/worktree-pi/trees/Volumes/some/other/place/example_some-branch` |

## Repo autocompletion

`/worktree add <repo>` and `/worktree remove <repo>` complete
against repos discovered under your scan directories.

- The dropdown shows the short repo name (e.g. `pie`) with the
  full path in the description column.
- When the short name is unique among scanned repos, the short
  name is inserted (`/worktree add pie …`).
- When two scan directories contain a repo with the same name,
  the full path is inserted instead so the picked item is
  always unambiguously resolvable.
