# join

Join a message channel and collaborate with other agents.

## Usage

If you're working on something in two `pi` sessions, you can type `/join` in each one and pass messages back and forth.
Let's say you had started a sandboxed `pi` in a directory called `website`.
Maybe you want the agent to test its work in a browser but it doesn't have enough privileges.
You could start another `pi` session in a `browser` directory and join the two.
The agents will be named after their their working directories, like `website1` and `browser1`, so could say:

```
You're in a sandbox so you can't run a browser. Tell browser1 to automate a browser for you.
```

They'll figure out the rest. It's like a lightweight subagent setup -- easy to manage, easy to see what's going on.

Type `/join -help` for details.

## Security

Server connections go through a local unix domain socket (with owner-only permissions).
Sessions are never exposed to the Internet.
