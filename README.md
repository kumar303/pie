# 🥧 pie

```
pie[xtensions, agents, skills, and stuff]
```

My daily-use extensions for [pi](https://pi.dev), a customizable coding agent that runs in your terminal.

These extensions have been incubated over time and work well for me. That said, they come with **no guarantee of support** — interfaces may change, extensions may be added or removed, and nothing here is promised to be stable.

All code is licensed under [WTFPL](LICENSE).

## Extensions

| Extension              | Description                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [git](extensions/git/) | Interactive git file selector and command runner. Invoke with `/git`. Navigate files, select with tab, run commands with `{}` placeholder expansion, generate commit messages with AI, view diffs in a split pane. |

## Install

Install pie as a pi package from git:

```bash
pi install https://github.com/kumar303/pie
```

This clones the repo and loads all extensions automatically.

### Managing extensions

After installing, use `pi config` to enable or disable individual extensions. Run `pi update` to pull the latest changes.

## Development

The `.pi/extensions/` directory contains symlinks to each extension in `extensions/`, so running pi from this repo automatically loads them for development. Use `/reload` inside pi to pick up changes without restarting.

When adding a new extension, create a matching symlink:

```bash
ln -s "../../extensions/<name>" ".pi/extensions/<name>"
```

## Contributing

Feel free to fork this repo and make it your own, or copy individual extensions into your own setup. Pull requests are welcome but there's no guarantee they'll be merged — this is a personal collection first.

## License

[WTFPL](LICENSE) — Do What The Fuck You Want To Public License.
