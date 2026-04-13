/**
 * Queue Extension
 *
 * Run saved prompt queues sequentially. Invoke with `/queue <key>`.
 * Each prompt is sent to the agent one at a time, waiting for the
 * previous one to finish before sending the next.
 *
 * Prompts are stored as JSON files in ~/.pi/agent/queue/.
 * On first run, a default `review-and-fix` queue is seeded.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Input,
  Text,
  matchesKey,
  Key,
  type TUI,
  type Component,
} from "@mariozechner/pi-tui";
import { createFileStore, ensureDefaults, type StoreIO } from "./store.js";

// ── Constants ────────────────────────────────────────────────────────

/**
 * Default prompts seeded into the `review-and-fix` key on first run.
 */
export const DEFAULT_PROMPTS: string[] = [
  "I am about to send you review criteria one at a time. Wait for the next criterion. When you receive each criterion, fix the code as instructed.",
  "Double check that all relevant tests pass, all types compile, there are no lint errors, and no formatting errors.",
  "Did you use TDD? Use the break/fix strategy to verify all relevant tests. This is where you temporarily comment out relevant code, make sure the test fails, then uncomment to pass the test.",
  "Take a step back to gather more context from the repository. Do the changes fit the existing style? Do they make use of existing helper functions and patterns?",
  "Look for any code that receives external inputs. Are there any security concerns with how the input is sanitized or how it could be exploited?",
  "Make sure nothing is using try/catch for flow control.",
  "Make sure all caught errors are reported unless they are expected errors.",
  "Make sure there is no code duplication. See if any logic can be shared into common functions.",
  "Does the code use type casting or loose types such as `any`? If so, why? Can it introduce a generic parameter or make another simple change to avoid type casting?",
  "Make sure none of the tests use polling loops or sleep timers when testing async code. If they do, consider mock objects or fake timers. If the code needs refactoring to be more testable, never change a public interface just for testing.",
  "Does it look like any of the existing tests before this change were modified just to make them pass? If they were modified, make sure it was truly because the intended behavior changed.",
  "Make sure no tests are testing static configuration such as a string literal or a constant that will never change based on input. Static configuration should not be tested.",
  "The review has completed",
];

// ── Types ────────────────────────────────────────────────────────────

export type QueueParseResult =
  | { kind: "usage" }
  | { kind: "key"; key: string }
  | { kind: "abort" }
  | { kind: "delete"; key: string }
  | { kind: "invalid"; reason: string };

// ── Validation ───────────────────────────────────────────────────────

/**
 * Validate a key name. Returns an error message or undefined if valid.
 */
export function validateKeyName(key: string): string | undefined {
  if (!key) return "Key name cannot be empty";
  if (key.startsWith(":")) return "Key names starting with ':' are reserved";
  if (/\s/.test(key)) return "Key name cannot contain spaces";
  if (key.includes(".")) return "Key name cannot contain dots";
  if (key.includes("/") || key.includes("\\"))
    return "Key name cannot contain slashes";
  return undefined;
}

// ── Parsing ──────────────────────────────────────────────────────────

export function parseQueueArgs(args: string): QueueParseResult {
  const trimmed = args.trim();
  if (!trimmed) return { kind: "usage" };
  if (trimmed === ":abort") return { kind: "abort" };
  if (trimmed.startsWith(":delete")) {
    const key = trimmed.slice(":delete".length).trim();
    if (!key) return { kind: "invalid", reason: ":delete requires a key name" };
    const error = validateKeyName(key);
    if (error) return { kind: "invalid", reason: error };
    return { kind: "delete", key };
  }
  const error = validateKeyName(trimmed);
  if (error) return { kind: "invalid", reason: error };
  return { kind: "key", key: trimmed };
}

// ── Prompt headers ───────────────────────────────────────────────────

/**
 * Add `[X of Y queued prompts]` headers to all prompts after the first.
 * The first prompt is assumed to be a mode/instruction prompt.
 */
export function addCriteriaHeaders(prompts: string[]): string[] {
  const total = prompts.length - 1;
  return prompts.map((text, i) => {
    if (i === 0) return text;
    return `[${i} of ${total} queued prompts]\n${text}`;
  });
}

// ── Word-wrap formatting ─────────────────────────────────────────────

