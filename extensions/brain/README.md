# brain

Three-panel TUI for browsing recent project directories and their tool output logs. Invoke with `/brain`.

## Layout

```
┌─────────────┬─────────────────┐
│  Today      │  Logs           │
├─────────────┤                 │
│  Earlier    │                 │
└─────────────┴─────────────────┘
│ legend                        │
└───────────────────────────────┘
```

- **Today** — Directories active today. Git repos show branch: `acme [main]`.
- **Earlier** — Directories from before today.
- **Logs** — Tails the tool output log for the selected directory.

Actively working directories show an animated spinner.

## Keybindings

### Directory panels (Today / Earlier)

| Key      | Action                                   |
| -------- | ---------------------------------------- |
| `↑`/`↓`  | Move cursor (wraps around)               |
| `Tab`    | Cycle focus to next panel                |
| `Enter`  | Open selected directory in `$EDITOR`     |
| `/`      | Enter search mode                        |
| `Escape` | Exit `/brain`                            |

### Logs panel

| Key      | Action                    |
| -------- | ------------------------- |
| `↑`/`↓`  | Scroll one line           |
| `d`/`u`  | Page down / up            |
| `g`/`G`  | Scroll to top / bottom    |
| `Tab`    | Cycle focus to next panel |
| `Escape` | Exit `/brain`             |

### Search mode

Press `/` to search. Filters both Today and Earlier by directory name, path, or branch.

## Storage

Default location: `~/.pi/agent/brain/`. Override with `PI_BRAIN_DIR` env var.

```
$PI_BRAIN_DIR/
├── sessions.jsonl              # Directory registry
├── status/<session-id>.status  # Working/idle state
└── logs/<session-id>.log       # Tool output (last 100 lines)
```
