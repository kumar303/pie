# vs-code-but-chill

**VS Code, but chill: stop TypeScript servers from eating too much memory.**

A pi extension that runs a tiny background server to watch `tsserver.js`
processes and restart oversized ones. Designed for macOS.

## Why

VS Code's TypeScript servers leak memory over long sessions and
eventually crash with heap-out-of-memory. This extension preempts that
by restarting them before they hit the `--max-old-space-size=3072` cap.

## How it works

- A background server (spawned via pi's bundled `jiti`) polls every
  20 minutes.
- It uses `ps` to find `tsserver.js` processes, classifies them as
  `full` or `partialSemantic`, and kills them when **all** of the
  following hold:
  - RSS is over threshold (full: 2500 MB, partial: 800 MB)
  - Process has been running ≥ 5 minutes
  - RSS is confirmed growing (flat or up) across two consecutive ticks
  - No workspace files have been modified in the last 30 seconds
  - Circuit breaker: ≤ 3 kills per workspace per hour
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
