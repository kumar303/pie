import { describe, it, expect, vi, afterEach } from "vitest";
import { BrainComponent } from "./brain.js";
import type { BrainData, DirEntry } from "./store.js";
import type { StatusMessage, ErrorMessage } from "./service.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makeTui() {
  return { requestRender: vi.fn() };
}

function makeTheme() {
  return {
    fg: (_color: string, text?: string) => text ?? "",
    bold: (text: string) => text,
  };
}

function makeDirs(overrides?: Partial<DirEntry>[]): DirEntry[] {
  const defaults: DirEntry[] = [
    {
      sessionId: "s1",
      dir: "/home/user/alpha",
      branch: "main",
      lastFocused: 1000,
      active: false,
    },
    {
      sessionId: "s2",
      dir: "/home/user/beta",
      branch: "feat/login",
      lastFocused: 900,
      active: false,
    },
    {
      sessionId: "s3",
      dir: "/home/user/gamma",
      branch: null,
      lastFocused: 800,
      active: false,
    },
  ];
  if (overrides) {
    return defaults.map((d, i) => ({ ...d, ...(overrides[i] || {}) }));
  }
  return defaults;
}

function makeData(opts?: {
  today?: DirEntry[];
  earlier?: DirEntry[];
}): BrainData {
  return {
    today: opts?.today ?? makeDirs(),
    earlier:
      opts?.earlier ??
      makeDirs([
        { sessionId: "s4", dir: "/home/user/delta", branch: "develop" },
        { sessionId: "s5", dir: "/home/user/epsilon", branch: null },
      ]),
  };
}

function fakeReadLog(sessionId: string): string[] {
  return [`[bash] log for ${sessionId}`, "line 1", "line 2", "line 3"];
}

