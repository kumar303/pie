/**
 * Open a directory in the user's preferred editor.
 *
 * Mirrors devtree's behaviour: on macOS, well-known GUI editors
 * are launched via `/usr/bin/open -a` so they get a real
 * application context; everywhere else the bare `$EDITOR`
 * binary is invoked with the directory path.
 */

import { spawnSync } from "node:child_process";

const EDITOR_APP_MAP: Record<string, string> = {
  code: "Visual Studio Code",
  "code-insiders": "Visual Studio Code - Insiders",
  codium: "VSCodium",
  cursor: "Cursor",
  zed: "Zed",
  subl: "Sublime Text",
  atom: "Atom",
};

export interface OpenEditorResult {
  ok: boolean;
  /** Description of what was attempted (for logging). */
  attempted: string;
  /** Error or stderr output, when not ok. */
  error?: string;
}

/**
 * Open `dir` in the user's editor. Returns a structured result
 * so callers can decide how to report success/failure (e.g.
 * via `ctx.ui.notify`). Never throws.
 */
export function openInEditor(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): OpenEditorResult {
  const editor = env.EDITOR || "vi";
  const editorBase = editor.split("/").pop() || editor;
  const macApp = platform === "darwin" ? EDITOR_APP_MAP[editorBase] : undefined;

  if (macApp) {
    const r = spawnSync("/usr/bin/open", ["-a", macApp, dir], {
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 10_000,
    });
    if (r.error) {
      return { ok: false, attempted: macApp, error: r.error.message };
    }
    if (r.status !== 0) {
      const detail = (r.stderr || r.stdout || "").trim() || `exit ${r.status}`;
      return { ok: false, attempted: macApp, error: detail };
    }
    return { ok: true, attempted: macApp };
  }

  const r = spawnSync(editor, [dir], {
    cwd: dir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: 10_000,
  });
  if (r.error) {
    return { ok: false, attempted: editor, error: r.error.message };
  }
  if (r.status !== null && r.status !== 0) {
    const detail = (r.stderr || r.stdout || "").trim() || `exit ${r.status}`;
    return { ok: false, attempted: editor, error: detail };
  }
  return { ok: true, attempted: editor };
}
