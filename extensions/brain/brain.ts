/**
 * Brain TUI component.
 *
 * Single-panel layout for browsing recent project directories.
 */

import {
  decodeKittyPrintable,
  matchesKey,
  Key,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { filterDirs, type BrainData, type DirEntry } from "./store.js";
import type { StatusMessage, ErrorMessage } from "./service.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;

export interface BrainComponentOptions {
  cwd?: string;
  cwdBranch?: string | null;
  /** The session ID of the current pi instance. */
  sessionId?: string;
  /** Called when sessions_changed is received to re-read session data. */
  readSessionsFn?: () => BrainData;
}

export class BrainComponent implements Component {
  private tui: { requestRender: () => void };
  private theme: any;
  private onDone: () => void;
  private onOpenDir: (dir: DirEntry) => void;
  private readSessionsFn?: () => BrainData;
  private cwd: string;
  private cwdBranch: string | null;
  private sessionId: string | null;
  private data: BrainData;

  private cursor = 0;
  private earlierScrollOffset = 0;
  private searchMode = false;
  private searchQuery = "";
  private filteredToday: DirEntry[];
  private filteredEarlier: DirEntry[];
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private errorNotification: string | null = null;
  private lastRenderedEarlierSlots = 10;

  private cachedLines?: string[];
  private cachedWidth?: number;

  constructor(
    tui: { requestRender: () => void },
    theme: any,
    onDone: () => void,
    onOpenDir: (dir: DirEntry) => void,
    data: BrainData,
    options?: BrainComponentOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.onDone = onDone;
    this.onOpenDir = onOpenDir;
    this.data = data;
    this.readSessionsFn = options?.readSessionsFn;
    this.cwd = options?.cwd ?? process.cwd();
    this.cwdBranch = options?.cwdBranch ?? null;
    this.sessionId = options?.sessionId ?? null;
    this.filteredToday = data.today;
    this.filteredEarlier = data.earlier;
    this.maybeStartSpinner();
  }

  dispose(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  handleStatusMessage(msg: StatusMessage): void {
    for (const dir of [...this.data.today, ...this.data.earlier]) {
      if (dir.sessionId === msg.sessionId) {
        dir.active = msg.state === "working";
        dir.branch = msg.branch;
      }
    }
    this.maybeStartSpinner();
    this.invalidate();
    this.tui.requestRender();
  }

  handleSessionsChanged(): void {
    if (!this.readSessionsFn) return;
    this.data = this.readSessionsFn();
    this.filteredToday = this.searchQuery
      ? filterDirs(this.data.today, this.searchQuery)
      : this.data.today;
    this.filteredEarlier = this.searchQuery
      ? filterDirs(this.data.earlier, this.searchQuery)
      : this.data.earlier;
    if (this.cursor >= this.unifiedList.length) {
      this.cursor = Math.max(0, this.unifiedList.length - 1);
    }
    this.ensureCursorVisible();
    this.maybeStartSpinner();
    this.invalidate();
    this.tui.requestRender();
  }

  handleError(msg: ErrorMessage): void {
    this.errorNotification = msg.message;
    this.invalidate();
    this.tui.requestRender();
  }

  private maybeStartSpinner(): void {
    const hasActive = [...this.data.today, ...this.data.earlier].some(
      (dir) => dir.active,
    );
    if (hasActive && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        const stillActive = [...this.data.today, ...this.data.earlier].some(
          (dir) => dir.active,
        );
        if (!stillActive) {
          clearInterval(this.spinnerTimer!);
          this.spinnerTimer = null;
          return;
        }
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
        this.invalidate();
        this.tui.requestRender();
      }, SPINNER_INTERVAL_MS);
    } else if (!hasActive && this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  private get unifiedList(): DirEntry[] {
    return [...this.filteredToday, ...this.filteredEarlier];
  }

  private selectedDir(): DirEntry | null {
    return this.unifiedList[this.cursor] ?? null;
  }

  private openOrExit(dir: DirEntry): void {
    if (this.sessionId && dir.sessionId === this.sessionId) {
      this.onDone();
    } else {
      this.onOpenDir(dir);
    }
  }

  private applyFilter(): void {
    this.filteredToday = filterDirs(this.data.today, this.searchQuery);
    this.filteredEarlier = filterDirs(this.data.earlier, this.searchQuery);
    this.cursor = 0;
    this.earlierScrollOffset = 0;
  }

  handleInput(data: string): void {
    if (this.searchMode) {
      this.handleSearchInput(data);
      return;
    }
    this.handleDirListInput(data);
  }

  private handleDirListInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onDone();
      return;
    }
    if (matchesKey(data, "/")) {
      this.searchMode = true;
      this.searchQuery = "";
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const dir = this.selectedDir();
      if (dir) this.openOrExit(dir);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveCursor(-1);
      this.ensureCursorVisible();
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveCursor(1);
      this.ensureCursorVisible();
      this.requestRender();
      return;
    }
    if (!this.isCursorInEarlier()) return;

    if (matchesKey(data, "d")) {
      const amount = Math.max(1, Math.floor(this.getEarlierVisibleCount() / 2));
      const index = Math.min(
        this.filteredEarlier.length - 1,
        this.cursorEarlierIndex() + amount,
      );
      this.cursor = this.filteredToday.length + index;
      this.earlierScrollOffset = Math.min(
        this.maxEarlierScroll(),
        this.earlierScrollOffset + amount,
      );
      this.requestRender();
      return;
    }
    if (matchesKey(data, "u")) {
      const amount = Math.max(1, Math.floor(this.getEarlierVisibleCount() / 2));
      const index = Math.max(0, this.cursorEarlierIndex() - amount);
      this.cursor = this.filteredToday.length + index;
      this.earlierScrollOffset = Math.max(0, this.earlierScrollOffset - amount);
      this.requestRender();
      return;
    }
    if (matchesKey(data, "g")) {
      this.cursor = this.filteredToday.length;
      this.earlierScrollOffset = 0;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.shift("g"))) {
      this.cursor = this.unifiedList.length - 1;
      this.earlierScrollOffset = this.maxEarlierScroll();
      this.requestRender();
    }
  }

  private handleSearchInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.clearSearch();
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.searchMode = false;
      const dir = this.selectedDir();
      if (dir) this.openOrExit(dir);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveCursor(-1);
      this.ensureCursorVisible();
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveCursor(1);
      this.ensureCursorVisible();
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      if (this.searchQuery.length <= 1) {
        this.clearSearch();
      } else {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this.applyFilter();
      }
      this.requestRender();
      return;
    }

    const printable = this.decodePrintable(data);
    if (printable && /[a-zA-Z0-9\-_./@ {}#~+=]/.test(printable)) {
      this.searchQuery += printable;
      this.applyFilter();
      this.requestRender();
    }
  }

  private decodePrintable(data: string): string | undefined {
    const kittyCharacter = decodeKittyPrintable(data);
    if (kittyCharacter) return kittyCharacter;
    if (data.length === 1) {
      const code = data.charCodeAt(0);
      if (code >= 32 && code <= 126) return data;
    }
    return undefined;
  }

  private clearSearch(): void {
    this.searchMode = false;
    this.searchQuery = "";
    this.filteredToday = this.data.today;
    this.filteredEarlier = this.data.earlier;
    this.cursor = 0;
    this.earlierScrollOffset = 0;
  }

  private requestRender(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  private moveCursor(delta: number): void {
    const length = this.unifiedList.length;
    if (length === 0) return;
    this.cursor = (this.cursor + delta + length) % length;
  }

  private isCursorInEarlier(): boolean {
    return (
      this.cursor >= this.filteredToday.length &&
      this.filteredEarlier.length > 0
    );
  }

  private cursorEarlierIndex(): number {
    return this.cursor - this.filteredToday.length;
  }

  private getEarlierVisibleCount(): number {
    return this.lastRenderedEarlierSlots;
  }

  private maxEarlierScroll(): number {
    return Math.max(
      0,
      this.filteredEarlier.length - this.getEarlierVisibleCount(),
    );
  }

  private ensureCursorVisible(): void {
    if (!this.isCursorInEarlier()) return;
    const index = this.cursorEarlierIndex();
    if (index < this.earlierScrollOffset) {
      this.earlierScrollOffset = index;
    } else if (
      index >=
      this.earlierScrollOffset + this.getEarlierVisibleCount()
    ) {
      this.earlierScrollOffset = index - this.getEarlierVisibleCount() + 1;
    }
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const theme = this.theme;
    const lines: string[] = [];
    const cwdBranchLabel = this.cwdBranch
      ? theme.fg("muted", ` [${this.cwdBranch}]`)
      : "";
    lines.push(
      truncateToWidth(
        theme.fg("accent", theme.bold(" ▶ " + basename(this.cwd))) +
          cwdBranchLabel,
        width,
      ),
    );
    lines.push(truncateToWidth(theme.fg("accent", "═".repeat(width)), width));

    const content: string[] = [theme.fg("dim", "   Today")];
    if (this.filteredToday.length === 0) {
      content.push(theme.fg("dim", "       (none)"));
    } else {
      for (let index = 0; index < this.filteredToday.length; index++) {
        content.push(this.renderDirEntry(index, width));
      }
    }

    content.push("", theme.fg("dim", "   Earlier"));
    const minimumRows = 20;
    this.lastRenderedEarlierSlots = Math.max(1, minimumRows - content.length);
    this.earlierScrollOffset = Math.min(
      this.earlierScrollOffset,
      this.maxEarlierScroll(),
    );

    if (this.filteredEarlier.length === 0) {
      content.push(theme.fg("dim", "       (none)"));
    } else {
      const end = Math.min(
        this.filteredEarlier.length,
        this.earlierScrollOffset + this.lastRenderedEarlierSlots,
      );
      for (let index = this.earlierScrollOffset; index < end; index++) {
        content.push(
          this.renderDirEntry(this.filteredToday.length + index, width),
        );
      }
    }

    while (content.length < minimumRows) content.push("");
    lines.push(...content.map((line) => truncateToWidth(line, width)));
    lines.push(truncateToWidth(theme.fg("dim", "─".repeat(width)), width));
    if (this.errorNotification) {
      lines.push(
        truncateToWidth(
          theme.fg("error", " ⚠ " + this.errorNotification),
          width,
        ),
      );
    }
    lines.push(truncateToWidth(this.renderLegend(), width));

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  private renderDirEntry(unifiedIndex: number, width: number): string {
    const entry = this.unifiedList[unifiedIndex];
    if (!entry) return "";

    const prefix = entry.active
      ? this.theme.fg("accent", SPINNER_FRAMES[this.spinnerFrame]) + " "
      : "  ";
    const branch = entry.branch
      ? this.theme.fg("muted", ` [${entry.branch}]`)
      : "";
    const name = basename(entry.dir);
    const renderedName =
      unifiedIndex === this.cursor
        ? this.theme.fg("accent", "> " + name)
        : "  " + this.theme.fg("text", name);
    return truncateToWidth("   " + prefix + renderedName + branch, width);
  }

  private renderLegend(): string {
    if (this.searchMode) {
      return this.theme.fg(
        "dim",
        ` / ${this.searchQuery}_ • ↑↓ navigate • enter accept • esc clear`,
      );
    }
    if (
      this.isCursorInEarlier() &&
      this.filteredEarlier.length > this.getEarlierVisibleCount()
    ) {
      return this.theme.fg(
        "dim",
        " ↑↓ navigate • d page down • u page up • g top • G bottom • / search • esc quit",
      );
    }
    return this.theme.fg("dim", " ↑↓ navigate • / search • esc quit");
  }
}
