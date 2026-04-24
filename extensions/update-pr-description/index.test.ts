import { describe, it, expect, beforeEach } from "vitest";
import {
  buildUpdatePrompt,
  createExtension,
  type UpdatePrDeps,
  type MockUi,
} from "./index.js";

// ── URL parsing ──────────────────────────────────────────────────────

// ── Prompt building ──────────────────────────────────────────────────

describe("buildUpdatePrompt", () => {
  it("includes the old content verbatim", () => {
    const prompt = buildUpdatePrompt("## Existing\n\nSome body");
    expect(prompt).toContain("## Existing\n\nSome body");
  });

  it("instructs to wrap new content in <details> tags", () => {
    const prompt = buildUpdatePrompt("x");
    expect(prompt).toContain("<details>");
  });

  it("instructs to be careful with existing content", () => {
    const prompt = buildUpdatePrompt("x");
    expect(prompt.toLowerCase()).toContain("careful");
  });

  it("instructs the agent to submit via the update_pr_description tool", () => {
    const prompt = buildUpdatePrompt("x");
    expect(prompt).toContain("update_pr_description");
    expect(prompt).toContain("new_content");
  });

  it("marks where the editable content begins", () => {
    const prompt = buildUpdatePrompt("## Existing\n\nSome body");
    const marker = prompt.indexOf("BEGIN PR DESCRIPTION");
    const bodyIdx = prompt.indexOf("## Existing");
    expect(marker).toBeGreaterThan(-1);
    expect(marker).toBeLessThan(bodyIdx);
  });
});

// ── Integration harness ──────────────────────────────────────────────

type RegisteredCommand = {
  name: string;
  config: {
    description: string;
    handler: (args: string, ctx: unknown) => Promise<void> | void;
    getArgumentCompletions?: (
      prefix: string,
    ) => Array<{ value: string; label: string }>;
  };
};

type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

interface MockPi {
  commands: RegisteredCommand[];
  tools: RegisteredTool[];
  sent: Array<{ content: string; options?: unknown }>;
  registerCommand(name: string, config: RegisteredCommand["config"]): void;
  registerTool(def: RegisteredTool): void;
  sendUserMessage(content: string, options?: unknown): void;
}

function makeMockPi(): MockPi {
  const pi: MockPi = {
    commands: [],
    tools: [],
    sent: [],
    registerCommand(name, config) {
      this.commands.push({ name, config });
    },
    registerTool(def) {
      this.tools.push(def);
    },
    sendUserMessage(content, options) {
      this.sent.push({ content, options });
    },
  };
  return pi;
}

interface MockUiExtras {
  notifications: Array<{ msg: string; level: string }>;
  confirmAnswer: boolean;
  nextCustomResult: unknown;
}

function makeMockUi(): MockUi & MockUiExtras {
  const ui = {
    notifications: [] as Array<{ msg: string; level: string }>,
    confirmAnswer: true,
    nextCustomResult: undefined as unknown,
    notify(msg: string, level: string) {
      ui.notifications.push({ msg, level });
    },
    async confirm(_title: string, _body?: string) {
      return ui.confirmAnswer;
    },
    async custom<T>(_fn: unknown): Promise<T> {
      return ui.nextCustomResult as T;
    },
  };
  return ui;
}

