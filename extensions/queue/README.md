# /queue

Send your agent a list of prompts after it's finished working.

## Usage

```
/queue <key>         Run the prompt queue saved under <key>
/queue :abort        Cancel an in-progress queue
/queue :delete <key> Delete a saved queue (creates a backup snapshot)
```

On first run, it creates a default queue called `review-and-fix` with some code review instructions.

## Code review example

Let's say you just gave your agent a big task. You could run `/queue review-and-fix` which will wait for the agent to finish and then give it a list of things to double check. One of them might be _Did you use TDD? Really? I don't think so. Use the break/fix strategy to validate your tests_. Another could be _Did you check for type errors, lint, and formatting errors? Really? I don't think so. Try again_. It's just a queue of prompts to do whatever.

## Interactive prompt editor

Before the queue runs, you can customize each prompt, delete the ones you don't need or add new ones. Pressing enter queues all the prompts. By default, any changes will only apply to your current session but you can press `S` to update the saved queue.
