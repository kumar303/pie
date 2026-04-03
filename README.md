# 🥧 pie

```
pie[xtensions, agents, skills, and stuff]
```

My daily-use extensions for [pi](https://pi.dev), a customizable coding agent that runs in your terminal.

Yolo. Some work well, some are more experimental. They come with **no guarantee of support**.

All code is licensed under [WTFPL](LICENSE).

## Extensions

| Extension                                                    | Description                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [brain](extensions/brain/)                                   | Three-panel TUI for browsing recent project directories and their tool output logs. Invoke with `/brain`.                                                                                                          |
| [git](extensions/git/)                                       | Interactive git file selector and command runner. Invoke with `/git`. Navigate files, select with tab, run commands with `{}` placeholder expansion, generate commit messages with AI, view diffs in a split pane. |
| [no-sleep-while-working](extensions/no-sleep-while-working/) | Prevents your Mac from sleeping while pi is actively working. Uses `caffeinate` under the hood.                                                                                                                    |

## Install

Install pie as a pi package from git:

```bash
pi install https://github.com/kumar303/pie
```

This clones the repo and loads all extensions automatically.

### Managing extensions

After installing, use `pi config` to enable or disable individual extensions. Run `pi update` to pull the latest changes.

## Development

Install dependencies first:

```bash
pnpm install
```

To develop a specific extension locally, run pi with the `-e` flag:

```bash
pi -e ./extensions/git/
```

This loads the local version of the extension for that session.

## Contributing

If you found a bug or want to improve something in here -- thank you! I can't guarantee I'll get to it, though. I recommend forking the repo or copying what you need to make it your own.

## License

[WTFPL](LICENSE) — Do Whatever