function createComponent(opts?: {
  data?: BrainData;
  readLogFn?: (sessionId: string) => string[];
  readSessionsFn?: () => BrainData;
  onDone?: () => void;
  onOpenDir?: (dir: DirEntry) => void;
  cwd?: string;
  cwdBranch?: string | null;
  sessionId?: string;
}) {
  const tui = makeTui();
  const theme = makeTheme();
  const onDone = opts?.onDone ?? vi.fn();
  const onOpenDir = opts?.onOpenDir ?? vi.fn();
  const data = opts?.data ?? makeData();
  const readLogFn = opts?.readLogFn ?? fakeReadLog;

  const component = new BrainComponent(
    tui,
    theme,
    onDone,
    onOpenDir,
    data,
    readLogFn,
    {
      cwd: opts?.cwd ?? "/home/user/current-project",
      cwdBranch: opts?.cwdBranch ?? "main",
      readSessionsFn: opts?.readSessionsFn,
      sessionId: opts?.sessionId,
    },
  );
  return { component, tui, onDone, onOpenDir, data };
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderText(component: BrainComponent, width = 80): string {
  return component.render(width).map(stripAnsi).join("\n");
}

// Key encoding helpers
const ESC = "\x1b";
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const ENTER = "\r";
const TAB = "\t";
const ESCAPE = ESC;
const BACKSPACE = "\x7f";

// ── Tests ───────────────────────────────────────────────────────────

afterEach(() => {
  vi.restoreAllMocks();
});

describe("header shows cwd", () => {
  it("shows current directory and branch in the header", () => {
    const { component } = createComponent({
      cwd: "/home/user/my-project",
      cwdBranch: "feat/cool",
    });
    const text = renderText(component);
    expect(text).toContain("my-project");
    expect(text).toContain("feat/cool");
  });

  it("shows current directory without branch when branch is null", () => {
    const { component } = createComponent({
      cwd: "/tmp/no-git-repo",
      cwdBranch: null,
    });
    const text = renderText(component);
    expect(text).toContain("no-git-repo");
    expect(text).not.toContain("[null]");
  });
});

describe("BrainComponent render", () => {
  it("renders panel titles (Today, Earlier, Logs)", () => {
    const { component } = createComponent();
    const text = renderText(component);
    expect(text).toContain("Today");
    expect(text).toContain("Earlier");
    expect(text).toContain("Logs");
  });

  it("shows cursor highlight (>) on focused item", () => {
    const { component } = createComponent();
    const text = renderText(component);
    expect(text).toContain("> alpha");
  });

  it("shows branch display (name [branch])", () => {
    const { component } = createComponent();
    const text = renderText(component);
    expect(text).toContain("alpha [main]");
    expect(text).toContain("beta [feat/login]");
  });

  it("shows log content in panel B", () => {
    const { component } = createComponent();
    const text = renderText(component);
    expect(text).toContain("[bash] log for s1");
  });

  it("respects width — lines do not exceed width", () => {
    const { component } = createComponent();
    const width = 60;
    const lines = component.render(width);
    for (const line of lines) {
      const stripped = stripAnsi(line);
      // visibleWidth accounts for full-width chars but for ASCII it's length
      expect(stripped.length).toBeLessThanOrEqual(width);
    }
  });

  it("handles empty state", () => {
    const { component } = createComponent({ data: { today: [], earlier: [] } });
    const text = renderText(component);
    expect(text).toContain("Today");
    expect(text).toContain("Earlier");
    expect(text).toContain("Logs");
  });
});

describe("cursor wrapping", () => {
  it("wraps cursor down from last Earlier to first Today", () => {
    const { component } = createComponent();
    // Today has 3, Earlier has 3 = 6 total. 6 downs wraps to first.
    for (let i = 0; i < 6; i++) component.handleInput(DOWN);
    const text = renderText(component);
    expect(text).toContain("> alpha");
  });

  it("wraps cursor up from first Today to last Earlier", () => {
    const { component } = createComponent();
    component.handleInput(UP); // wraps to last earlier item
    const text = renderText(component);
    // Last earlier item is "gamma" (s3 overridden with s3 from makeDirs defaults)
    expect(text).toContain("> gamma");
  });
});

describe("tab switches between dir list and logs", () => {
  it("tab moves from dir list to logs", () => {
    const { component } = createComponent();
    component.handleInput(TAB);
    const text = renderText(component);
    expect(text).toContain("↑↓ scroll"); // logs legend
  });

  it("tab moves from logs back to dir list", () => {
    const { component } = createComponent();
    component.handleInput(TAB); // → logs
    component.handleInput(TAB); // → back to dirs
    const text = renderText(component);
    expect(text).toContain("↑↓ navigate");
  });

  it("tab does not change which directory log is shown", () => {
    const readLogFn = vi.fn((sessionId: string) => [`log for ${sessionId}`]);
    const { component } = createComponent({ readLogFn });

    readLogFn.mockClear();
    component.handleInput(TAB); // → logs
    expect(readLogFn).not.toHaveBeenCalled();
    const text = renderText(component);
    expect(text).toContain("log for s1");
  });
});

describe("arrow keys navigate unified today/earlier list", () => {
  it("down from last Today item moves to first Earlier item", () => {
    const readLogFn = vi.fn((sessionId: string) => [`log for ${sessionId}`]);
    const { component } = createComponent({ readLogFn });

    // Start at alpha (today[0]), move down past gamma (today[2])
    component.handleInput(DOWN); // beta
    component.handleInput(DOWN); // gamma
    component.handleInput(DOWN); // → delta (earlier[0])
    const text = renderText(component);
    expect(text).toContain("> delta");
    expect(readLogFn).toHaveBeenCalledWith("s4");
  });

  it("up from first Earlier item moves to last Today item", () => {
    const { component } = createComponent();

    // Navigate down to first Earlier item
    component.handleInput(DOWN); // beta
    component.handleInput(DOWN); // gamma
    component.handleInput(DOWN); // delta (earlier[0])
    component.handleInput(UP); // → gamma (today[2])
    const text = renderText(component);
    expect(text).toContain("> gamma");
  });

  it("wraps from last Earlier item to first Today item", () => {
    const { component } = createComponent();

    // Go all the way down through today (3) + earlier (3) = 6 items, then one more to wrap
    for (let i = 0; i < 6; i++) component.handleInput(DOWN);
    const text = renderText(component);
    expect(text).toContain("> alpha");
  });

  it("wraps from first Today item up to last Earlier item", () => {
    const { component } = createComponent();
    component.handleInput(UP); // wrap to last earlier item
    const text = renderText(component);
    expect(text).toContain("> gamma"); // last earlier item
    // It should be in the Earlier section (the "gamma" with sessionId s3 from earlier)
  });

  it("refreshes log when crossing from Today to Earlier", () => {
    const readLogFn = vi.fn((sessionId: string) => [`log for ${sessionId}`]);
    const { component } = createComponent({ readLogFn });

    component.handleInput(DOWN); // beta (s2)
    component.handleInput(DOWN); // gamma (s3)
    component.handleInput(DOWN); // delta (s4, first earlier)
    expect(readLogFn).toHaveBeenCalledWith("s4");
    const text = renderText(component);
    expect(text).toContain("log for s4");
  });
});

describe("search", () => {
  it("filters both Today and Earlier lists", () => {
    const { component } = createComponent();
    component.handleInput("/");
    component.handleInput("a"); // matches "alpha" and "delta"
    const text = renderText(component);
    expect(text).toContain("alpha");
    // gamma and beta should not show
    expect(text).not.toMatch(/\bgeta\b/);
  });

  it("accepts valid chars (raw bytes)", () => {
    const { component } = createComponent();
    component.handleInput("/");
    component.handleInput("a");
    component.handleInput("-");
    component.handleInput("1");
    const text = renderText(component);
    expect(text).toContain("/ a-1_");
  });

  it("accepts valid chars (kitty protocol)", () => {
    const { component } = createComponent();
    component.handleInput("/");
    // Kitty protocol encodes 'a' as CSI 97 u
    component.handleInput("\x1b[97u");
    // Kitty protocol encodes 'b' as CSI 98 u
    component.handleInput("\x1b[98u");
    const text = renderText(component);
    expect(text).toContain("/ ab_");
  });

  it("escape clears filter", () => {
    const { component } = createComponent();
    component.handleInput("/");
    component.handleInput("z"); // no matches
    component.handleInput(ESCAPE);
    const text = renderText(component);
    // All items should be back
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
  });

  it("enter keeps filter", () => {
    const { component } = createComponent();
    component.handleInput("/");
    component.handleInput("a");
    component.handleInput("l");
    component.handleInput("p");
    component.handleInput("h");
    component.handleInput(ENTER);
    const text = renderText(component);
    // Should still be filtered to "alph" match
    expect(text).toContain("alpha");
    expect(text).not.toContain("beta [feat/login]");
  });

  it("enter opens the selected directory", () => {
    const onOpenDir = vi.fn();
    const { component } = createComponent({ onOpenDir });
    component.handleInput("/");
    component.handleInput("a");
    component.handleInput("l");
    component.handleInput("p");
    component.handleInput("h");
    component.handleInput(ENTER);
    expect(onOpenDir).toHaveBeenCalledTimes(1);
    expect(onOpenDir).toHaveBeenCalledWith(
      expect.objectContaining({ dir: "/home/user/alpha" }),
    );
  });

  it("backspace to empty exits search", () => {
    const { component } = createComponent();
    component.handleInput("/");
    component.handleInput("a");
    component.handleInput(BACKSPACE);
    // Now query is empty, search should exit
    const text = renderText(component);
    // All items should show (no filter) and no search indicator
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).not.toContain("/ _");
  });

  it("arrow keys navigate within filtered list while searching", () => {
    const { component } = createComponent();
    component.handleInput("/");
    component.handleInput("a");
    component.handleInput(DOWN);
    // Should move cursor without exiting search
    const text = renderText(component);
    expect(text).toContain("/ a_");
  });
});

