# no-sleep-while-working

Prevents your Mac from sleeping while pi is actively working on a task.

## How it works

When the agent starts processing, the extension spawns `caffeinate -i -d` to inhibit both idle sleep and display sleep. When the agent finishes (or the session shuts down), the `caffeinate` process is killed, allowing normal sleep behavior to resume.

The `-d` flag is included because without it, USB wired network connections can drop during display sleep.

## Requirements

- **macOS** — `caffeinate` is a built-in macOS utility.

## Events

| Event              | Action                               |
| ------------------ | ------------------------------------ |
| `agent_start`      | Spawns `caffeinate -i -d`            |
| `agent_end`        | Kills `caffeinate` process           |
| `session_shutdown` | Kills `caffeinate` process (cleanup) |
