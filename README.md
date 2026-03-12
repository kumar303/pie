# 🥧 pie

My daily-use extensions for [pi](https://pi.dev), a customizable coding agent that runs in your terminal.

These extensions have been incubated over time and work well for me. That said, they come with **no guarantee of support** — interfaces may change, extensions may be added or removed, and nothing here is promised to be stable.

All code is licensed under [WTFPL](LICENSE).

## Extensions

| Extension | Description |
|-----------|-------------|
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

To develop extensions locally, symlink the repo into your project's `.pi/extensions/` directory:

```bash
# From your project root
mkdir -p .pi/extensions
ln -s /path/to/pie/extensions/git .pi/extensions/git
```

Or symlink into your global extensions for use everywhere:

```bash
ln -s /path/to/pie/extensions/git ~/.pi/agent/extensions/git
```

Pi auto-discovers extensions in these locations. Use `/reload` inside pi to pick up changes without restarting.

## Contributing

Feel free to fork this repo and make it your own, or copy individual extensions into your own setup. Pull requests are welcome but there's no guarantee they'll be merged — this is a personal collection first.

## License

[WTFPL](LICENSE) — Do What The Fuck You Want To Public License.