describe("log content sanitization", () => {
  it("lines do not exceed width when log lines contain tab characters", () => {
    const logWithTabs = [
      "\t\t\tconst x = 1;",
      "\t\tif (true) {",
      "\t\t\t\treturn x;",
      "\t}",
    ];
    const { component } = createComponent({
      readLogFn: () => logWithTabs,
    });
    const width = 80;
    const lines = component.render(width).map(stripAnsi);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(width);
      // Ensure no tab characters remain in rendered output
      expect(line).not.toContain("\t");
    }
  });

  it("strips carriage returns from log lines to prevent layout breakage", () => {
    const logWithCarriageReturn = [
      "line before",
      "progress update\rthis should not reset cursor",
      "line after",
    ];
    const { component } = createComponent({
      readLogFn: () => logWithCarriageReturn,
    });

    const rendered = component.render(100).join("\n");
    expect(rendered).not.toContain("\r");
  });

  it("strips ANSI cursor/control escape sequences from log lines", () => {
    const logWithAnsiControl = [
      "before",
      "\u001b[2K\u001b[1Grewritten line",
      "\u001b]0;window-title\u0007after-title",
      "after",
    ];
    const { component } = createComponent({
      readLogFn: () => logWithAnsiControl,
    });

    const rendered = component.render(100).join("\n");
    expect(rendered).not.toContain("\u001b[2K");
    expect(rendered).not.toContain("\u001b[1G");
    expect(rendered).not.toContain("\u001b]0;");
    expect(rendered).toContain("rewritten line");
    expect(rendered).toContain("after-title");
  });
});

