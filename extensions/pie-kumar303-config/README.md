# pie-kumar303-config

Extension manager for the `pie-kumar303` package. Run `/pie-kumar303-config` to selectively install or remove extensions, skills, and themes from this repo.

## Usage

Type `/pie-kumar303-config` to open a two-panel UI:

- **Left panel**: Checkbox list of available extensions, skills, and themes. Use ↑↓ to navigate, Space to toggle.
- **Right panel**: README or SKILL.md preview for the highlighted item. Use g/G for top/bottom, d/u for page up/down.

Press **Enter** to apply changes. The command manages symlinks in `~/.pi/agent/extensions/`, `~/.pi/agent/skills/`, and `~/.pi/agent/themes/`.
Press **Escape** to cancel without changes.