export function formatPromptLines(
  prefix: string,
  num: string,
  text: string,
  width: number,
): string[] {
  const gutter = `${prefix}${num} `;
  const indent = " ".repeat(gutter.length);
  const contentWidth = Math.max(1, width - gutter.length);

  if (!text) return [gutter];

  const result: string[] = [];
  const paragraphs = text.split("\n");

  for (const paragraph of paragraphs) {
    const wrapped = wordWrap(paragraph, contentWidth);
    for (const line of wrapped) {
      if (result.length === 0) {
        result.push(gutter + line);
      } else {
        result.push(indent + line);
      }
    }
  }

  return result;
}

function wordWrap(text: string, maxWidth: number): string[] {
  if (!text) return [""];
  if (text.length <= maxWidth) return [text];

  const lines: string[] = [];
  const words = text.split(" ");
  let current = "";

  const breakLongWord = (word: string): string => {
    let remaining = word;
    while (remaining.length > maxWidth) {
      lines.push(remaining.slice(0, maxWidth));
      remaining = remaining.slice(maxWidth);
    }
    return remaining;
  };

  for (const word of words) {
    if (word.length > maxWidth) {
      if (current) {
        lines.push(current);
      }
      current = breakLongWord(word);
      continue;
    }

    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxWidth) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines;
}

// ── Edit header ──────────────────────────────────────────────────────

export function buildEditHeader(current: number, total: number): string {
  return `Editing prompt ${current} of ${total} — enter:save  ^C:clear  esc:cancel`;
}

// ── ListState ────────────────────────────────────────────────────────

export class ListState {
  prompts: string[];
  cursor = 0;
  phase: "list" | "edit" = "list";
  editingIndex = 0;
  private isAdding = false;

  constructor(prompts: string[]) {
    this.prompts = [...prompts];
  }

  next(): void {
    if (this.cursor < this.prompts.length - 1) this.cursor++;
  }

  prev(): void {
    if (this.cursor > 0) this.cursor--;
  }

  delete(): void {
    if (this.prompts.length <= 1) return;
    this.prompts.splice(this.cursor, 1);
    if (this.cursor >= this.prompts.length) {
      this.cursor = this.prompts.length - 1;
    }
  }

  edit(): void {
    this.phase = "edit";
    this.editingIndex = this.cursor;
    this.isAdding = false;
  }

  add(): void {
    const insertAt = this.cursor + 1;
    this.prompts.splice(insertAt, 0, "");
    this.editingIndex = insertAt;
    this.phase = "edit";
    this.isAdding = true;
  }

  saveEdit(text: string): void {
    if (!text.trim()) {
      if (this.isAdding) {
        this.prompts.splice(this.editingIndex, 1);
      }
    } else {
      this.prompts[this.editingIndex] = text;
      this.cursor = this.editingIndex;
    }
    this.phase = "list";
    this.isAdding = false;
  }

  submit(): string[] {
    return [...this.prompts];
  }
}

// ── createFinishEdit ─────────────────────────────────────────────────

export function createFinishEdit(
  state: ListState,
  getText: () => string,
): (text?: string) => void {
  return (text?: string) => {
    state.saveEdit(text ?? getText());
  };
}

// ── Queue runner ─────────────────────────────────────────────────────

export interface QueueRunnerCtx {
  waitForIdle: () => Promise<void>;
  sendUserMessage: (text: string) => void;
  setStatus: (text: string | undefined) => void;
  abort: () => void;
}

export class QueueRunner {
  private prompts: string[] = [];
  private nextIndex = 0;
  private active = false;
  private ctx: QueueRunnerCtx;

  constructor(ctx: QueueRunnerCtx) {
    this.ctx = ctx;
  }

  async start(prompts: string[]): Promise<void> {
    this.prompts = prompts;
    this.nextIndex = 0;
    this.active = true;
    this.ctx.setStatus(
      `Queue: scheduled (${prompts.length} prompts) \u2014 /queue :abort to cancel`,
    );
    await this.sendNext();
  }

  async onAgentEnd(): Promise<void> {
    if (!this.active) return;
    if (this.nextIndex >= this.prompts.length) {
      this.active = false;
      this.ctx.setStatus(undefined);
    } else {
      await this.sendNext();
    }
  }

  abort(): void {
    this.active = false;
    this.ctx.abort();
    this.ctx.setStatus(undefined);
  }

  isRunning(): boolean {
    return this.active;
  }

