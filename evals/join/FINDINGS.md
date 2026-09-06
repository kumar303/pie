# Findings: peer-name discoverability (2026-09-06)

Run: 3 scenarios × 2 models × 3 repeats = 18 runs, `thinking: medium`, judge `anthropic/claude-opus-5`. Raw data: `results/latest.json`; tables: `results/report.md`.

## Answer to the question

**Yes. Generic `<dir>1` names are enough.** In 18/18 runs, `website1` sent the request to `card-tricks1` with `join_send` and `card-tricks1` replied to `website1` with `join_send`. There were **0 tool errors** in ~200 tool calls: no unknown-peer errors, no calls to nonexistent tools, no missing arguments, no agent asked the human who `card-tricks1` was.

| scenario                          | 1st-turn request (gpt / claude) | 1st-turn reply | how the name was resolved                                                                |
| --------------------------------- | ------------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `Ask card-tricks1 …`              | 67% / 100%                      | 67% / 100%     | sent directly; peer list already known from a `join_list_peers` call right after `/join` |
| `Ask cart-tricks1 …` (misspelled) | 100% / 67%                      | 100% / 100%    | both models silently corrected to `card-tricks1`; nobody tried the misspelled name       |
| `Ask the card-tricks agent …`     | 67% / 33%                       | 67% / 100%     | resolved without any extra `join_list_peers` in the task phase                           |

Where "1st-turn request" is below 100% the extra turn was not confusion about the name: it was the agent finishing or acknowledging an unrelated exchange it had started itself (see below). Every agent called `join_list_peers` exactly once, immediately after `/join`, and then remembered the list.

Judge scores (0.50–0.80, mean 0.62) are low for the same reason: the judge consistently reports "peer recognition was perfect / immediate / on the first try" and then deducts for noise.

## What the eval found instead: the agents will not stop talking

This is not a naming problem, but it dominated every transcript and is the thing to fix.

1. **Unprompted work right after `/join`.** The join notice arrives as a message that triggers a turn ("Rules: After completing a task, always reply to the message sender"). Claude treated it as a task in 9/9 runs: it greeted the peer, discovered the peer's directory contents and invented a project (adding a "card tricks" section to the magician's site), producing 2–3 substantive messages _before the human typed anything_. GPT greeted in 6/9 runs and then fell into acknowledgement ping-pong ("standing by" → "acknowledged" → 👍 → 👍), up to 14 messages. Claude was never quiet within the 30 s a "human" waited; GPT was quiet in 5/9.
2. **Post-answer ping-pong.** After the 5 tricks were delivered, the agents exchanged thank-you / you're-welcome / emoji / "no further response needed" messages. Every reply is itself a "message from a peer", and the rule says to reply to it, so the loop only ends when one model decides to break the rule. 12/18 runs had to be stopped by the 8-turn cap.
3. **Cost.** Mean extra `join_send` messages beyond the one request and one reply: GPT 5–17, Claude 11–12 per run. Token use per run ranged from 35k (GPT, quiet join) to 264k (Claude, invented project).

## Recommendations

Naming needs no change for these two models. If anything, the names could be made more prominent for weaker models, but there is no evidence of a problem here. Spend the effort on the instructions instead:

- Do not trigger a turn on join, or make the join notice explicitly say "This is not a task. Do nothing until a human or a peer asks you for something."
- Replace "After completing a task, always reply to the message sender" with a terminating rule: reply once with the result; do not acknowledge acknowledgements; do not send thanks, emoji or status updates.
- Tell the agent its own name once in the notice (already done) and that peers are named `<directory>N`; that was enough for both models.
- Re-run this suite after changing the instructions: the `chatter`, `join-phase msgs` and `ended by cap` columns are the ones that should move; `request_sent`, `reply_sent` and `tool_correctness` should stay at 100%.

## Harness notes

- The join extension's Unix socket path lives under `JOIN_PI_HOME`. With macOS's long `os.tmpdir()` the path exceeded the ~104-byte socket limit and `/join` failed with `ENOENT … chmod …sock` after Node silently truncated the path. The sandbox now uses `/tmp`; the extension could fall back to a shorter path or report the error clearly.
- `request` in the summary is the first successful task-phase `join_send` to the peer. When the agents were mid-conversation it is occasionally a leftover message ("Agreed. Paused.") rather than the real request. The judge reads the full transcript, so scores are unaffected, but treat that column as a hint.
- Judge scores cluster in 0.5–0.8 because the rubric's noise penalties dominate once the exchange is correct. If you want the judge to isolate naming, add a separate `llm-rubric` with a rubric that ignores noise.
