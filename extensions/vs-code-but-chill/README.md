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

## Single-server guarantee

Only one `vs-code-but-chill` server is supposed to be running per
data directory. Two guards enforce it:

1. The pid file is acquired with `O_EXCL` so concurrent acquirers
   can't both "win" (see `Registry.tryAcquirePid`).
2. The server hard-kills any sibling `vs-code-but-chill` servers
   running in _other_ dataDirs at startup, before binding its
   socket. This catches historical orphans (e.g. left over from a
   graceless shutdown) without polling on every tick.

If you ever need to kill everything by hand:

    pkill -f 'vs-code-but-chill/server/main\.ts'

## Files

Logs and other ephemeral files are written to `~/.cache/vs-code-but-chill_pi/`.

## Platform

macOS only. Relies on `/usr/bin/pgrep`, `/usr/sbin/lsof`, and POSIX
signals — all unprivileged.

## Troubleshooting

General VS Code tips.

- Close unused windows. Each one runs a language server (when a language is detected) and its renderer process uses 230–370 MB.
- Disable GitHub Co-Pilot. This baloons the size of each language server process.
- Disable GitLens (if you have it) or tame its use of `git for-each-ref` with these settings:

  ```
  "gitlens.advanced.repositorySearchDepth": 1,
  "git.branchSortOrder": "alphabetically",
  ```

  This might only be a problem for large monorepos.

If you're still having trouble, use
[kumar303/debug-memory-leak](https://github.com/kumar303/debug-memory-leak)
to identify what else is leaking.

## Alternatives

### TS/ESLint Restarter

- [Marketplace](https://marketplace.visualstudio.com/items?itemName=kokororin.ts-eslint-restarter&ssr=false#overview)
- [Source](https://github.com/kokororin/vscode-ts-eslint-restarter)

**Verdict: not a reliable replacement.** Despite the name, its automatic
memory-based restart only covers the ESLint server — the TypeScript server is
only restartable manually via a Quick Pick. It also polls every 30 seconds,
has no cooldown / circuit breaker, and only reads RSS for a single pid (so
worker-child memory is invisible).

<details>
<summary>Only ESLint is auto-monitored.</summary>

`checkEslintServer()` searches for `dbaeumer.vscode-eslint` in process
command lines and restarts only that server. There is no equivalent watcher
for `tsserver.js`, which is usually the worse memory offender in large TS
monorepos.

</details>

<details>
<summary>Aggressive 30s cron.</summary>

Uses `*/30 * * * * *`, and each tick runs `getProcesses()` (full system `ps`
enumeration), `pidtree()` over the extension host, and `pidusage()`. Compare
to `vs-code-but-chill`'s 20-minute tick.

</details>

<details>
<summary>No circuit breaker.</summary>

After `SIGKILL`, the next tick is 30s away; a server that climbs quickly
(e.g. initial indexing on a big repo) can be killed repeatedly with no
per-workspace rate limit.

</details>

<details>
<summary>Hard SIGKILL with no grace.</summary>

No `SIGTERM` first, no grace period — in-flight requests and cached state
are dropped instantly.

</details>

<details>
<summary>Memory undercounts child workers.</summary>

`pidusage(eslintPid)` reports RSS for one pid only; any worker children the
eslint server spawns are not summed, so a process tree over the threshold
can read as under it.

</details>

<details>
<summary>Single-eslint assumption.</summary>

`processes.find(...)` returns only the first match; multi-root or
multi-eslint setups are not fully handled.

</details>

<details>
<summary>Silent detection misses.</summary>

Relies on a substring match of the extension id in the command line with no
fallback (e.g. `eslintServer.js` filename). If spawn paths change or a
pre-release build is used, monitoring silently no-ops.

</details>

<details>
<summary>Heavier deps.</summary>

Pulls in `cron`, `luxon`, `pidtree`, `pidusage`, `getprocesses`, `winston`,
and `winston-transport-vscode` for what is essentially a `setInterval` + a
`ps` read.

</details>

Good as a manual restart button with a safety net for ESLint. Not sufficient
if you want automatic memory reclamation across both language servers.

## License

[WTFPL](../../LICENSE)