  private async sendNext(): Promise<void> {
    await this.ctx.waitForIdle();
    if (!this.active) return;
    const i = this.nextIndex;
    this.ctx.sendUserMessage(this.prompts[i]);
    this.nextIndex++;
    this.ctx.setStatus(`Queue: ${i + 1}/${this.prompts.length} prompts`);
  }
}

// ── Extension entry point ────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let runner: QueueRunner | null = null;
  const store = createFileStore();

  // We use agent_end because ctx.waitForIdle() seems broken.
  // Maybe this will fix it: https://github.com/badlogic/pi-mono/issues/2023
  pi.on("agent_end", async () => {
    await runner?.onAgentEnd();
  });

  pi.registerCommand("queue", {
    description: "/queue <key> | :abort — run a saved prompt queue",
    getArgumentCompletions: (prefix: string) => {
      ensureDefaults(store, DEFAULT_PROMPTS);
      const trimmed = prefix.trim().toLowerCase();
      const keys = store.listKeys();
      const options = [
        ...keys.map((k) => ({
          value: k,
          label: k,
          description: "Run saved prompt queue",
        })),
        {
          value: ":abort",
          label: ":abort",
          description: "Cancel ongoing queue",
        },
        ...keys.map((k) => ({
          value: `:delete ${k}`,
          label: `:delete ${k}`,
          description: "Delete saved queue",
        })),
      ];
      return options.filter((o) => o.value.startsWith(trimmed));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      ensureDefaults(store, DEFAULT_PROMPTS);
      const parsed = parseQueueArgs(args);

      if (parsed.kind === "usage") {
        const keys = store.listKeys();
        const keyList = keys.length > 0 ? keys.join(", ") : "(none)";
        ctx.ui.notify(`Usage: /queue <key> | :abort\nKeys: ${keyList}`, "info");
        return;
      }

      if (parsed.kind === "invalid") {
        ctx.ui.notify(parsed.reason, "error");
        return;
      }

      if (parsed.kind === "abort") {
        if (runner?.isRunning()) {
          runner.abort();
          ctx.ui.notify("Queue aborted", "info");
        } else {
          ctx.ui.notify("No queue in progress", "info");
        }
        return;
      }

      if (parsed.kind === "delete") {
        if (store.delete(parsed.key)) {
          ctx.ui.notify(`Deleted queue: ${parsed.key}`, "info");
        } else {
          ctx.ui.notify(`Unknown key: ${parsed.key}`, "error");
        }
        return;
      }

      const prompts = store.load(parsed.key);
      if (!prompts) {
        ctx.ui.notify(`Unknown key: ${parsed.key}`, "error");
        return;
      }

      // Show the interactive list UI
      const result = await ctx.ui.custom<
        { prompts: string[]; key: string } | undefined
      >((tui, theme, _kb, done) => {
        return createListView(tui, theme, prompts, parsed.key, store, done);
      });

      if (!result || result.prompts.length === 0) return;

      runner = new QueueRunner({
        waitForIdle: () => ctx.waitForIdle(),
        sendUserMessage: (text) =>
          pi.sendUserMessage(text, { deliverAs: "followUp" }),
        setStatus: (text) => ctx.ui.setStatus("queue", text),
        abort: () => ctx.abort(),
      });

      await runner.start(addCriteriaHeaders(result.prompts));
    },
  });
}

// ── List View Component ──────────────────────────────────────────────

