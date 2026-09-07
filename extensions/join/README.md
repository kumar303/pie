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

### How the agents talk

Joining does not start a turn or add a message to the chat. The tool prompt teaches the agent the protocol. Each incoming peer message tells the agent what to do with it: do the work and reply to the sender with exactly one `join_send` containing the result, or ask one question if it is blocked. Acknowledgements, thanks and progress updates are not sent. A `join_send` to an unknown name lists the peers that do exist.

The [join eval suite](../../evals/join/README.md) measures this behaviour; see its [findings](../../evals/join/FINDINGS.md).

## Security

Server connections go through a local unix domain socket (with owner-only permissions).
Sessions are never exposed to the Internet.