function makeMockDeps(): UpdatePrDeps & {
  files: Map<string, string>;
  execCalls: Array<{ cmd: string; args: string[]; input?: string }>;
  execResponders: Array<
    (
      cmd: string,
      args: string[],
    ) => { stdout: string; stderr?: string; exitCode?: number } | undefined
  >;
  editPromptCalls: Array<{ title: string; prefill: string }>;
  editPromptResult: string | undefined;
  editPromptTransform?: (prefill: string) => string | undefined;
} {
  const files = new Map<string, string>();
  const execCalls: Array<{ cmd: string; args: string[]; input?: string }> = [];
  const execResponders: Array<
    (
      cmd: string,
      args: string[],
    ) => { stdout: string; stderr?: string; exitCode?: number } | undefined
  > = [];
  const editPromptCalls: Array<{ title: string; prefill: string }> = [];

  let tmpCounter = 0;
  const deps = {
    files,
    execCalls,
    execResponders,
    editPromptCalls,
    editPromptResult: undefined as string | undefined,
    editPromptTransform: undefined as
      | ((prefill: string) => string | undefined)
      | undefined,
    async editPrompt(
      _ctx: unknown,
      title: string,
      prefill: string,
    ): Promise<string | undefined> {
      editPromptCalls.push({ title, prefill });
      if (deps.editPromptTransform) return deps.editPromptTransform(prefill);
      return deps.editPromptResult;
    },
    async exec(
      cmd: string,
      args: string[],
      opts?: { input?: string; cwd?: string },
    ) {
      execCalls.push({ cmd, args, input: opts?.input });
      for (const r of execResponders) {
        const res = r(cmd, args);
        if (res)
          return {
            stdout: res.stdout,
            stderr: res.stderr ?? "",
            exitCode: res.exitCode ?? 0,
          };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async mkdtemp(prefix: string): Promise<string> {
      const dir = `/tmp/${prefix}${++tmpCounter}`;
      return dir;
    },
    async writeFile(path: string, data: string) {
      files.set(path, data);
    },
    async readFile(path: string): Promise<string> {
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    },
  } satisfies UpdatePrDeps & {
    files: Map<string, string>;
    execCalls: Array<{ cmd: string; args: string[]; input?: string }>;
    execResponders: typeof execResponders;
    editPromptCalls: typeof editPromptCalls;
    editPromptResult: string | undefined;
    editPromptTransform?: (prefill: string) => string | undefined;
  };

  return deps;
}

// ── Extension registration ──────────────────────────────────────────

describe("createExtension registration", () => {
  it("registers /update-pr-description command", () => {
    const pi = makeMockPi();
    createExtension(pi, makeMockDeps());
    const cmd = pi.commands.find((c) => c.name === "update-pr-description");
    expect(cmd).toBeDefined();
  });

  it("suggests 'copy' as argument completion", () => {
    const pi = makeMockPi();
    createExtension(pi, makeMockDeps());
    const cmd = pi.commands.find((c) => c.name === "update-pr-description")!;
    const all = cmd.config.getArgumentCompletions!("").map((i) => i.value);
    expect(all).toContain("copy");
    const filtered = cmd.config.getArgumentCompletions!("c").map(
      (i) => i.value,
    );
    expect(filtered).toContain("copy");
    expect(
      cmd.config.getArgumentCompletions!("zzz").map((i) => i.value),
    ).toEqual([]);
  });

  it("registers update_pr_description tool", () => {
    const pi = makeMockPi();
    createExtension(pi, makeMockDeps());
    const tool = pi.tools.find((t) => t.name === "update_pr_description");
    expect(tool).toBeDefined();
  });
});

// ── Command handler ─────────────────────────────────────────────────

describe("command handler", () => {
  let pi: MockPi;
  let deps: ReturnType<typeof makeMockDeps>;
  let ui: ReturnType<typeof makeMockUi>;

  beforeEach(() => {
    pi = makeMockPi();
    deps = makeMockDeps();
    ui = makeMockUi();
    createExtension(pi, deps);
  });

  async function runCmd(args: string = "") {
    const cmd = pi.commands[0]!;
    await cmd.config.handler(args, {
      ui,
      cwd: "/work",
      hasUI: true,
    } as unknown);
  }

  function respondBody(body: string) {
    deps.execResponders.push((cmd, args) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return { stdout: body };
      }
      return undefined;
    });
  }

  it("discovers the current branch's PR via gh (no url argument)", async () => {
    respondBody("## Title\n\nOriginal body");
    await runCmd();

    const ghCall = deps.execCalls.find(
      (c) => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "view",
    );
    expect(ghCall).toBeDefined();
    expect(ghCall!.args).toContain("--json");
    // No URL argument — relies on gh discovering the PR from the branch.
    expect(ghCall!.args.some((a) => a.startsWith("http"))).toBe(false);
  });

  it("ignores any stray arguments", async () => {
    respondBody("body");
    await runCmd("https://github.com/o/r/pull/42");
    const ghCall = deps.execCalls.find(
      (c) => c.cmd === "gh" && c.args[1] === "view",
    );
    expect(ghCall).toBeDefined();
    expect(
      ghCall!.args.some((a) => a === "https://github.com/o/r/pull/42"),
    ).toBe(false);
  });

  it("writes original.md and current.md in a temp dir", async () => {
    respondBody("Original PR body");
    await runCmd();
    const paths = Array.from(deps.files.keys());
    expect(paths.some((p) => p.endsWith("/original.md"))).toBe(true);
    expect(paths.some((p) => p.endsWith("/current.md"))).toBe(true);
    for (const p of paths) {
      expect(deps.files.get(p)).toBe("Original PR body");
    }
  });

  it("opens an editor prefilled with the update prompt before sending", async () => {
    respondBody("## Original body line");
    deps.editPromptTransform = (prefill) => prefill;
    await runCmd();
    expect(deps.editPromptCalls).toHaveLength(1);
    expect(deps.editPromptCalls[0]!.prefill).toContain("## Original body line");
    expect(deps.editPromptCalls[0]!.prefill.toLowerCase()).toContain("careful");
  });

  it("uses a title with the PR URL as a bullet suffix", async () => {
    deps.execResponders.push((cmd, args) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            body: "body",
            url: "https://github.com/owner/repo/pull/42",
          }),
        };
      }
      return undefined;
    });
    deps.editPromptTransform = (prefill) => prefill;
    await runCmd();
    expect(deps.editPromptCalls[0]!.title).toBe(
      "Tell the agent how to update your PR description \u2022 https://github.com/owner/repo/pull/42",
    );
  });

  it("sends the edited prompt to the agent when the user confirms the editor", async () => {
    respondBody("## Original body line");
    deps.editPromptTransform = (prefill) =>
      prefill + "\n\nEXTRA USER INSTRUCTION";
    await runCmd();
    expect(pi.sent).toHaveLength(1);
    expect(pi.sent[0]!.content).toContain("## Original body line");
    expect(pi.sent[0]!.content).toContain("EXTRA USER INSTRUCTION");
  });

  it("aborts without sending a prompt when the user escapes the editor", async () => {
    respondBody("## Original body line");
    deps.editPromptResult = undefined; // escape
    await runCmd();
    expect(pi.sent).toHaveLength(0);
  });

  it("notifies error and does not send prompt if gh fails", async () => {
    deps.execResponders.push((cmd) => {
      if (cmd === "gh") return { stdout: "", stderr: "boom", exitCode: 1 };
      return undefined;
    });
    await runCmd();
    expect(pi.sent).toHaveLength(0);
    expect(ui.notifications.some((n) => n.level === "error")).toBe(true);
  });

  describe("copy subcommand", () => {
    it("re-copies the current.md from an active session without hitting gh or the LLM", async () => {
      respondBody("Original body");
      await runCmd();
      // Simulate an accepted tool call that wrote updated content.
      const currentPath = Array.from(deps.files.keys()).find((p) =>
        p.endsWith("/current.md"),
      )!;
      deps.files.set(currentPath, "Updated body");

      const ghCallsBefore = deps.execCalls.filter((c) => c.cmd === "gh").length;
      const sentBefore = pi.sent.length;

      await runCmd("copy");

      // No new gh calls, no new prompts.
      expect(deps.execCalls.filter((c) => c.cmd === "gh").length).toBe(
        ghCallsBefore,
      );
      expect(pi.sent.length).toBe(sentBefore);
      // It piped current.md into pbcopy.
      const pbcopy = deps.execCalls.find((c) => c.cmd === "pbcopy");
      expect(pbcopy).toBeDefined();
      expect(pbcopy!.input).toBe("Updated body");
      // Confirmation notice was shown.
      expect(ui.notifications.some((n) => n.level === "info")).toBe(true);
    });

    it("notifies an error when there is no active session to copy from", async () => {
      await runCmd("copy");
      expect(ui.notifications.some((n) => n.level === "error")).toBe(true);
      expect(deps.execCalls.some((c) => c.cmd === "pbcopy")).toBe(false);
      expect(deps.execCalls.some((c) => c.cmd === "gh")).toBe(false);
    });
  });
});

