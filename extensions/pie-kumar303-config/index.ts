/**
 * Pie Config Extension
 *
 * Invoke with `/pie-kumar303-config`. Shows a two-panel UI:
 * - Left: checkbox list of extensions, skills, and themes from this repo
 * - Right: README.md/SKILL.md preview for the highlighted item
 *
 * Pressing Enter applies changes: creates symlinks for newly checked
 * items and removes symlinks for unchecked ones.
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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";

// ─── Public helpers (exported for tests) ─────────────────────────

export type ResourceType = "extension" | "skill" | "theme";

export interface ExtensionInfo {
  name: string;
  path: string;
  readme?: string;
}

export interface ManagedItem extends ExtensionInfo {
  type: ResourceType;
  checked: boolean;
  wasInstalled: boolean;
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
 * Discover Pi skills in the given directory. Skills are directories containing
 * SKILL.md, which Pi can load from ~/.pi/agent/skills when symlinked there.
 */
export function removeSkillFrontmatterRuleFromRenderedMarkdown(
  markdown: string,
  renderedLines: string[],
): string[] {
  if (!markdown.startsWith("---\n")) return renderedLines;
  if (!renderedLines[0]) return renderedLines;

  const firstLine = stripAnsi(renderedLines[0]).trim();
  if (!firstLine || ![...firstLine].every((char) => char === "─")) {
    return renderedLines;
  }

  return renderedLines.slice(1);
}