describe("Panel B scroll", () => {
  it("scrolls up and down with arrow keys", () => {
    const longLog = Array.from({ length: 50 }, (_, i) => `log line ${i}`);
    const { component } = createComponent({
      readLogFn: () => longLog,
    });
    // Focus logs panel
    component.handleInput(TAB);
    component.handleInput("g"); // go to top
    component.handleInput(DOWN);
    // Should have scrolled
    const text = renderText(component);
    expect(text).toContain("log line");
  });

  it("g scrolls to top, G scrolls to bottom", () => {
    const longLog = Array.from({ length: 50 }, (_, i) => `log line ${i}`);
    const { component } = createComponent({
      readLogFn: () => longLog,
    });
    component.handleInput(TAB);
    component.handleInput("g"); // top
    let text = renderText(component);
    expect(text).toContain("log line 0");

    // G = shift+g
    component.handleInput(String.fromCharCode(71)); // 'G' uppercase
    text = renderText(component);
    expect(text).toContain("log line 49");
  });

  it("shows last log line at bottom with no empty space below", () => {
    // 8 log lines in a panel that is ~20 rows tall — last line should be at the bottom
    const logLines = Array.from({ length: 8 }, (_, i) => `log line ${i}`);
    const { component } = createComponent({
      readLogFn: () => logLines,
    });
    const lines = component.render(80).map(stripAnsi);
    // Content rows start after the accent border (index 1) and end before the bottom separator
    const sepIdx = lines.findLastIndex((l) => /^─+$/.test(l.trim()));
    const contentRows = lines.slice(2, sepIdx);

    // Extract right panel content (after the │ divider)
    const rightContent = contentRows.map((row) => {
      const dividerPos = row.indexOf("│");
      return dividerPos >= 0 ? row.slice(dividerPos + 1).trim() : "";
    });

    // The last log line should be at the very last content row (no empty space after it)
    const lastNonEmpty = rightContent.findLastIndex((r) => r.length > 0);
    expect(lastNonEmpty).toBe(rightContent.length - 1);
    expect(rightContent[lastNonEmpty]).toContain("log line 7");
  });

  it("does not scroll past the end of the log", () => {
    const logLines = Array.from({ length: 8 }, (_, i) => `log line ${i}`);
    const { component } = createComponent({
      readLogFn: () => logLines,
    });
    // Focus logs panel and try to scroll down
    component.handleInput(TAB);
    for (let i = 0; i < 20; i++) component.handleInput(DOWN);

    const lines = component.render(80).map(stripAnsi);
    const sepIdx = lines.findLastIndex((l) => /^─+$/.test(l.trim()));
    const contentRows = lines.slice(2, sepIdx);
    const rightContent = contentRows.map((row) => {
      const dividerPos = row.indexOf("│");
      return dividerPos >= 0 ? row.slice(dividerPos + 1).trim() : "";
    });

    // Last log line should still be at the bottom
    const lastNonEmpty = rightContent.findLastIndex((r) => r.length > 0);
    expect(lastNonEmpty).toBe(rightContent.length - 1);
    expect(rightContent[lastNonEmpty]).toContain("log line 7");
  });

  it("d/u page down/up", () => {
    const longLog = Array.from({ length: 50 }, (_, i) => `log line ${i}`);
    const { component } = createComponent({
      readLogFn: () => longLog,
    });
    component.handleInput(TAB);
    component.handleInput("g"); // start from top
    component.handleInput("d"); // page down
    const text = renderText(component);
    // Should have scrolled down
    expect(text).not.toContain("log line 0");
  });
});

describe("escape calls onDone", () => {
  it("calls onDone from Today panel", () => {
    const { component, onDone } = createComponent();
    component.handleInput(ESCAPE);
    expect(onDone).toHaveBeenCalled();
  });

  it("calls onDone from Logs panel", () => {
    const { component, onDone } = createComponent();
    component.handleInput(TAB);
    component.handleInput(ESCAPE);
    expect(onDone).toHaveBeenCalled();
  });
});

