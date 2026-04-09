# 🥧 pie

```
pie[xtensions, agents, skills, and stuff]
```

My daily-use extensions for [pi](https://pi.dev), a customizable coding agent.

Yolo. Some work well, some are more experimental. They come with **no guarantee of support**.

All code is licensed under [WTFPL](LICENSE).

## Extensions

| Extension                                                    | Description                                                                                                                |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| [brain](extensions/brain/)                                   | Multi-task ongoing pi sessions. Invoke with `/brain`.                                                                      |
| [git](extensions/git/)                                       | View git diffs and re-prompt the agent. Invoke with `/git`.                                                                |
| [no-sleep-while-working](extensions/no-sleep-while-working/) | Prevents your Mac from sleeping while pi is actively working on a task.                                                    |
| [pie-kumar303-config](extensions/pie-kumar303-config/)       | Extension manager for this repo. Invoke with `/pie-kumar303-config` to selectively install/remove extensions via symlinks. |

## Install

Install pie as a pi package from git:

```bash
pi install https://github.com/kumar303/pie
```

This clones the repo and loads the config extension. Then use `/pie-kumar303-config` to selectively install the other extensions.

Run `pi update` to pull the latest changes.

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
