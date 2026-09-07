# brain

Multi-task ongoing pi sessions. Invoke with `/brain`.

My own tiny little brain can't handle multi-tasking but with [`pi`](https://pi.dev/) there's so much I want to do all the time.
Typing `/brain` shows me all the tasks I'm waiting on and lets me navigate between them.
Specifically, it shows the other directories where I have a `pi` session open.
If any are still waiting for `pi` results, it shows a spinner.

My `$EDITOR` is set to `code` (VS Code) and I always run `pi` in an integrated terminal.
I'm pretty sure `/brain` will only work for you if you have a similar setup.
It switches projects by invoking `$BRAIN_EDITOR` on the directory when set, otherwise falling back to `$EDITOR`.

```
 ▶ pie [main]
══════════════════════════════════════════════════════════════════════
   Today
     > pie [main]
       other-project [example-branch]
       example-directory [main]
       extension-error-simulator [main]
       scratch-worktree-fix
       ui-extensions [main]
       scratch

   Earlier
       another-directory [main]

──────────────────────────────────────────────────────────────────────
 ↑↓ navigate • / search • esc quit
```

## Installation

This is a `pi` extension. Run [`/pie-kumar303-config`](../../README.md#install) to install it.