function createListView(
  tui: TUI,
  theme: Theme,
  initialPrompts: string[],
  initialKey: string,
  store: StoreIO,
  done: (result: { prompts: string[]; key: string } | undefined) => void,
): Component & { dispose?(): void } {
  const state = new ListState(initialPrompts);
  let currentKey = initialKey;
  let editor: Editor | null = null;
  let lastWidth = 80;
  let copyInput: Input | null = null;
  let copyInputError = "";
  let flashMessage = "";

  const text = new Text("", 1, 0);

  const renderList = () => {
    const lines: string[] = [];
    const header = `Queue: ${currentKey} (${state.prompts.length}) — enter:submit  e:edit  ↑/↓:nav  d:delete  a:add  S:save  c:copy  esc:cancel`;
    lines.push(theme.bold(theme.fg("accent", header)));
    if (flashMessage) {
      lines.push(theme.fg("success", `  ${flashMessage}`));
    }
    lines.push("");

    for (let i = 0; i < state.prompts.length; i++) {
      const prefix = i === state.cursor ? "▸ " : "  ";
      const num = `${i + 1}.`;
      const promptLines = formatPromptLines(
        prefix,
        num,
        state.prompts[i],
        lastWidth,
      );
      for (const pl of promptLines) {
        lines.push(i === state.cursor ? theme.fg("accent", pl) : pl);
      }
    }

    text.setText(lines.join("\n"));
  };

  const editorTheme: EditorTheme = {
    borderColor: (s: string) => theme.fg("accent", s),
    selectList: {
      selectedPrefix: (s: string) => theme.fg("accent", s),
      selectedText: (s: string) => theme.fg("accent", s),
      description: (s: string) => theme.fg("dim", s),
      scrollInfo: (s: string) => theme.fg("dim", s),
      noMatch: (s: string) => theme.fg("dim", s),
    },
  };

  let finishEdit: (text?: string) => void = () => {};

  const openEditor = (initialText: string) => {
    editor = new Editor(tui, editorTheme, { paddingX: 0 });
    editor.focused = true;
    editor.setText(initialText);
    finishEdit = createFinishEdit(state, () => editor?.getText() ?? "");
    editor.onSubmit = (submitText: string) => {
      finishEdit(submitText);
      editor = null;
    };
  };

  const enterEditMode = () => {
    state.edit();
    openEditor(state.prompts[state.editingIndex]);
  };

  const enterAddMode = () => {
    state.add();
    openEditor("");
  };

  renderList();

  return {
    render: (w: number) => {
      lastWidth = w;
      if (state.phase === "edit" && editor) {
        const headerText = buildEditHeader(
          state.editingIndex + 1,
          state.prompts.length,
        );
        const headerLines = [theme.bold(theme.fg("accent", headerText)), ""];
        return [...headerLines, ...editor.render(w)];
      }
      renderList();
      const listLines = text.render(w);
      if (copyInput) {
        const copyHeader = theme.bold(
          theme.fg("accent", "Copy to new queue (esc to cancel):"),
        );
        const errorLines = copyInputError
          ? [theme.fg("error", `  ${copyInputError}`)]
          : [];
        return [
          ...listLines,
          "",
          copyHeader,
          ...copyInput.render(w),
          ...errorLines,
        ];
      }
      return listLines;
    },
    invalidate: () => {
      if (state.phase === "edit" && editor) {
        editor.invalidate();
      } else if (copyInput) {
        copyInput.invalidate();
        text.invalidate();
      } else {
        text.invalidate();
      }
    },
    handleInput: (data: string) => {
      flashMessage = "";

      if (state.phase === "edit" && editor) {
        if (matchesKey(data, Key.escape)) {
          finishEdit();
          return;
        }
        if (matchesKey(data, Key.ctrl("c"))) {
          editor.setText("");
          return;
        }
        editor.handleInput(data);
        return;
      }

      // Copy input mode
      if (copyInput) {
        copyInput.handleInput(data);
        return;
      }

      if (matchesKey(data, Key.escape)) {
        done(undefined);
        return;
      }

      if (matchesKey(data, Key.enter)) {
        done({ prompts: state.submit(), key: currentKey });
        return;
      }

      if (matchesKey(data, Key.down)) {
        state.next();
        return;
      }

      if (matchesKey(data, Key.up)) {
        state.prev();
        return;
      }

      if (matchesKey(data, "e")) {
        enterEditMode();
        return;
      }

      if (matchesKey(data, "d")) {
        state.delete();
        return;
      }

      if (matchesKey(data, "a")) {
        enterAddMode();
        return;
      }

      if (matchesKey(data, Key.shift("s"))) {
        store.save(currentKey, state.prompts);
        flashMessage = `Saved to ${currentKey}`;
        return;
      }

      if (matchesKey(data, "c")) {
        copyInput = new Input();
        copyInput.focused = true;
        copyInputError = "";
        copyInput.onSubmit = (value: string) => {
          const newKey = value.trim();
          const error = validateKeyName(newKey);
          if (error) {
            copyInputError = error;
            return;
          }
          store.save(newKey, state.prompts);
          currentKey = newKey;
          copyInput = null;
          copyInputError = "";
          flashMessage = `Copied to ${newKey}`;
        };
        copyInput.onEscape = () => {
          copyInput = null;
          copyInputError = "";
        };
        return;
      }
    },
  };
}
