# git

Interactive git UI inside pi. Invoke with `/git`.

## File selector

This shows your modified files according to `git status`. You can:

- select some files and stage a `git` command with them
- press `d` to enter the diff viewer

## Staged git command

Because adding selected files is difficult on the command line, this feature lets you write a command like `git commit {}` where `{}` is replaced with selected files. The command only runs after you press enter.

## Diff viewer

View a diff and use another pane to ask `pi` for changes while you're paging through it.
