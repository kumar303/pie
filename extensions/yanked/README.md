# Yanked

Yank (save) the current pi prompt for later. For example, interrupt for another task and return to edit the prompt later.

## Usage

**Ctrl+Shift+Y** — Yank the current prompt. Clears the editor, saves the text to storage, and copies it to the system clipboard.

**`/yanked pop`** — Pop the most recently yanked prompt back into the editor.

**`/yanked list`** — Browse all yanked prompts in a selection list.

## Development

```bash
# Run with the extension loaded
pi -e ./extensions/yanked/

# Run tests
pnpm test -- extensions/yanked/
```
