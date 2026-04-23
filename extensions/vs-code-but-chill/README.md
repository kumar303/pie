# vs-code-but-chill

Stop language servers from eating too much memory.

A pi extension that runs a tiny background server to watch VS Code's
`tsserver.js` and `eslintServer.js` processes and kill the ones
attached to idle workspaces so they get respawned fresh. Designed
for macOS.

## Why

VS Code's TypeScript and ESLint servers leak memory over long
sessions and eventually crash or lag. This extension preempts that
by killing servers attached to **idle workspaces** — projects you
haven't edited in a while. Killing them is safe: VS Code
transparently respawns a fresh language server the next time you
open or edit a file in that workspace, so you'll never notice
except for the memory it frees up. Active workspaces are left
alone.

If you're still having trouble, use
[kumar303/debug-memory-leak](https://github.com/kumar303/debug-memory-leak)
to identify what else is leaking.

## How it works

- A background server (spawned via pi's bundled `jiti`) polls every
  20 minutes.
- It uses `pgrep` to enumerate `tsserver.js` and `eslintServer.js`
  processes, resolves each one's workspace via `lsof`, and kills any
  whose workspace directory hasn't been modified recently:
  - Workspace directory mtime is older than `VSCBC_IDLE_MS` (default
    60 minutes) — i.e. no file has been created/deleted/renamed
    there, which is a reliable proxy for "no one is editing here".
  - Process has been observed for at least `VSCBC_MIN_AGE_MS`
    (default 5 minutes) — avoids killing a server right after it
    starts up.
  - Workspace could be resolved. If `lsof` can't pin a process to a
    directory under `$HOME`, we leave it alone.
  - Circuit breaker: ≤ 3 kills per workspace per hour.
- Workspace identity for kill bookkeeping:
  - tsserver → hash from `--cancellationPipeName tscancellation-<hash>`
  - eslint → `eslint:<clientProcessId>` (the VS Code window pid)
- Killed processes get a graceful `SIGTERM` (3s grace) then `SIGKILL`.
  VS Code respawns them on demand.

Why not use RSS thresholds? Because `/bin/ps` (and everything else
that reads per-pid RSS) is setuid root on macOS, and the sandbox pi
runs under rejects the exec. `pgrep` is unprivileged and works — but
it doesn't expose RSS. Killing idle servers instead of oversized
ones reaches the same goal (free memory, fresh server state) without
needing privileged syscalls.

## Commands

| Command                    | Description                       |
| -------------------------- | --------------------------------- |
| `/vs-code-but-chill`       | Show help                         |
| `/vs-code-but-chill help`  | Show help                         |
| `/vs-code-but-chill start` | (Re)start the background server   |
| `/vs-code-but-chill reap`  | Run one scan immediately          |
| `/vs-code-but-chill logs`  | Open the log viewer (follow mode) |
| `/vs-code-but-chill stop`  | Stop the background server        |

## Configuration (env vars)

| Var                | Default            | Meaning                                   |
| ------------------ | ------------------ | ----------------------------------------- |
| `VSCBC_TICK_MS`    | `1200000` (20 min) | Scan interval (ms)                        |
| `VSCBC_MIN_AGE_MS` | `300000` (5 min)   | Minimum time since first-seen before kill |
| `VSCBC_IDLE_MS`    | `3600000` (60 min) | Workspace idle threshold (ms since mtime) |

## Files

Logs and other ephemeral files are written to `~/.cache/vs-code-but-chill_pi/`.

## Platform

macOS only. Relies on `/usr/bin/pgrep`, `/usr/sbin/lsof`, and POSIX
signals — all unprivileged.

## License

[WTFPL](../../LICENSE)
