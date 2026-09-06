// promptfoo provider: runs the two-agent "join" scenario.
//
// For each call it:
//   1. creates a temp sandbox with `website/` and `card-tricks/` (copied from fixtures)
//      and an isolated JOIN_PI_HOME so the eval never touches real join channels;
//   2. starts one locked-down `pi --mode rpc` per directory (join tools only);
//   3. seeds each agent's system prompt with its directory contents;
//   4. runs `/join` in both, waits for both to go quiet;
//   5. sends the eval prompt to the website agent and records everything until
//      both agents are quiet, a turn cap is hit, or the wall-clock limit passes;
//   6. tears the sandbox down (processes + directories) atomically.
//
// Output: a human-readable transcript (string) for the judge and the web UI.
// Metadata: the structured result used by the deterministic assertions.
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extensionArgs,
  lockdownArgs,
  piBin,
  REPO_ROOT,
  resolveModel,
  resolveThinking,
  validateModel,
} from "../../lib/pi-cli.mjs";
import { PiRpcSession } from "../../lib/pi-rpc.mjs";
import { Sandbox } from "../../lib/sandbox.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "..", "fixtures");
const JOIN_EXTENSION = join(REPO_ROOT, "extensions", "join");

const AGENTS = {
  website: { dir: "website", joinName: "website1" },
  cardTricks: { dir: "card-tricks", joinName: "card-tricks1" },
};

const DEFAULT_CONFIG = {
  modelSlot: "A", // "A" | "B" | "judge"; or set `model` directly
  thinking: undefined, // defaults to PI_EVAL_THINKING / medium
  maxTurns: 6, // per agent, counted from the task prompt
  bootTimeoutMs: 90_000,
  joinTimeoutMs: 120_000, // for each /join to settle
  joinQuietTimeoutMs: 10_000, // how long a "human" waits for both agents to go quiet before typing the task
  taskTimeoutMs: 240_000,
  promptStartTimeoutMs: 60_000, // website1 must begin a run within this long after the task prompt
  quietMs: 4_000, // both agents idle for this long => scenario over
};

const validatedModels = new Map();

export default class JoinPairProvider {
  constructor(options = {}) {
    this.providerId = options.id ?? "pi-join-pair";
    this.config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
    this.model = this.config.model || resolveModel(this.config.modelSlot);
    this.thinking = this.config.thinking || resolveThinking();
    this.providerLabel = options.label ?? this.model;
  }

  id() {
    return this.providerId;
  }

  toString() {
    return `[JoinPairProvider ${this.model}]`;
  }

  async callApi(prompt, context = {}) {
    const startedAt = Date.now();
    const vars = context.vars ?? {};
    try {
      await this.#ensureModelValid();
      const result = await runScenario({
        prompt,
        model: this.model,
        thinking: this.thinking,
        config: this.config,
        vars,
        logger: context.logger,
      });
      const metadata = {
        ...result,
        model: this.model,
        thinking: this.thinking,
        durationMs: Date.now() - startedAt,
      };
      return {
        output: renderOutput(metadata),
        metadata,
        tokenUsage: result.tokenUsage,
      };
    } catch (error) {
      return {
        error: `${error.name ?? "Error"}: ${error.message}${error.detail ? `\n${error.detail}` : ""}`,
      };
    }
  }

