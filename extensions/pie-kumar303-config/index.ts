/**
 * Pie Config Extension
 *
 * Invoke with `/pie-kumar303-config`. Shows a two-panel UI:
 * - Left: checkbox list of extensions from this repo
 * - Right: README.md preview for the highlighted extension
 *
 * Pressing Enter applies changes: creates symlinks for newly checked
 * extensions and removes symlinks for unchecked ones.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import {
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
} from "@mariozechner/pi-tui";

// ─── Public helpers (exported for tests) ─────────────────────────

export interface ExtensionInfo {
  name: string;
  path: string;
  readme?: string;
}

const CONFIG_EXT_NAME = "pie-kumar303-config";

/**
 * Discover extensions in the given directory, excluding the config extension.
 */
export function discoverExtensions(
  extensionsDir: string,
  onError: (message: string) => void,
): ExtensionInfo[] {
  if (!existsSync(extensionsDir)) {
    throw new Error(`Extensions directory does not exist: ${extensionsDir}`);
  }

  const entries = readdirSync(extensionsDir, { withFileTypes: true });
  const result: ExtensionInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === CONFIG_EXT_NAME) continue;

    const extPath = join(extensionsDir, entry.name);
    const readmePath = join(extPath, "README.md");
    let readme: string | undefined;
    try {
      if (existsSync(readmePath)) {
        readme = readFileSync(readmePath, "utf-8");
      }
    } catch (err: any) {
      onError(`Failed to read README for ${entry.name}: ${err.message}`);
    }

    result.push({ name: entry.name, path: extPath, readme });
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Check if an extension is installed (symlinked) in the agent extensions dir.
 * Returns true only if a symlink exists AND points to the given extPath.
 */
export function getInstallState(
  name: string,
  extPath: string,
  agentExtDir: string,
): boolean {
  const linkPath = join(agentExtDir, name);
  if (!lstatExistsSafe(linkPath)) return false;
  const stat = lstatSync(linkPath);
  if (!stat.isSymbolicLink()) return false;
  const target = readlinkSync(linkPath);
  const absoluteTarget = resolve(dirname(linkPath), target);
  return absoluteTarget === resolve(extPath);
}

/**
 * Install an extension by creating a symlink.
 * Returns null on success or an error message string.
 */
export function installExtension(
  name: string,
  extPath: string,
  agentExtDir: string,
): string | null {
  const linkPath = join(agentExtDir, name);

  // Ensure parent directory exists
  if (!existsSync(agentExtDir)) {
    try {
      mkdirSync(agentExtDir, { recursive: true });
    } catch (err: any) {
      return `${name}: failed to create directory: ${err.message}`;
    }
  }

  // Handle existing path
  if (existsSync(linkPath) || lstatExistsSafe(linkPath)) {
    try {
      const stat = lstatSync(linkPath);
      if (!stat.isSymbolicLink()) {
        return `${name}: ${linkPath} already exists and is not a symlink. Manual cleanup required.`;
      }
      // Remove existing symlink (may point elsewhere)
      unlinkSync(linkPath);
    } catch (err: any) {
      return `${name}: failed to check/remove existing path: ${err.message}`;
    }
  }

  try {
    symlinkSync(extPath, linkPath, "dir");
    return null;
  } catch (err: any) {
    return `${name}: failed to create symlink: ${err.message}`;
  }
}

/**
 * Remove an extension symlink. Only removes if it's a symlink pointing
 * to the expected extPath (from this repo).
 * Returns null on success or an error message string.
 */
export function removeExtension(
  name: string,
  extPath: string,
  agentExtDir: string,
): string | null {
  const linkPath = join(agentExtDir, name);

  if (!lstatExistsSafe(linkPath)) {
    return null; // Already gone
  }

  try {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      return `${name}: ${linkPath} is not a symlink. Manual cleanup required.`;
    }

    const target = readlinkSync(linkPath);
    const absoluteTarget = resolve(dirname(linkPath), target);
    if (absoluteTarget !== resolve(extPath)) {
      return `${name}: symlink points to a different location (${absoluteTarget}). Refusing to remove.`;
    }

    unlinkSync(linkPath);
    return null;
  } catch (err: any) {
    return `${name}: failed to remove symlink: ${err.message}`;
  }
}