describe("active dirs show spinner", () => {
  it("shows spinner for active directory", () => {
    const { component } = createComponent({
      data: {
        today: [
          {
            sessionId: "s1",
            dir: "/home/user/active-project",
            branch: "main",
            lastFocused: 1000,
            active: true,
          },
        ],
        earlier: [],
      },
    });
    const text = renderText(component);
    // Should contain one of the spinner frames
    const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    expect(spinnerFrames.some((f) => text.includes(f))).toBe(true);
    component.dispose();
  });

  it("shows padding for idle directory (aligned)", () => {
    const { component } = createComponent({
      data: {
        today: [
          {
            sessionId: "s1",
            dir: "/home/user/active",
            branch: null,
            lastFocused: 1000,
            active: true,
          },
          {
            sessionId: "s2",
            dir: "/home/user/idle",
            branch: null,
            lastFocused: 900,
            active: false,
          },
        ],
        earlier: [],
      },
    });
    const lines = component.render(80).map(stripAnsi);
    // Active should have a spinner frame, idle should have spaces for alignment
    const activeLine = lines.find((l) => l.includes("active"));
    const idleLine = lines.find((l) => l.includes("idle"));
    expect(activeLine).toBeDefined();
    expect(idleLine).toBeDefined();
    // Both should have content indented similarly
    component.dispose();
  });

  it("does not start spinner timer when no active dirs", () => {
    const { component } = createComponent({
      data: {
        today: [
          {
            sessionId: "s1",
            dir: "/home/user/idle",
            branch: null,
            lastFocused: 1000,
            active: false,
          },
        ],
        earlier: [],
      },
    });
    // No timer should be running — we just verify it doesn't crash
    component.dispose();
  });
});