  async #ensureModelValid() {
    if (!validatedModels.has(this.model)) {
      validatedModels.set(this.model, validateModel(this.model));
    }
    const check = await validatedModels.get(this.model);
    if (!check.ok) {
      throw new Error(
        `Model "${this.model}" is not available to pi: ${check.error}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario

async function runScenario({ prompt, model, thinking, config, logger }) {
  // Short prefix: the join socket path must stay under the OS socket path limit.
  const sandbox = new Sandbox("pje");
  const sessions = {};
  const log = (message) => logger?.debug?.(`[join-pair] ${message}`);

  try {
    const dirs = {};
    for (const [key, agent] of Object.entries(AGENTS)) {
      dirs[key] = sandbox.path(agent.dir);
      mkdirSync(dirs[key]);
      cpSync(join(FIXTURES, agent.dir), dirs[key], { recursive: true });
      writeFileSync(sandbox.path(`${agent.dir}.seed.md`), buildSeed(dirs[key]));
    }
    const joinHome = sandbox.path("join-home");
    mkdirSync(joinHome, { mode: 0o700 });

    const env = {
      ...process.env,
      JOIN_PI_HOME: joinHome,
      // Keep pi from touching real session storage even if a flag is missed.
      PI_CODING_AGENT_SESSION_DIR: sandbox.path("sessions"),
    };

    const timeline = []; // merged, cross-agent event log
    for (const [key, agent] of Object.entries(AGENTS)) {
      const args = [
        ...lockdownArgs(),
        ...extensionArgs([JOIN_EXTENSION]),
        "--no-builtin-tools",
        "--tools",
        "join_send,join_list_peers",
        "--model",
        model,
        "--thinking",
        thinking,
        "--append-system-prompt",
        sandbox.path(`${agent.dir}.seed.md`),
      ];
      const session = new PiRpcSession({
        name: agent.joinName,
        cwd: dirs[key],
        args,
        env,
        piBin: piBin(),
        onEvent: (event) => {
          if (event.type === "message_update") return;
          timeline.push({ agent: agent.joinName, ts: Date.now(), event });
          if (process.env.PI_EVAL_DEBUG_EVENTS) {
            process.stderr.write(
              `[${agent.joinName}] ${JSON.stringify(event).slice(0, 400)}\n`,
            );
          }
        },
      });
      sandbox.track(session.child);
      sessions[key] = session;
    }

    // 1. Boot: make sure both processes answer RPC before we do anything else.
    await Promise.all(
      Object.values(sessions).map((session) =>
        withTimeout(
          session.send({ type: "get_state" }),
          config.bootTimeoutMs,
          `${session.name} boot`,
        ).catch((error) => {
          error.detail = `stderr:\n${session.stderr}`;
          throw error;
        }),
      ),
    );
    log("both agents booted");

    // 2. Join. card-tricks first so it is already a peer when website joins.
    const phaseMarks = { joinStart: Date.now() };
    for (const key of ["cardTricks", "website"]) {
      const session = sessions[key];
      const from = session.nextSeq();
      await session.prompt("/join");
      const isErrorNotify = (event) =>
        event.type === "extension_ui_request" &&
        event.method === "notify" &&
        event.notifyType === "error";
      // The join notice may or may not start an agent run. Treat the notice
      // landing in the session as "joined"; whether the agent then acts on it
      // is measured by the quiet wait below.
      const isJoinNotice = (event) =>
        event.type === "message_end" &&
        event.message?.customType === "join-instructions";
      const outcome = await Promise.race([
        session.waitFor(
          (event) => isJoinNotice(event) || event.type === "agent_settled",
          {
            timeoutMs: config.joinTimeoutMs,
            fromSeq: from,
            label: "/join to settle",
          },
        ),
        session
          .waitFor(isErrorNotify, {
            timeoutMs: config.joinTimeoutMs,
            fromSeq: from,
            label: "join error",
          })
          .catch(() => undefined),
      ]);
      if (outcome && isErrorNotify(outcome)) {
        throw new Error(
          `${session.name}: /join reported an error: ${outcome.message}`,
        );
      }
    }
    // Agents sometimes start talking to each other right after /join. A human
    // would type the task after a short pause regardless, so wait a bounded time.
    const joinPhaseQuiet = await waitForQuiet(
      Object.values(sessions),
      config.quietMs,
      config.joinQuietTimeoutMs,
    );
    phaseMarks.taskStart = Date.now();
    log(`joined (quiet: ${joinPhaseQuiet}); sending task prompt`);

    // 3. Task. "steer" delivers the prompt even if website1 is mid-run.
    const website = sessions.website;
    const cardTricks = sessions.cardTricks;
    const websiteWasRunning = isRunning(website);
    await website.prompt(prompt, { streamingBehavior: "steer" });
    const endedReason = await runTaskPhase({
      sessions: { website, cardTricks },
      timeline,
      taskStart: phaseMarks.taskStart,
      websiteWasRunning,
      config,
    });
    phaseMarks.taskEnd = Date.now();
    log(`task phase ended: ${endedReason}`);

    // Give in-flight tool results a moment to land in the timeline, then stop everything.
    await sleep(500);
    await Promise.all(
      Object.values(sessions).map((session) => session.abort()),
    );

    return analyze({
      timeline,
      phaseMarks,
      endedReason,
      prompt,
      sessions,
      joinPhaseQuiet,
    });
  } finally {
    await sandbox.teardown(() =>
      Promise.all(Object.values(sessions).map((session) => session.close())),
    );
  }
}

async function runTaskPhase({
  sessions,
  timeline,
  taskStart,
  websiteWasRunning,
  config,
}) {
  const deadline = taskStart + config.taskTimeoutMs;
  const names = Object.values(sessions).map((session) => session.name);
  const turnsInTask = (name) =>
    timeline.filter(
      (entry) =>
        entry.agent === name &&
        entry.ts >= taskStart &&
        entry.event.type === "turn_end",
    ).length;

  // The prompt is delivered asynchronously; do not call the scenario quiet
  // before website1 has actually started working on it.
  const websiteStarted = () =>
    websiteWasRunning ||
    timeline.some(
      (entry) =>
        entry.agent === sessions.website.name &&
        entry.ts >= taskStart &&
        entry.event.type === "agent_start",
    );

  while (Date.now() < deadline) {
    for (const [key, session] of Object.entries(sessions)) {
      if (turnsInTask(session.name) >= config.maxTurns && isRunning(session)) {
        await session.abort();
        return `turn_cap:${key}`;
      }
    }
    if (!websiteStarted()) {
      if (Date.now() - taskStart > config.promptStartTimeoutMs)
        return "prompt_never_started";
    } else if (allQuiet(Object.values(sessions), config.quietMs)) {
      return "quiescent";
    }
    if (Object.values(sessions).some((session) => session.exited))
      return "process_exited";
    await sleep(250);
  }
  return `timeout:${names.join(",")}`;
}

// ---------------------------------------------------------------------------
// Session helpers

function isRunning(session) {
  let running = false;
  for (const event of session.events) {
    if (event.type === "agent_start") running = true;
    else if (event.type === "agent_settled") running = false;
  }
  return running;
}

function lastActivity(session) {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    if (session.events[index].type !== "message_update")
      return session.startedAt + session.events[index].at;
  }
  return session.startedAt;
}

function allQuiet(sessions, quietMs) {
  const now = Date.now();
  return sessions.every(
    (session) => !isRunning(session) && now - lastActivity(session) >= quietMs,
  );
}

/** Resolve true once all sessions are quiet, or false when the timeout passes first. */
async function waitForQuiet(sessions, quietMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (allQuiet(sessions, quietMs)) return true;
    await sleep(250);
  }
  return false;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${ms}ms: ${label}`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Seeding

function buildSeed(dir) {
  const files = listFiles(dir);
  const sections = files.map((file) => {
    const rel = relative(dir, file);
    const ext = rel.split(".").pop();
    return `### ${rel}\n\n\`\`\`${ext}\n${readFileSync(file, "utf8").trimEnd()}\n\`\`\``;
  });
  return [
    "## Working directory",
    "",
    `Your working directory is \`${dir}\`.`,
    "In this session you have no file, shell, or editing tools, so the full contents of the directory are reproduced below for reference.",
    "",
    ...sections,
    "",
  ].join("\n");
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Analysis

function analyze({
  timeline,
  phaseMarks,
  endedReason,
  prompt,
  sessions,
  joinPhaseQuiet,
}) {
  const sorted = [...timeline].sort((a, b) => a.ts - b.ts || 0);
  const expected = {
    website: { target: AGENTS.cardTricks.joinName },
    cardTricks: { target: AGENTS.website.joinName },
  };

  const perAgent = {};
  for (const [key, agent] of Object.entries(AGENTS)) {
    const own = sorted.filter((entry) => entry.agent === agent.joinName);
    const toolCalls = collectToolCalls(own, phaseMarks.taskStart);
    const joinTurns = own.filter(
      (entry) =>
        entry.ts < phaseMarks.taskStart && entry.event.type === "turn_end",
    ).length;
    const taskTurns = own.filter(
      (entry) =>
        entry.ts >= phaseMarks.taskStart && entry.event.type === "turn_end",
    ).length;

    // Turns (in the task phase) until this agent's first successful join_send to its expected target.
    let turnsToTarget;
    let turnCount = 0;
    let sawWork = false;
    for (const entry of own) {
      if (entry.ts < phaseMarks.taskStart) continue;
      if (entry.event.type === "turn_end") turnCount += 1;
      if (entry.event.type === "tool_execution_end") {
        sawWork = true;
        if (
          isSuccessfulSend(entry.event, expected[key].target) &&
          turnsToTarget === undefined
        ) {
          turnsToTarget = turnCount + 1;
        }
      }
    }

    const sendsToTarget = toolCalls.filter(
      (call) =>
        call.phase === "task" &&
        call.ok &&
        call.name === "join_send" &&
        call.to === expected[key].target,
    );
    const extraSends = toolCalls.filter(
      (call) =>
        call.name === "join_send" &&
        call.ok &&
        !(sendsToTarget[0] && call.id === sendsToTarget[0].id),
    );
    const receivedMessages = own
      .filter(
        (entry) =>
          entry.event.type === "message_end" &&
          entry.event.message?.customType === "join-message",
      )
      .map((entry) => ({
        ts: entry.ts,
        phase: entry.ts < phaseMarks.taskStart ? "join" : "task",
        text: entry.event.message.content,
      }));

    perAgent[key] = {
      name: agent.joinName,
      expectedTarget: expected[key].target,
      turns: {
        join: joinTurns,
        task: taskTurns,
        toTarget: turnsToTarget ?? null,
      },
      toolCalls,
      toolErrors: toolCalls.filter((call) => !call.ok).length,
      sentToTarget: sendsToTarget.length > 0,
      extraSends: extraSends.length,
      extraSendsInJoinPhase: extraSends.filter((call) => call.phase === "join")
        .length,
      receivedMessages: receivedMessages.length,
      sawWork,
      stderrTail: sessions[key]?.stderr.slice(-2000) ?? "",
    };
  }

  const websiteRequest = perAgent.website.toolCalls.find(
    (call) =>
      call.phase === "task" &&
      call.ok &&
      call.name === "join_send" &&
      call.to === expected.website.target,
  );
  const cardTricksReply = perAgent.cardTricks.toolCalls.find(
    (call) =>
      call.phase === "task" &&
      call.ok &&
      call.name === "join_send" &&
      call.to === expected.cardTricks.target &&
      (!websiteRequest || call.ts > websiteRequest.ts),
  );
  const websiteFinalText = cardTricksReply
    ? lastAssistantText(sorted, AGENTS.website.joinName, cardTricksReply.ts)
    : undefined;

  return {
    prompt,
    endedReason,
    joinPhaseQuiet,
    outcome: {
      websiteSentRequest: Boolean(websiteRequest),
      cardTricksReplied: Boolean(cardTricksReply),
      websiteRespondedAfterReply: Boolean(websiteFinalText),
      completed: Boolean(websiteRequest && cardTricksReply && websiteFinalText),
    },
    request: websiteRequest
      ? { to: websiteRequest.to, text: websiteRequest.text }
      : null,
    reply: cardTricksReply
      ? { to: cardTricksReply.to, text: cardTricksReply.text }
      : null,
    websiteFinalText: websiteFinalText ?? null,
    agents: perAgent,
    totals: {
      toolCalls:
        perAgent.website.toolCalls.length +
        perAgent.cardTricks.toolCalls.length,
      toolErrors: perAgent.website.toolErrors + perAgent.cardTricks.toolErrors,
      extraSends: perAgent.website.extraSends + perAgent.cardTricks.extraSends,
      taskTurns: perAgent.website.turns.task + perAgent.cardTricks.turns.task,
    },
    timings: {
      joinPhaseMs: phaseMarks.taskStart - phaseMarks.joinStart,
      taskPhaseMs: phaseMarks.taskEnd - phaseMarks.taskStart,
    },
    tokenUsage: sumUsage(sorted),
    transcript: renderTranscript(sorted, phaseMarks),
  };
}

function collectToolCalls(entries, taskStart) {
  const calls = [];
  for (const entry of entries) {
    const event = entry.event;
    if (event.type !== "tool_execution_end") continue;
    const start = entries.find(
      (candidate) =>
        candidate.event.type === "tool_execution_start" &&
        candidate.event.toolCallId === event.toolCallId,
    );
    const args = start?.event.args ?? {};
    const resultText = textOf(event.result?.content);
    const failed =
      Boolean(event.isError) || /^Error:|failed:/i.test(resultText);
    calls.push({
      id: event.toolCallId,
      ts: entry.ts,
      phase: entry.ts < taskStart ? "join" : "task",
      name: event.toolName,
      to:
        typeof args.to === "string" ? args.to.trim().toLowerCase() : undefined,
      text: typeof args.text === "string" ? args.text : undefined,
      args,
      result: resultText,
      ok: !failed,
    });
  }
  return calls;
}

function isSuccessfulSend(event, target) {
  if (
    event.type !== "tool_execution_end" ||
    event.toolName !== "join_send" ||
    event.isError
  )
    return false;
  const text = textOf(event.result?.content);
  return (
    text.startsWith("Delivered message to") && text.includes(`"${target}"`)
  );
}

function lastAssistantText(sorted, agentName, afterTs) {
  let last;
  for (const entry of sorted) {
    if (
      entry.agent !== agentName ||
      entry.ts <= afterTs ||
      entry.event.type !== "message_end"
    )
      continue;
    const message = entry.event.message;
    if (message?.role !== "assistant") continue;
    const text = (message.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) last = text;
  }
  return last;
}

function sumUsage(sorted) {
  const usage = { total: 0, prompt: 0, completion: 0, cached: 0 };
  for (const entry of sorted) {
    if (
      entry.event.type !== "message_end" ||
      entry.event.message?.role !== "assistant"
    )
      continue;
    const u = entry.event.message.usage;
    if (!u) continue;
    usage.prompt += u.input ?? 0;
    usage.completion += u.output ?? 0;
    usage.cached += u.cacheRead ?? 0;
    usage.total += u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0);
  }
  return usage;
}

function textOf(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Rendering

function renderTranscript(sorted, phaseMarks) {
  const lines = [];
  const t0 = phaseMarks.joinStart;
  const stamp = (ts) => `+${((ts - t0) / 1000).toFixed(1).padStart(6)}s`;
  let phase = "join";
  lines.push("=== JOIN PHASE (both agents run /join; no task yet) ===");
  const turnCounters = {};
  for (const entry of sorted) {
    if (phase === "join" && entry.ts >= phaseMarks.taskStart) {
      phase = "task";
      lines.push("", "=== TASK PHASE (user prompt sent to website1) ===");
    }
    const { agent, event } = entry;
    switch (event.type) {
      case "turn_start": {
        turnCounters[agent] = (turnCounters[agent] ?? 0) + 1;
        lines.push(
          `${stamp(entry.ts)} ${agent} — turn ${turnCounters[agent]} begins`,
        );
        break;
      }
      case "message_end": {
        const message = event.message ?? {};
        if (message.role === "user") {
          lines.push(
            `${stamp(entry.ts)} ${agent} <- USER: ${oneLine(textOf(message.content) || String(message.content ?? ""))}`,
          );
        } else if (message.role === "custom") {
          lines.push(
            `${stamp(entry.ts)} ${agent} <- ${message.customType ?? "system"}: ${indent(String(message.content ?? ""))}`,
          );
        } else if (message.role === "assistant") {
          for (const part of message.content ?? []) {
            if (part.type === "text" && part.text.trim()) {
              lines.push(
                `${stamp(entry.ts)} ${agent} says: ${indent(part.text.trim())}`,
              );
            } else if (part.type === "toolCall") {
              lines.push(
                `${stamp(entry.ts)} ${agent} calls ${part.name}(${JSON.stringify(part.arguments ?? {})})`,
              );
            }
          }
          if (message.stopReason === "error") {
            lines.push(
              `${stamp(entry.ts)} ${agent} !! model error: ${oneLine(message.errorMessage ?? "unknown")}`,
            );
          }
        }
        break;
      }
      case "tool_execution_end": {
        const text = textOf(event.result?.content);
        lines.push(
          `${stamp(entry.ts)} ${agent} <- ${event.toolName} result${event.isError ? " (ERROR)" : ""}: ${oneLine(text)}`,
        );
        break;
      }
      case "agent_settled":
        lines.push(`${stamp(entry.ts)} ${agent} — idle`);
        break;
      case "extension_error":
        lines.push(
          `${stamp(entry.ts)} ${agent} !! extension error: ${oneLine(JSON.stringify(event))}`,
        );
        break;
      default:
        break;
    }
  }
  return lines.join("\n");
}

function renderOutput(result) {
  const a = result.agents;
  const summary = [
    "=== SUMMARY ===",
    `model: ${result.model} (thinking: ${result.thinking})`,
    `prompt to website1: ${JSON.stringify(result.prompt)}`,
    `agents quiet before the task was typed: ${result.joinPhaseQuiet} (join-phase join_send messages: ${a.website.extraSendsInJoinPhase + a.cardTricks.extraSendsInJoinPhase})`,
    `ended: ${result.endedReason}`,
    `website1 sent request to ${a.website.expectedTarget}: ${result.outcome.websiteSentRequest}` +
      (result.request
        ? ` — ${JSON.stringify(oneLine(result.request.text, 160))}`
        : ""),
    `card-tricks1 replied to ${a.cardTricks.expectedTarget}: ${result.outcome.cardTricksReplied}` +
      (result.reply
        ? ` — ${JSON.stringify(oneLine(result.reply.text, 160))}`
        : ""),
    `website1 responded to user after reply: ${result.outcome.websiteRespondedAfterReply}`,
    `turns — website1: join=${a.website.turns.join} task=${a.website.turns.task} (to request: ${a.website.turns.toTarget ?? "never"}); ` +
      `card-tricks1: join=${a.cardTricks.turns.join} task=${a.cardTricks.turns.task} (to reply: ${a.cardTricks.turns.toTarget ?? "never"})`,
    `tool calls: ${result.totals.toolCalls} (errors: ${result.totals.toolErrors}); extra join_send messages beyond request+reply: ${result.totals.extraSends}`,
    `duration: join ${(result.timings.joinPhaseMs / 1000).toFixed(1)}s, task ${(result.timings.taskPhaseMs / 1000).toFixed(1)}s`,
    "",
    "=== TRANSCRIPT ===",
    result.transcript,
  ];
  return summary.join("\n");
}

function oneLine(text, max = 400) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function indent(text) {
  const lines = String(text).split("\n");
  if (lines.length === 1) return lines[0];
  return `\n${lines.map((line) => `        | ${line}`).join("\n")}`;
}