// ── Tool execution ──────────────────────────────────────────────────

describe("update_pr_description tool", () => {
  let pi: MockPi;
  let deps: ReturnType<typeof makeMockDeps>;
  let ui: ReturnType<typeof makeMockUi>;

  beforeEach(() => {
    pi = makeMockPi();
    deps = makeMockDeps();
    ui = makeMockUi();
    createExtension(pi, deps);
  });

  async function startSession() {
    deps.execResponders.push((cmd, args) => {
      if (cmd === "gh" && args[1] === "view") {
        return { stdout: "Original body" };
      }
      return undefined;
    });
    deps.editPromptTransform = (prefill) => prefill; // auto-accept editor with prefill
    const cmd = pi.commands[0]!;
    await cmd.config.handler("", {
      ui,
      cwd: "/work",
      hasUI: true,
    } as unknown);
  }

  function getTool() {
    return pi.tools.find((t) => t.name === "update_pr_description")!;
  }

  it("errors if no active session", async () => {
    const tool = getTool();
    await expect(
      tool.execute("id1", { new_content: "x" }, undefined, undefined, {
        ui,
      } as unknown),
    ).rejects.toThrow(/no active/i);
  });

  it("writes new content to current.md", async () => {
    await startSession();
    ui.confirmAnswer = true;
    ui.nextCustomResult = true;
    deps.execResponders.push((cmd) => {
      if (cmd === "delta") return { stdout: "diff output" };
      if (cmd === "pbcopy") return { stdout: "" };
      return undefined;
    });
    const tool = getTool();
    await tool.execute(
      "id1",
      { new_content: "Updated PR body" },
      undefined,
      undefined,
      { ui } as unknown,
    );
    const currentPath = Array.from(deps.files.keys()).find((p) =>
      p.endsWith("/current.md"),
    )!;
    expect(deps.files.get(currentPath)).toBe("Updated PR body");
  });

  it("runs delta against original and current", async () => {
    await startSession();
    ui.confirmAnswer = true;
    ui.nextCustomResult = true;
    deps.execResponders.push((cmd) => {
      if (cmd === "delta") return { stdout: "diff output" };
      if (cmd === "pbcopy") return { stdout: "" };
      return undefined;
    });
    const tool = getTool();
    await tool.execute(
      "id1",
      { new_content: "Updated" },
      undefined,
      undefined,
      { ui } as unknown,
    );
    const deltaCall = deps.execCalls.find((c) => c.cmd === "delta");
    expect(deltaCall).toBeDefined();
    expect(deltaCall!.args.some((a) => a.endsWith("/original.md"))).toBe(true);
    expect(deltaCall!.args.some((a) => a.endsWith("/current.md"))).toBe(true);
  });

  it("copies current.md to clipboard when user confirms", async () => {
    await startSession();
    ui.nextCustomResult = true;
    deps.execResponders.push((cmd) => {
      if (cmd === "delta") return { stdout: "diff output" };
      if (cmd === "pbcopy") return { stdout: "" };
      return undefined;
    });
    const tool = getTool();
    const result = await tool.execute(
      "id1",
      { new_content: "Final body" },
      undefined,
      undefined,
      { ui } as unknown,
    );
    const pbcopyCall = deps.execCalls.find((c) => c.cmd === "pbcopy");
    expect(pbcopyCall).toBeDefined();
    expect(pbcopyCall!.input).toBe("Final body");
    expect(result.content[0]!.text.toLowerCase()).toContain("clipboard");
  });

  it("propagates unexpected errors from ui.custom instead of silently confirming", async () => {
    await startSession();
    // Simulate a bug in the render factory / custom runner.
    const boom = new Error("render blew up");
    ui.custom = async () => {
      throw boom;
    };
    ui.confirmAnswer = true; // would mask the error if fallback kicked in
    deps.execResponders.push((cmd) => {
      if (cmd === "delta") return { stdout: "diff output" };
      if (cmd === "pbcopy") return { stdout: "" };
      return undefined;
    });
    const tool = getTool();
    await expect(
      tool.execute("id1", { new_content: "x" }, undefined, undefined, {
        ui,
      } as unknown),
    ).rejects.toBe(boom);
    // And nothing was copied to the clipboard.
    expect(deps.execCalls.some((c) => c.cmd === "pbcopy")).toBe(false);
  });

  it("does not copy to clipboard when user declines", async () => {
    await startSession();
    ui.nextCustomResult = false;
    deps.execResponders.push((cmd) => {
      if (cmd === "delta") return { stdout: "diff output" };
      if (cmd === "pbcopy") return { stdout: "" };
      return undefined;
    });
    const tool = getTool();
    const result = await tool.execute(
      "id1",
      { new_content: "Final body" },
      undefined,
      undefined,
      { ui } as unknown,
    );
    expect(deps.execCalls.some((c) => c.cmd === "pbcopy")).toBe(false);
    // Should return a message telling the agent to wait for user feedback
    expect(result.content[0]!.text.toLowerCase()).toMatch(
      /wait|feedback|user|changes/,
    );
  });

  it("allows the agent to iterate: second invocation updates current.md again", async () => {
    await startSession();
    ui.nextCustomResult = false;
    deps.execResponders.push((cmd) => {
      if (cmd === "delta") return { stdout: "diff output" };
      if (cmd === "pbcopy") return { stdout: "" };
      return undefined;
    });
    const tool = getTool();
    await tool.execute(
      "id1",
      { new_content: "First draft" },
      undefined,
      undefined,
      { ui } as unknown,
    );
    // Second iteration: user accepts this time
    ui.nextCustomResult = true;
    await tool.execute(
      "id2",
      { new_content: "Second draft" },
      undefined,
      undefined,
      { ui } as unknown,
    );
    const currentPath = Array.from(deps.files.keys()).find((p) =>
      p.endsWith("/current.md"),
    )!;
    expect(deps.files.get(currentPath)).toBe("Second draft");
    expect(deps.execCalls.filter((c) => c.cmd === "pbcopy")).toHaveLength(1);
  });

  it("clears session after user accepts (second call errors)", async () => {
    await startSession();
    ui.nextCustomResult = true;
    deps.execResponders.push((cmd) => {
      if (cmd === "delta") return { stdout: "diff output" };
      if (cmd === "pbcopy") return { stdout: "" };
      return undefined;
    });
    const tool = getTool();
    await tool.execute("id1", { new_content: "Done" }, undefined, undefined, {
      ui,
    } as unknown);
    await expect(
      tool.execute("id2", { new_content: "ignored" }, undefined, undefined, {
        ui,
      } as unknown),
    ).rejects.toThrow(/no active/i);
  });

  it("/update-pr-description copy still works after the agent's submission was accepted", async () => {
    await startSession();
    ui.nextCustomResult = true;
    deps.execResponders.push((cmd) => {
      if (cmd === "delta") return { stdout: "diff output" };
      if (cmd === "pbcopy") return { stdout: "" };
      return undefined;
    });
    const tool = getTool();
    await tool.execute(
      "id1",
      { new_content: "Accepted body" },
      undefined,
      undefined,
      { ui } as unknown,
    );
    // User clobbers clipboard somehow; pbcopy call count baseline:
    const pbcopyBefore = deps.execCalls.filter(
      (c) => c.cmd === "pbcopy",
    ).length;

    const cmd = pi.commands.find((c) => c.name === "update-pr-description")!;
    await cmd.config.handler("copy", {
      ui,
      cwd: "/work",
      hasUI: true,
    } as unknown);

    const pbcopyCalls = deps.execCalls.filter((c) => c.cmd === "pbcopy");
    expect(pbcopyCalls.length).toBe(pbcopyBefore + 1);
    expect(pbcopyCalls[pbcopyCalls.length - 1]!.input).toBe("Accepted body");
  });
});
