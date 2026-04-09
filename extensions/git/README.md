# git

View git diffs and re-prompt the agent. Invoke with `/git`.

## File selector

This shows your modified files according to `git status`. You can:

- select some files and stage a `git` command with them
- press `d` to enter the diff viewer

## Diff viewer

Quickly page through a diff and tell the agent how dumb it is. Two panes: a diff viewer and a prompt editor.

```
─────────────────────────────────────────────────────────────────────────────────────────────────────
   Diff (ws hidden) │ extensions/git/README.md│ ▶ Prompt
─────────────────────────────────────────────────────────────────│═══════════════════════════════════
 diff --git a/extensions/git/README.md b/extensions/git/README.md│extensions/git/README.md
 index 98732cf6..bfdc10cd 100644                                 │
 --- a/extensions/git/README.md                                  │Really? No. Try it again.
 +++ b/extensions/git/README.md                                  │
 @@ -11,14 +11,14 @@ This shows your modified files according ...│
                                                                 │
  ## Diff viewer                                                 │
                                                                 │
 -View the diff and use another pane to ask `pi` for changes w...│
 +Quickly page through a diff and tell the agent how dumb it i...│
                                                                 │
  ### Features                                                   │
                                                                 │
 -- hide tests                                                   │
 -- hide certain diffs like `package-lock.json`                  │
 +- option: hide tests                                           │
─────────────────────────────────────────────────────────────────────────────────────────────────────
  enter send · opt+enter follow-up · \+enter newline · tab complete · ↑↓ history · ^C clear · esc ...
```

### Features

- option: hide whitespace
- option: hide tests
- option: hide files on demand like `package-lock.json`
- jump to the next / previous file
- full prompt editor with auto-completion and history

## Auto-generated commits

The agent will suggest a commit message and you can edit it before committing.

## Staged git command

Because adding selected files is difficult on the command line, this feature lets you write a command like `git commit {}` where `{}` is replaced with selected files. The command only runs after you press enter.