export function discoverSkills(
  skillsDir: string,
  onError: (message: string) => void,
): ExtensionInfo[] {
  if (!existsSync(skillsDir)) {
    throw new Error(`Skills directory does not exist: ${skillsDir}`);
  }

  const entries = readdirSync(skillsDir, { withFileTypes: true });
  const result: ExtensionInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillPath = join(skillsDir, entry.name);
    const skillMdPath = join(skillPath, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;

    let readme: string | undefined;
    try {
      readme = readFileSync(skillMdPath, "utf-8");
    } catch (err: any) {
      onError(`Failed to read SKILL.md for ${entry.name}: ${err.message}`);
    }

    result.push({ name: entry.name, path: skillPath, readme });
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** Discover Pi theme JSON files in the given directory. */
export function discoverThemes(
  themesDir: string,
  onError: (message: string) => void,
): ExtensionInfo[] {
  if (!existsSync(themesDir)) {
    throw new Error(`Themes directory does not exist: ${themesDir}`);
  }

  const entries = readdirSync(themesDir, { withFileTypes: true });
  const result: ExtensionInfo[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

    const themePath = join(themesDir, entry.name);
    let readme: string | undefined;
    try {
      readme = `\`\`\`json\n${readFileSync(themePath, "utf-8")}\n\`\`\``;
    } catch (err: any) {
      onError(`Failed to read theme ${entry.name}: ${err.message}`);
    }

    result.push({ name: entry.name, path: themePath, readme });
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Check if a resource is installed (symlinked) in its Pi agent directory.
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
function installSymlink(
  name: string,
  extPath: string,
  agentExtDir: string,
  type: "dir" | "file" = "dir",
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
    symlinkSync(extPath, linkPath, type);
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
function removeSymlink(
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

export function installExtension(
  name: string,
  extPath: string,
  agentExtDir: string,
): string | null {
  return installSymlink(name, extPath, agentExtDir);
}

export function removeExtension(
  name: string,
  extPath: string,
  agentExtDir: string,
): string | null {
  return removeSymlink(name, extPath, agentExtDir);
}

export function installSkill(
  name: string,
  skillPath: string,
  agentSkillsDir: string,
): string | null {
  return installSymlink(name, skillPath, agentSkillsDir);
}

export function removeSkill(
  name: string,
  skillPath: string,
  agentSkillsDir: string,
): string | null {
  return removeSymlink(name, skillPath, agentSkillsDir);
}

export function installTheme(
  name: string,
  themePath: string,
  agentThemesDir: string,
): string | null {
  return installSymlink(name, themePath, agentThemesDir, "file");
}

export function removeTheme(
  name: string,
  themePath: string,
  agentThemesDir: string,
): string | null {
  return removeSymlink(name, themePath, agentThemesDir);
}

export function formatChooserLeftLines(
  items: ManagedItem[],
  cursor = -1,
  decorate?: (line: string, item: ManagedItem, index: number) => string,
): string[] {
  const lines: string[] = [];

  for (const type of ["extension", "skill", "theme"] satisfies ResourceType[]) {
    const group = items.filter((item) => item.type === type);
    if (group.length === 0) continue;

    const heading = {
      extension: "Extensions",
      skill: "Skills",
      theme: "Themes",
    }[type];
    lines.push(heading);
    for (const item of group) {
      const index = items.indexOf(item);
      const checkbox = item.checked ? "☑" : "☐";
      const prefix = index === cursor ? "▸ " : "  ";
      const line = `${prefix}${checkbox} ${item.name}`;
      lines.push(decorate ? decorate(line, item, index) : line);
    }
  }

  return lines;
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

function getRepoExtensionsDir(): string {
  // Walk up from this file to find the repo root extensions dir
  // This file is at extensions/pie-kumar303-config/index.ts
  return resolve(dirname(new URL(import.meta.url).pathname), "..");
}

function getRepoSkillsDir(): string {
  return resolve(getRepoExtensionsDir(), "..", "skills");
}

function getRepoThemesDir(): string {
  return resolve(getRepoExtensionsDir(), "..", "themes");
}

function getAgentExtensionsDir(): string {
  return join(homedir(), ".pi", "agent", "extensions");
}

function getAgentSkillsDir(): string {
  return join(homedir(), ".pi", "agent", "skills");
}

function getAgentThemesDir(): string {
  return join(homedir(), ".pi", "agent", "themes");
}

export interface PieConfigPaths {
  repoExtensionsDir: string;
  repoSkillsDir: string;
  repoThemesDir: string;
  agentExtensionsDir: string;
  agentSkillsDir: string;
  agentThemesDir: string;
}

export function registerPieConfig(
  pi: ExtensionAPI,
  paths: PieConfigPaths,
): void {
  pi.registerCommand("pie-kumar303-config", {
    description: "Manage pie-kumar303 resource symlinks",
    handler: async (_args, ctx) => {
      const repoExtDir = paths.repoExtensionsDir;
      const repoSkillsDir = paths.repoSkillsDir;
      const repoThemesDir = paths.repoThemesDir;
      const agentExtDir = paths.agentExtensionsDir;
      const agentSkillsDir = paths.agentSkillsDir;
      const agentThemesDir = paths.agentThemesDir;
      const extensions = discoverExtensions(repoExtDir, (err) =>
        ctx.ui.notify(err, "error"),
      );
      const skills = discoverSkills(repoSkillsDir, (err) =>
        ctx.ui.notify(err, "error"),
      );
      const themes = discoverThemes(repoThemesDir, (err) =>
        ctx.ui.notify(err, "error"),
      );

      if (
        extensions.length === 0 &&
        skills.length === 0 &&
        themes.length === 0
      ) {
        ctx.ui.notify(
          "No extensions, skills, or themes found in this repo.",
          "info",
        );
        return;
      }

      const items: ManagedItem[] = [
        ...extensions.map((ext) => {
          const installed = getInstallState(ext.name, ext.path, agentExtDir);
          return {
            name: ext.name,
            path: ext.path,
            readme: ext.readme,
            type: "extension" as const,
            checked: installed,
            wasInstalled: installed,
          };
        }),
        ...skills.map((skill) => {
          const installed = getInstallState(
            skill.name,
            skill.path,
            agentSkillsDir,
          );
          return {
            name: skill.name,
            path: skill.path,
            readme: skill.readme,
            type: "skill" as const,
            checked: installed,
            wasInstalled: installed,
          };
        }),
        ...themes.map((theme) => {
          const installed = getInstallState(
            theme.name,
            theme.path,
            agentThemesDir,
          );
          return {
            name: theme.name,
            path: theme.path,
            readme: theme.readme,
            type: "theme" as const,
            checked: installed,
            wasInstalled: installed,
          };
        }),
      ];

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
                      " https://github.com/kumar303/pie - manage extensions, skills & themes",
                    ),
                  ),
                  width,
                ),
              );
              lines.push(
                truncateToWidth(theme.fg("dim", "─".repeat(width)), width),
              );

              // Build left panel lines
              const leftLines = formatChooserLeftLines(
                items,
                cursor,
                (line, _item, index) => {
                  if (index === cursor) {
                    return theme.fg("accent", theme.bold(line));
                  }
                  return line;
                },
              ).map((line) => truncateToWidth(line, leftWidth));

              // Build right panel lines (README/SKILL.md preview)
              const currentItem = items[cursor];
              let rightLines: string[] = [];

              if (currentItem?.readme) {
                const md = getMarkdownComponent(
                  currentItem.readme,
                  currentItem.name,
                );
                if (md) {
                  const rendered = md.render(rightWidth);
                  rightLines =
                    currentItem.type === "skill"
                      ? removeSkillFrontmatterRuleFromRenderedMarkdown(
                          currentItem.readme,
                          rendered,
                        )
                      : rendered;
                }
              } else {
                rightLines = [theme.fg("dim", "(no preview)")];
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
        const actions = {
          extension: {
            install: installExtension,
            remove: removeExtension,
            targetDir: agentExtDir,
          },
          skill: {
            install: installSkill,
            remove: removeSkill,
            targetDir: agentSkillsDir,
          },
          theme: {
            install: installTheme,
            remove: removeTheme,
            targetDir: agentThemesDir,
          },
        }[item.type];

        if (item.checked && !item.wasInstalled) {
          const err = actions.install(item.name, item.path, actions.targetDir);
          if (err) {
            errors.push(err);
          } else {
            installed++;
          }
        } else if (!item.checked && item.wasInstalled) {
          const err = actions.remove(item.name, item.path, actions.targetDir);
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
            "Resources changed. Reload now to activate?",
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

export default function (pi: ExtensionAPI): void {
  registerPieConfig(pi, {
    repoExtensionsDir: getRepoExtensionsDir(),
    repoSkillsDir: getRepoSkillsDir(),
    repoThemesDir: getRepoThemesDir(),
    agentExtensionsDir: getAgentExtensionsDir(),
    agentSkillsDir: getAgentSkillsDir(),
    agentThemesDir: getAgentThemesDir(),
  });
}

/**
 * Compute visible width of a string (ANSI-aware).
 * Inline to avoid importing from pi-tui at module level for tests.
 */
function visibleWidthOf(s: string): number {
  return stripAnsi(s).length;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
