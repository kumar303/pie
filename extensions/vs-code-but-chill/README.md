# vs-code-but-chill

**VS Code, but chill: stop language servers from eating too much memory.**

A pi extension that runs a tiny background server to watch VS Code's
`tsserver.js` and `eslintServer.js` processes and restart oversized
ones. Designed for macOS.

## Why

VS Code's TypeScript and ESLint servers leak memory over long
sessions and eventually crash or lag. This extension preempts that by
restarting them before they get too large (tsserver typically caps at
`--max-old-space-size=3072`; ESLint at 4096).

If you're still having trouble, use
[kumar303/debug-memory-leak](https://github.com/kumar303/debug-memory-leak)
to identify what else is leaking.

## How it works

- A background server (spawned via pi's bundled `jiti`) polls every
  20 minutes.
- It uses `ps` to find `tsserver.js` and `eslintServer.js` processes
  launched under a `*Helper (Plugin)` parent (VS Code / Cursor), then
  kills them when **all** of the following hold:
  - RSS is over threshold (tsserver full: 2500 MB, tsserver partial:
    800 MB, eslint: 1500 MB)
  - Process has been running ≥ 5 minutes
  - RSS is confirmed growing (flat or up) across two consecutive ticks
  - No workspace files have been modified in the last 30 seconds
  - Circuit breaker: ≤ 3 kills per workspace per hour
- Workspace identity:
  - tsserver → hash from `--cancellationPipeName tscancellation-<hash>`
  - eslint → `eslint:<clientProcessId>` (the VS Code window pid)
- Killed processes get a graceful `SIGTERM` (3s grace) then `SIGKILL`.
  VS Code reconnects automatically.

## Commands

| Command                   | Description                       |
| ------------------------- | --------------------------------- |
| `/vs-code-but-chill`      | Show help                         |
| `/vs-code-but-chill help` | Show help                         |
| `/vs-code-but-chill logs` | Open the log viewer (follow mode) |
| `/vs-code-but-chill stop` | Stop the background server        |

## Log viewer keys

- `↑` / `↓` — scroll one line (pauses follow mode on `↑`)
- `g` — jump to top (pauses follow)
- `G` — jump to bottom (resumes follow)
- `q` / Esc — close

## Configuration (env vars)

| Var                 | Default   | Meaning                                |
| ------------------- | --------- | -------------------------------------- |
| `VSCBC_FULL_MB`     | `2500`    | Full-semantic tsserver RSS threshold   |
| `VSCBC_PARTIAL_MB`  | `800`     | partialSemantic tsserver RSS threshold |
| `VSCBC_ESLINT_MB`   | `1500`    | eslintServer RSS threshold             |
| `VSCBC_TICK_MS`     | `1200000` | Scan interval (ms)                     |
| `VSCBC_MIN_ETIME_S` | `300`     | Minimum process age before killing (s) |

## Files

Everything lives under `~/.cache/vs-code-but-chill_pi/`:

- `server.pid` — server PID
- `server.sock` — Unix domain socket
- `server.log` — rolling log (rotated at 5 MB)
- `clients.json` — pi client refcount

## Platform

macOS only for now. Relies on `ps`, `lsof`, and POSIX signals.

## License

[WTFPL](../../LICENSE)
