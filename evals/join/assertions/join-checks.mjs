// Deterministic (Tier 1) checks over the structured scenario result.
//
// The provider returns the human-readable transcript as `output` and the
// structured result as `metadata`, so every check reads `context.metadata`.
// Each export is referenced from promptfooconfig.yaml as
//   value: file://assertions/join-checks.mjs:<name>

function result(context) {
  const metadata = context?.metadata ?? context?.providerResponse?.metadata;
  if (!metadata?.agents) {
    throw new Error(
      "Scenario metadata missing: the provider did not return a structured result.",
    );
  }
  return metadata;
}

function grade(pass, score, reason) {
  return { pass, score: clamp(score), reason };
}

function clamp(value) {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** website1 used join_send to deliver a message to card-tricks1. */
export function websiteSentRequest(_output, context) {
  const r = result(context);
  const w = r.agents.website;
  if (r.outcome.websiteSentRequest) {
    return grade(
      true,
      1,
      `website1 delivered a join_send to "${w.expectedTarget}" after ${w.turns.toTarget} turn(s).`,
    );
  }
  const attempts = w.toolCalls.filter(
    (call) => call.phase === "task" && call.name === "join_send",
  );
  const detail = attempts.length
    ? `join_send attempts: ${attempts.map((call) => `to="${call.to}" -> ${call.result}`).join("; ")}`
    : `no join_send call in the task phase (tool calls: ${
        w.toolCalls
          .filter((c) => c.phase === "task")
          .map((c) => c.name)
          .join(", ") || "none"
      })`;
  return grade(
    false,
    0,
    `website1 never delivered a message to "${w.expectedTarget}". ${detail}`,
  );
}

/** card-tricks1 used join_send to reply to website1 after receiving the request. */
export function cardTricksReplied(_output, context) {
  const r = result(context);
  const c = r.agents.cardTricks;
  if (!r.outcome.websiteSentRequest) {
    return grade(
      false,
      0,
      "card-tricks1 never received a request (website1 did not send one).",
    );
  }
  if (r.outcome.cardTricksReplied) {
    return grade(
      true,
      1,
      `card-tricks1 replied to "${c.expectedTarget}" with join_send after ${c.turns.toTarget} turn(s).`,
    );
  }
  const attempts = c.toolCalls.filter((call) => call.phase === "task");
  return grade(
    false,
    0,
    `card-tricks1 did not reply to "${c.expectedTarget}". Task-phase tool calls: ${
      attempts
        .map(
          (call) =>
            `${call.name}(${JSON.stringify(call.args)}) -> ${call.result}`,
        )
        .join("; ") || "none"
    }`,
  );
}

/**
 * Tool correctness: fraction of tool calls that succeeded (right tool, valid
 * arguments, known peer). Errors such as `Error: unknown peer "cart-tricks1"`
 * or calls to tools that do not exist count against the agents.
 */
export function toolUseCorrect(_output, context) {
  const r = result(context);
  const { toolCalls, toolErrors } = r.totals;
  if (toolCalls === 0)
    return grade(false, 0, "No tool calls were made at all.");
  const errors = [
    ...r.agents.website.toolCalls,
    ...r.agents.cardTricks.toolCalls,
  ]
    .filter((call) => !call.ok)
    .map(
      (call) => `${call.name}(${JSON.stringify(call.args)}) -> ${call.result}`,
    );
  const score = 1 - toolErrors / toolCalls;
  return grade(
    toolErrors === 0,
    score,
    toolErrors === 0
      ? `All ${toolCalls} tool calls succeeded.`
      : `${toolErrors}/${toolCalls} tool calls failed: ${errors.join("; ")}`,
  );
}

/**
 * Turn efficiency. Ideal is 1 turn for website1 to send the request and 1 turn
 * for card-tricks1 to reply. Score is the mean of ideal/actual for both agents;
 * an agent that never reached its target scores 0.
 */
export function turnEfficiency(_output, context) {
  const r = result(context);
  const w = r.agents.website.turns.toTarget;
  const c = r.agents.cardTricks.turns.toTarget;
  const part = (turns) => (turns ? 1 / turns : 0);
  const score = (part(w) + part(c)) / 2;
  const threshold = context?.config?.threshold ?? 0.5;
  return grade(
    score >= threshold,
    score,
    `website1 needed ${w ?? "∞"} turn(s) to send the request; card-tricks1 needed ${c ?? "∞"} turn(s) to reply. ` +
      `Total task-phase turns: website1=${r.agents.website.turns.task}, card-tricks1=${r.agents.cardTricks.turns.task}.`,
  );
}

/**
 * Chatter: join_send calls beyond the one request and the one reply (greetings
 * after /join, thank-you notes, acknowledgements). Score = 1 / (1 + extra).
 */
export function noExtraChatter(_output, context) {
  const r = result(context);
  const extra = r.totals.extraSends;
  const joinPhase =
    r.agents.website.extraSendsInJoinPhase +
    r.agents.cardTricks.extraSendsInJoinPhase;
  const score = 1 / (1 + extra);
  return grade(
    extra <= 1,
    score,
    extra === 0
      ? "Exactly one request and one reply; no extra messages."
      : `${extra} extra join_send message(s) (${joinPhase} of them were unprompted greetings during the join phase).`,
  );
}

/** The human got an answer: request, reply and a final website1 response all happened. */
export function completedCleanly(_output, context) {
  const r = result(context);
  if (r.outcome.completed) {
    return grade(
      true,
      1,
      `Request, reply and final answer all happened; scenario ended: ${r.endedReason}.`,
    );
  }
  const missing = [];
  if (!r.outcome.websiteSentRequest) missing.push("request not sent");
  if (!r.outcome.cardTricksReplied) missing.push("reply not sent");
  if (!r.outcome.websiteRespondedAfterReply)
    missing.push("website1 gave no final answer after the reply");
  return grade(
    false,
    0,
    `${missing.join("; ")} (scenario ended: ${r.endedReason})`,
  );
}