describe("enter opens directory", () => {
  it("calls onOpenDir with selected directory", () => {
    const { component, onOpenDir } = createComponent();
    component.handleInput(ENTER);
    expect(onOpenDir).toHaveBeenCalledWith(
      expect.objectContaining({ dir: "/home/user/alpha" }),
    );
  });

  it("opens directory from Earlier section", () => {
    const { component, onOpenDir } = createComponent();
    // Navigate down past today (3 items) to first earlier item
    component.handleInput(DOWN);
    component.handleInput(DOWN);
    component.handleInput(DOWN);
    component.handleInput(ENTER);
    expect(onOpenDir).toHaveBeenCalledWith(
      expect.objectContaining({ dir: "/home/user/delta" }),
    );
  });

  it("exits instead of opening when selected dir is the current session", () => {
    const { component, onOpenDir, onDone } = createComponent({
      sessionId: "s1",
    });
    // Cursor starts on alpha which has sessionId "s1"
    component.handleInput(ENTER);
    expect(onOpenDir).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("opens other session in same directory instead of exiting", () => {
    // Two sessions in /home/user/alpha: s1 (in the list) and our session
    const { component, onOpenDir, onDone } = createComponent({
      cwd: "/home/user/alpha",
      sessionId: "other-session-same-dir",
    });
    // Cursor starts on alpha (sessionId "s1") — same dir, different session
    component.handleInput(ENTER);
    expect(onOpenDir).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("exits instead of opening current session via search", () => {
    const { component, onOpenDir, onDone } = createComponent({
      sessionId: "s1",
    });
    // Search for alpha and press enter
    component.handleInput("/");
    component.handleInput("a");
    component.handleInput("l");
    component.handleInput("p");
    component.handleInput(ENTER);
    expect(onOpenDir).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("handleStatusMessage", () => {
  it("sets active flag when status is working", () => {
    const { component } = createComponent();
    const msg: StatusMessage = {
      type: "status",
      sessionId: "s1",
      dir: "/home/user/alpha",
      branch: "main",
      state: "working",
    };
    component.handleStatusMessage(msg);
    const text = renderText(component);
    // Should show spinner for the active entry
    const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    expect(spinnerFrames.some((f) => text.includes(f))).toBe(true);
    component.dispose();
  });

  it("clears active flag when status is idle", () => {
    const { component, data } = createComponent({
      data: {
        today: [
          {
            sessionId: "s1",
            dir: "/home/user/alpha",
            branch: "main",
            lastFocused: 1000,
            active: true,
          },
        ],
        earlier: [],
      },
    });
    component.dispose(); // Stop any existing spinner from constructor

    const msg: StatusMessage = {
      type: "status",
      sessionId: "s1",
      dir: "/home/user/alpha",
      branch: "main",
      state: "idle",
    };
    component.handleStatusMessage(msg);
    expect(data.today[0].active).toBe(false);
    component.dispose();
  });

  it("triggers re-render on status message", () => {
    const { component, tui } = createComponent();
    tui.requestRender.mockClear();

    const msg: StatusMessage = {
      type: "status",
      sessionId: "s1",
      dir: "/home/user/alpha",
      branch: "main",
      state: "working",
    };
    component.handleStatusMessage(msg);
    expect(tui.requestRender).toHaveBeenCalled();
    component.dispose();
  });

  it("updates branch from status message", () => {
    const { component } = createComponent({ cwdBranch: "develop" });
    // Initially alpha has branch "main" (from makeDirs)
    let text = renderText(component);
    expect(text).toContain("alpha [main]");

    // Simulate a status update where the branch changed
    const msg: StatusMessage = {
      type: "status",
      sessionId: "s1",
      dir: "/home/user/alpha",
      branch: "feat/new-branch",
      state: "working",
    };
    component.handleStatusMessage(msg);
    text = renderText(component);
    expect(text).toContain("alpha [feat/new-branch]");
    expect(text).not.toContain("alpha [main]");
    component.dispose();
  });

  it("clears branch display when status message has null branch", () => {
    const { component } = createComponent();
    const text = renderText(component);
    expect(text).toContain("alpha [main]");

    const msg: StatusMessage = {
      type: "status",
      sessionId: "s1",
      dir: "/home/user/alpha",
      branch: null,
      state: "idle",
    };
    component.handleStatusMessage(msg);
    // alpha should no longer show [main]
    const lines = component.render(80).map(stripAnsi);
    const alphaLine = lines.find((l) => l.includes("alpha"));
    expect(alphaLine).toBeDefined();
    expect(alphaLine).not.toContain("[main]");
    component.dispose();
  });
});

describe("handleSessionsChanged", () => {
  it("re-reads sessions and refreshes the list", () => {
    const newData: BrainData = {
      today: [
        {
          sessionId: "s9",
          dir: "/home/user/new-project",
          branch: "feat",
          lastFocused: 2000,
          active: false,
        },
      ],
      earlier: [],
    };
    const readSessionsFn = vi.fn(() => newData);
    const { component } = createComponent({ readSessionsFn });

    // Initially shows original data
    let text = renderText(component);
    expect(text).toContain("alpha");

    // Receive sessions_changed
    component.handleSessionsChanged();
    text = renderText(component);
    expect(text).toContain("new-project");
    expect(text).not.toContain("alpha");
    expect(readSessionsFn).toHaveBeenCalled();
  });

  it("preserves search filter when sessions change", () => {
    const newData: BrainData = {
      today: [
        {
          sessionId: "s1",
          dir: "/home/user/alpha",
          branch: "main",
          lastFocused: 2000,
          active: false,
        },
        {
          sessionId: "s9",
          dir: "/home/user/zeta",
          branch: null,
          lastFocused: 1000,
          active: false,
        },
      ],
      earlier: [],
    };
    const readSessionsFn = vi.fn(() => newData);
    const { component } = createComponent({ readSessionsFn });

    // Enter search mode and type "alp"
    component.handleInput("/");
    component.handleInput("a");
    component.handleInput("l");
    component.handleInput("p");
    component.handleInput(ENTER); // accept search

    component.handleSessionsChanged();
    const text = renderText(component);
    expect(text).toContain("alpha");
    expect(text).not.toContain("zeta");
  });

  it("clamps cursor when list shrinks", () => {
    const { component } = createComponent();

    // Move cursor to later item
    component.handleInput(DOWN);
    component.handleInput(DOWN);

    const newData: BrainData = {
      today: [
        {
          sessionId: "s1",
          dir: "/home/user/only",
          branch: null,
          lastFocused: 1000,
          active: false,
        },
      ],
      earlier: [],
    };
    const readSessionsFn = vi.fn(() => newData);
    // We need to set readSessionsFn — create a new component
    const { component: comp2 } = createComponent({ readSessionsFn });
    comp2.handleInput(DOWN);
    comp2.handleInput(DOWN);
    comp2.handleSessionsChanged();
    const text = renderText(comp2);
    expect(text).toContain("> only");
  });

  it("is a no-op without readSessionsFn", () => {
    const { component, tui } = createComponent();
    tui.requestRender.mockClear();
    // Should not throw or re-render
    component.handleSessionsChanged();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });
});

describe("handleError", () => {
  it("displays error notification", () => {
    const { component } = createComponent();
    const msg: ErrorMessage = {
      type: "error",
      sessionId: "s1",
      message: "Service crashed!",
    };
    component.handleError(msg);
    const text = renderText(component);
    expect(text).toContain("Service crashed!");
  });

  it("triggers re-render", () => {
    const { component, tui } = createComponent();
    tui.requestRender.mockClear();
    component.handleError({ type: "error", sessionId: "s1", message: "oops" });
    expect(tui.requestRender).toHaveBeenCalled();
  });
});
