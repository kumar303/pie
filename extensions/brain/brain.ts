/**
 * Brain TUI component.
 *
 * Three-panel layout for browsing recent project directories and their logs.
 * Matches the git extension's split-pane pattern: header row, accent border,
 * content rows with │ divider, bottom separator, legend.
 */

import {
  decodeKittyPrintable,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@mariozechner/pi-tui";
import { filterDirs, isSessionActive, type BrainData, type DirEntry } from "./store.js";
import { basename } from "node:path";

// ── Types ───────────────────────────────────────────────────────────

type FocusedPanel = "dirs" | "logs";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL = 100;

// ── Component ───────────────────────────────────────────────────────

export interface BrainComponentOptions {
  cwd?: string;
  cwdBranch?: string | null;
}

export class BrainComponent implements Component {
  private tui: { requestRender: () => void };
  private theme: any;
  private onDone: () => void;
  private onOpenDir: (dir: DirEntry) => void;
  private readLogFn: (sessionId: string) => string[];
  private reloadDataFn: () => BrainData;
  private cwd: string;
  private cwdBranch: string | null;

  private data: BrainData;

  // State
  private focusedPanel: FocusedPanel = "dirs";
  private cursor = 0; // index into the unified filtered list (today + earlier)
  private logScrollOffset = 0;
  private logLines: string[] = [];
  private searchMode = false;
  private searchQuery = "";
  private filteredToday: DirEntry[];
  private filteredEarlier: DirEntry[];
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;

  // Cache
  private cachedLines?: string[];
  private cachedWidth?: number;

  constructor(
    tui: { requestRender: () => void },
    theme: any,
    onDone: () => void,
    onOpenDir: (dir: DirEntry) => void,
    data: BrainData,
    readLogFn: (sessionId: string) => string[],
    reloadDataFn: () => BrainData,
    options?: BrainComponentOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.onDone = onDone;
    this.onOpenDir = onOpenDir;
    this.data = data;
    this.readLogFn = readLogFn;
    this.reloadDataFn = reloadDataFn;
    this.cwd = options?.cwd ?? process.cwd();
    this.cwdBranch = options?.cwdBranch ?? null;
    this.filteredToday = data.today;
    this.filteredEarlier = data.earlier;

    this.refreshLog();
    this.maybeStartSpinner();
  }

  dispose(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  /** Re-read status files and update the active flag on all entries. */
  private refreshActiveFlags(): void {
    const allDirs = [...this.data.today, ...this.data.earlier];
    for (const d of allDirs) {
      d.active = isSessionActive(d.sessionId);
    }
  }

  private maybeStartSpinner(): void {
    const hasActive = [...this.data.today, ...this.data.earlier].some((d) => d.active);
    if (hasActive && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        this.refreshActiveFlags();
        const stillActive = [...this.data.today, ...this.data.earlier].some((d) => d.active);
        if (!stillActive) {
          clearInterval(this.spinnerTimer!);
          this.spinnerTimer = null;
        }
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
        this.invalidate();
        this.tui.requestRender();
      }, SPINNER_INTERVAL);
    } else if (!hasActive && this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  /** The unified filtered list: today items then earlier items. */
  private get unifiedList(): DirEntry[] {
    return [...this.filteredToday, ...this.filteredEarlier];
  }

  private selectedDir(): DirEntry | null {
    return this.unifiedList[this.cursor] ?? null;
  }

  private refreshLog(): void {
    const dir = this.selectedDir();
    if (dir) {
      this.logLines = this.readLogFn(dir.sessionId);
    } else {
      this.logLines = [];
    }
    this.logScrollOffset = this.maxLogScroll();
  }

  private applyFilter(): void {
    this.filteredToday = filterDirs(this.data.today, this.searchQuery);
    this.filteredEarlier = filterDirs(this.data.earlier, this.searchQuery);
    this.cursor = 0;
    this.refreshLog();
  }

  // ── Input handling ──────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.searchMode) {
      this.handleSearchInput(data);
      return;
    }
    if (this.focusedPanel === "logs") {
      this.handleLogsInput(data);
      return;
    }
    this.handleDirListInput(data);
  }

  /** Reload all session data from disk (same as opening /brain fresh). */
  private reload(): void {
    this.data = this.reloadDataFn();
    this.searchQuery = "";
    this.searchMode = false;
    this.filteredToday = this.data.today;
    this.filteredEarlier = this.data.earlier;
    this.cursor = 0;
    this.refreshLog();
    this.maybeStartSpinner();
    this.invalidate();
    this.tui.requestRender();
  }

  private handleDirListInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.onDone(); return; }
    if (matchesKey(data, Key.tab)) { this.focusedPanel = "logs"; this.invalidate(); this.tui.requestRender(); return; }
    if (matchesKey(data, "/")) { this.searchMode = true; this.searchQuery = ""; this.invalidate(); this.tui.requestRender(); return; }
    if (matchesKey(data, "r")) { this.reload(); return; }
    if (matchesKey(data, Key.enter)) {
      const dir = this.selectedDir();
      if (dir) this.onOpenDir(dir);
      return;
    }
    if (matchesKey(data, Key.up)) { this.moveCursor(-1); this.refreshLog(); this.invalidate(); this.tui.requestRender(); return; }
    if (matchesKey(data, Key.down)) { this.moveCursor(1); this.refreshLog(); this.invalidate(); this.tui.requestRender(); return; }
  }

  private handleLogsInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.onDone(); return; }
    if (matchesKey(data, Key.tab)) { this.focusedPanel = "dirs"; this.invalidate(); this.tui.requestRender(); return; }
    if (matchesKey(data, Key.up)) { this.logScrollOffset = Math.max(0, this.logScrollOffset - 1); this.invalidate(); this.tui.requestRender(); return; }
    if (matchesKey(data, Key.down)) { this.logScrollOffset = Math.min(this.maxLogScroll(), this.logScrollOffset + 1); this.invalidate(); this.tui.requestRender(); return; }
    if (matchesKey(data, "d")) { const h = Math.max(1, Math.floor(this.getLogPanelHeight() / 2)); this.logScrollOffset = Math.min(this.maxLogScroll(), this.logScrollOffset + h); this.invalidate(); this.tui.requestRender(); return; }
    if (matchesKey(data, "u")) { const h = Math.max(1, Math.floor(this.getLogPanelHeight() / 2)); this.logScrollOffset = Math.max(0, this.logScrollOffset - h); this.invalidate(); this.tui.requestRender(); return; }
    if (matchesKey(data, "g")) { this.logScrollOffset = 0; this.invalidate(); this.tui.requestRender(); return; }
    if (matchesKey(data, Key.shift("g"))) { this.logScrollOffset = this.maxLogScroll(); this.invalidate(); this.tui.requestRender(); return; }
  }

  private handleSearchInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.searchMode = false; this.searchQuery = "";
      this.filteredToday = this.data.today; this.filteredEarlier = this.data.earlier;
      this.cursor = 0; this.refreshLog();
      this.invalidate(); this.tui.requestRender(); return;
    }
    if (matchesKey(data, Key.enter)) { this.searchMode = false; this.invalidate(); this.tui.requestRender(); return; }
    if (matchesKey(data, Key.up)) { this.moveCursor(-1); this.refreshLog(); this.invalidate(); this.tui.requestRender(); return; }
    if (matchesKey(data, Key.down)) { this.moveCursor(1); this.refreshLog(); this.invalidate(); this.tui.requestRender(); return; }
    if (matchesKey(data, Key.backspace)) {
      if (this.searchQuery.length === 0) {
        this.searchMode = false;
        this.filteredToday = this.data.today; this.filteredEarlier = this.data.earlier;
        this.cursor = 0; this.refreshLog();
      } else {
        this.searchQuery = this.searchQuery.slice(0, -1);
        if (this.searchQuery.length === 0) {
          this.searchMode = false;
          this.filteredToday = this.data.today; this.filteredEarlier = this.data.earlier;
          this.cursor = 0; this.refreshLog();
        } else {
          this.applyFilter();
        }
      }
      this.invalidate(); this.tui.requestRender(); return;
    }
    // Decode printable character (Kitty protocol or raw byte)
    const ch = this.decodePrintable(data);
    if (ch && /[a-zA-Z0-9\-_./@ {}#~+=]/.test(ch)) {
      this.searchQuery += ch; this.applyFilter(); this.invalidate(); this.tui.requestRender(); return;
    }
  }

  /** Extract a printable character from raw input (Kitty protocol or legacy). */
  private decodePrintable(rawData: string): string | undefined {
    const kittyChar = decodeKittyPrintable(rawData);
    if (kittyChar) return kittyChar;
    if (rawData.length === 1) {
      const code = rawData.charCodeAt(0);
      if (code >= 32 && code <= 126) return rawData;
    }
    return undefined;
  }

  private moveCursor(delta: number): void {
    const len = this.unifiedList.length;
    if (len === 0) return;
    this.cursor = (this.cursor + delta + len) % len;
  }

  private lastRenderedLogPanelHeight = 10;
  private getLogPanelHeight(): number {
    return this.lastRenderedLogPanelHeight;
  }

  /** Maximum scroll offset that keeps the last log line at the bottom of the panel. */
  private maxLogScroll(): number {
    return Math.max(0, this.logLines.length - this.getLogPanelHeight());
  }

  // ── Rendering ───────────────────────────────────────────────────

  private padTo(str: string, w: number): string {
    const vis = visibleWidth(str);
    if (vis >= w) return truncateToWidth(str, w);
    return str + " ".repeat(w - vis);
  }

  private row(left: string, right: string, lw: number, rw: number, width: number): string {
    return truncateToWidth(
      this.padTo(left, lw) + this.theme.fg("dim", "│") + this.padTo(right, rw),
      width,
    );
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const theme = this.theme;
    const lines: string[] = [];
    const lw = Math.max(20, Math.floor(width * 0.4));
    const rw = width - lw - 1;

    // Build left-pane content: a flat list of rows with section headers inline
    const leftRows: string[] = [];
    const maxItems = 15;

    // "Today" section header
    // "Today" section header
    leftRows.push(theme.fg("dim", "   Today"));

    // Today items
    const todayCount = Math.min(this.filteredToday.length, maxItems);
    if (todayCount === 0) {
      leftRows.push(theme.fg("dim", "       (none)"));
    } else {
      for (let i = 0; i < todayCount; i++) {
        leftRows.push(this.renderDirEntry(i, lw));
      }
    }

    // Blank line between Today and Earlier
    leftRows.push("");

    // "Earlier" section header
    leftRows.push(theme.fg("dim", "   Earlier"));

    // Earlier items
    const earlierCount = Math.min(this.filteredEarlier.length, maxItems);
    if (earlierCount === 0) {
      leftRows.push(theme.fg("dim", "       (none)"));
    } else {
      for (let i = 0; i < earlierCount; i++) {
        leftRows.push(this.renderDirEntry(todayCount + i, lw));
      }
    }

    // Ensure a minimum height so logs are always readable
    const minContentRows = 20;
    while (leftRows.length < minContentRows) {
      leftRows.push("");
    }

    const totalRows = leftRows.length;
    this.lastRenderedLogPanelHeight = totalRows;

    // Clamp scroll offset now that we know the real panel height
    this.logScrollOffset = Math.min(this.logScrollOffset, this.maxLogScroll());

    // Header row — show cwd with branch
    const leftFocused = this.focusedPanel === "dirs";
    const logsFocused = this.focusedPanel === "logs";
    const cwdName = basename(this.cwd);
    const cwdBranchLabel = this.cwdBranch ? theme.fg("muted", ` [${this.cwdBranch}]`) : "";
    const dirsHeader = leftFocused
      ? theme.fg("accent", theme.bold(" ▶ " + cwdName)) + cwdBranchLabel
      : theme.fg("dim", "   " + cwdName) + cwdBranchLabel;
    const logsHeader = logsFocused
      ? theme.fg("accent", theme.bold(" ▶ Logs"))
      : theme.fg("dim", "   Logs");
    lines.push(this.row(dirsHeader, logsHeader, lw, rw, width));

    // Accent border
    const leftBorder = leftFocused ? "═" : "─";
    const rightBorder = logsFocused ? "═" : "─";
    lines.push(truncateToWidth(
      theme.fg(leftFocused ? "accent" : "dim", leftBorder.repeat(lw)) +
      theme.fg("dim", "│") +
      theme.fg(logsFocused ? "accent" : "dim", rightBorder.repeat(rw)),
      width,
    ));

    // Content rows: left sections paired with log lines (bottom-aligned)
    const logTopPadding = Math.max(0, totalRows - this.logLines.length);
    for (let i = 0; i < totalRows; i++) {
      const logIdx = this.logScrollOffset + (i - logTopPadding);
      const right = logIdx >= 0 && logIdx < this.logLines.length ? " " + this.logLines[logIdx] : "";
      lines.push(this.row(leftRows[i], right, lw, rw, width));
    }

    // Bottom separator + legend
    lines.push(truncateToWidth(theme.fg("dim", "─".repeat(width)), width));
    lines.push(truncateToWidth(this.renderLegend(), width));

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  private renderDirEntry(unifiedIndex: number, maxWidth: number): string {
    const theme = this.theme;
    const entry = this.unifiedList[unifiedIndex];
    if (!entry) return "";
    const isSelected = this.focusedPanel === "dirs" && unifiedIndex === this.cursor;

    let prefix: string;
    if (entry.active) {
      prefix = theme.fg("accent", SPINNER_FRAMES[this.spinnerFrame]) + " ";
    } else {
      prefix = "  ";
    }

    const name = basename(entry.dir);
    const branchSuffix = entry.branch ? theme.fg("muted", ` [${entry.branch}]`) : "";

    if (isSelected) {
      return truncateToWidth("   " + prefix + theme.fg("accent", "> " + name) + branchSuffix, maxWidth);
    }
    return truncateToWidth("   " + prefix + "  " + theme.fg("text", name) + branchSuffix, maxWidth);
  }

  private renderLegend(): string {
    const theme = this.theme;
    if (this.searchMode) {
      return theme.fg("dim", ` / ${this.searchQuery}_ • ↑↓ navigate • enter accept • esc clear`);
    }
    if (this.focusedPanel === "logs") {
      return theme.fg("dim", " ↑↓ scroll • d page down • u page up • g top • G bottom • tab back • esc quit");
    }
    return theme.fg("dim", " ↑↓ navigate • tab logs • / search • r reload • esc quit");
  }
}
