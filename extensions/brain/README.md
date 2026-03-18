# brain

TUI for keeping track of what I'm working on. Invoke with `/brain`.

My own tiny little brain can't handle multi-tasking but with `pi` there's so much I want to do all the time.
Typing `/brain` shows me all the tasks I'm waiting on and lets me navigate between them.
Specifically, it shows the other directories where I have a `pi` session open.
If any of are still waiting for `pi` results, it shows a spinner and streams the `pi` output.

My `$EDITOR` is set to `code` (VS Code) and I always run `pi` in an integrated terminal.
I'm pretty sure `/brain` will only work for you if you have a similar setup.
It switches projects by invoking `$EDITOR` on the directory.

```
 ▶ pie [main]                           │   Logs
════════════════════════════════════════│─────────────────────────────────────────────────────────────
   Today                                │    Start at  12:06:10
     > pie [main]                       │    Duration  271ms (transform 94ms, setup 0ms, import 185...
       other-project [example-branch]   │
       example-directory [main]         │
       extension-error-simulator [main] │ [bash] 2026-03-18T12:06:12.350Z
       scratch-worktree-fix             │
       something-else [long-branch-na...│ > test
       ui-extensions [main]             │ > vitest run
       scratch                          │
                                        │
   Earlier                              │  RUN  v4.1.0 /Users/kumar/src/github.com/kumar303/pie
       another-directory [main]         │
                                        │
                                        │  Test Files  2 passed (2)
                                        │       Tests  68 passed (68)
                                        │    Start at  12:06:10
                                        │    Duration  271ms (transform 94ms, setup 0ms, import 185...
                                        │
                                        │
                                        │
──────────────────────────────────────────────────────────────────────────────────────────────────────
 ↑↓ navigate • tab logs • / search • esc quit
```