/** lstatSync but returns false instead of throwing on ENOENT */
function lstatExistsSafe(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// ─── TUI Component ───────────────────────────────────────────────

interface ExtState {
  name: string;
  path: string;
  readme?: string;
  checked: boolean;
  wasInstalled: boolean; // original state on load
}

function getRepoExtensionsDir(): string {
  // Walk up from this file to find the repo root extensions dir
  // This file is at extensions/pie-kumar303-config/index.ts
  return resolve(dirname(new URL(import.meta.url).pathname), "..");
}

function getAgentExtensionsDir(): string {
  return join(homedir(), ".pi", "agent", "extensions");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pie-kumar303-config", {
    description: "Manage pie-kumar303 extension symlinks",
    handler: async (_args, ctx) => {
      const repoExtDir = getRepoExtensionsDir();
      const agentExtDir = getAgentExtensionsDir();
      const extensions = discoverExtensions(repoExtDir, (err) =>
        ctx.ui.notify(err, "error"),
      );

      if (extensions.length === 0) {
        ctx.ui.notify("No extensions found in this repo.", "info");
        return;
      }

      const items: ExtState[] = extensions.map((ext) => {
        const installed = getInstallState(ext.name, ext.path, agentExtDir);
        return {
          name: ext.name,
          path: ext.path,
          readme: ext.readme,
          checked: installed,
          wasInstalled: installed,
        };
      });

      const hasChanges = await ctx.ui.custom<boolean>(
        (tui, theme, _kb, done) => {
          let cursor = 0;
          let readmeScroll = 0;
          let _cachedWidth = 0;
          let _cachedLines: string[] = [];
          let mdComponent: Markdown | null = null;
          let mdCachedName: string | null = null;

          function getMarkdownComponent(
            readme: string | undefined,
            name: string,
          ): Markdown | null {
            if (!readme) return null;
            if (mdCachedName === name && mdComponent) return mdComponent;
            mdComponent = new Markdown(readme, 0, 0, getMarkdownTheme());
            mdCachedName = name;
            return mdComponent;
          }

          return {
            render(width: number): string[] {
              const termHeight = Math.max(10, (process.stdout.rows || 40) - 6);
              const leftWidth = Math.min(
                Math.max(30, Math.floor(width * 0.35)),
                50,
              );
              const rightWidth = width - leftWidth - 3; // 3 for " │ "
              const lines: string[] = [];

              // Header
              lines.push(
                truncateToWidth(
                  theme.fg(
                    "accent",
                    theme.bold(
                      " https://github.com/kumar303/pie - manage extensions",
                    ),
                  ),
                  width,
                ),
              );
              lines.push(
                truncateToWidth(theme.fg("dim", "─".repeat(width)), width),
              );

              // Build left panel lines
              const leftLines: string[] = [];
              for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const isCursor = i === cursor;
                const checkbox = item.checked ? "☑" : "☐";
                const label = `${checkbox} ${item.name}`;

                let line: string;
                if (isCursor) {
                  line = theme.fg("accent", theme.bold(`▸ ${label}`));
                } else {
                  line = `  ${label}`;
                }
                leftLines.push(truncateToWidth(line, leftWidth));
              }

              // Build right panel lines (README preview)
              const currentItem = items[cursor];
              let rightLines: string[] = [];

              if (currentItem?.readme) {
                const md = getMarkdownComponent(
                  currentItem.readme,
                  currentItem.name,
                );
                if (md) {
                  const rendered = md.render(rightWidth);
                  rightLines = rendered;
                }
              } else {
                rightLines = [theme.fg("dim", "(no README.md)")];
              }

              // Clamp scroll
              const contentHeight = termHeight - 4; // header + footer
              const maxScroll = Math.max(0, rightLines.length - contentHeight);
              if (readmeScroll > maxScroll) readmeScroll = maxScroll;
              const visibleRight = rightLines.slice(
                readmeScroll,
                readmeScroll + contentHeight,
              );

              // Combine panels
              const panelHeight = contentHeight;
              for (let i = 0; i < panelHeight; i++) {
                const left = truncateToWidth(leftLines[i] || "", leftWidth);
                const leftPad =
                  left +
                  " ".repeat(Math.max(0, leftWidth - visibleWidthOf(left)));
                const right = truncateToWidth(
                  visibleRight[i] || "",
                  rightWidth,
                );
                lines.push(
                  truncateToWidth(
                    `${leftPad} ${theme.fg("dim", "│")} ${right}`,
                    width,
                  ),
                );
              }

              // Footer
              lines.push(
                truncateToWidth(theme.fg("dim", "─".repeat(width)), width),
              );

              // Scroll indicator
              let scrollInfo = "";
              if (rightLines.length > contentHeight) {
                const pct = Math.round(
                  ((readmeScroll + contentHeight) / rightLines.length) * 100,
                );
                scrollInfo = ` ${Math.min(pct, 100)}%`;
              }

              const hints =
                theme.fg("dim", " ↑↓ navigate") +
                theme.fg("dim", " • space toggle") +
                theme.fg("dim", " • g/G top/bottom") +
                theme.fg("dim", " • d/u page") +
                theme.fg("dim", " • enter install selected") +
                theme.fg("dim", " • esc cancel") +
                theme.fg("dim", scrollInfo);
              lines.push(truncateToWidth(hints, width));

              _cachedWidth = width;
              _cachedLines = lines;
              return lines;
            },

            handleInput(data: string): void {
              const contentHeight = Math.max(
                10,
                (process.stdout.rows || 40) - 6,
              );

              // Escape → cancel
              if (matchesKey(data, Key.escape)) {
                done(false);
                return;
              }

              // Enter → apply
              if (matchesKey(data, Key.enter)) {
                done(true);
                return;
              }

              // Navigation
              if (matchesKey(data, Key.up)) {
                if (cursor > 0) {
                  cursor--;
                  readmeScroll = 0;
                  mdCachedName = null;
                }
                tui.requestRender();
                return;
              }
              if (matchesKey(data, Key.down)) {
                if (cursor < items.length - 1) {
                  cursor++;
                  readmeScroll = 0;
                  mdCachedName = null;
                }
                tui.requestRender();
                return;
              }

              // Space → toggle checkbox
              if (matchesKey(data, Key.space)) {
                items[cursor].checked = !items[cursor].checked;
                tui.requestRender();
                return;
              }

              // Readme scroll: g = top, G = bottom, d = page down, u = page up
              if (matchesKey(data, "g")) {
                readmeScroll = 0;
                tui.requestRender();
                return;
              }
              if (matchesKey(data, Key.shift("g"))) {
                readmeScroll = Infinity; // clamped in render
                tui.requestRender();
                return;
              }
              if (matchesKey(data, "d")) {
                readmeScroll += contentHeight;
                tui.requestRender();
                return;
              }
              if (matchesKey(data, "u")) {
                readmeScroll = Math.max(0, readmeScroll - contentHeight);
                tui.requestRender();
                return;
              }
            },

            invalidate(): void {
              _cachedWidth = 0;
              _cachedLines = [];
              mdCachedName = null;
              mdComponent = null;
            },
          };
        },
      );

      if (!hasChanges) return;

      // Apply changes
      const errors: string[] = [];
      let installed = 0;
      let removed = 0;

      for (const item of items) {
        if (item.checked && !item.wasInstalled) {
          const err = installExtension(item.name, item.path, agentExtDir);
          if (err) {
            errors.push(err);
          } else {
            installed++;
          }
        } else if (!item.checked && item.wasInstalled) {
          const err = removeExtension(item.name, item.path, agentExtDir);
          if (err) {
            errors.push(err);
          } else {
            removed++;
          }
        }
      }

      if (errors.length > 0) {
        ctx.ui.notify(
          `Errors:\n${errors.map((e) => `  ✗ ${e}`).join("\n")}`,
          "error",
        );
      }

      if (installed > 0 || removed > 0) {
        const parts: string[] = [];
        if (installed > 0) parts.push(`✓ Installed ${installed}`);
        if (removed > 0) parts.push(`✓ Removed ${removed}`);
        ctx.ui.notify(parts.join(", "), "info");

        if (
          await ctx.ui.confirm(
            "Reload",
            "Extensions changed. Reload now to activate?",
          )
        ) {
          await ctx.reload();
        }
      } else {
        ctx.ui.notify("No changes.", "info");
      }
    },
  });
}

/**
 * Compute visible width of a string (ANSI-aware).
 * Inline to avoid importing from pi-tui at module level for tests.
 */
function visibleWidthOf(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
