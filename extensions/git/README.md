# git

Interactive git UI inside pi. Invoke with `/git`.

## File selector

This shows your modified files according to `git status`. You can:

- select some files and stage a `git` command with them
- press `d` to enter the diff viewer

## Diff viewer

View the diff and use another pane to ask `pi` for changes while you're paging through it. This helps you polish up the tail end of an agentic session and / or make sure the agent isn't going bananas. If you're doing code review, it accelerates feedback to the agent.

### Features

- hide tests
- hide certain diffs like `package-lock.json`
- jump to the next / previous file
- standard prompt editor with auto-completion and history

## Auto-generated commits

The agent will suggest a commit message and you can edit it before committing.

## Staged git command

Because adding selected files is difficult on the command line, this feature lets you write a command like `git commit {}` where `{}` is replaced with selected files. The command only runs after you press enter.
