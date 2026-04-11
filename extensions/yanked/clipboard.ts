/**
 * Cross-platform clipboard write utility.
 */

import { execSync } from "node:child_process";

/**
 * Copy text to the system clipboard.
 * Throws on failure.
 */
export function copyToClipboard(
  text: string,
  exec: (cmd: string, opts: { input: string }) => void = (cmd, opts) =>
    execSync(cmd, { input: opts.input, stdio: ["pipe", "pipe", "pipe"] }),
): void {
  const platform = process.platform;
  if (platform === "darwin") {
    exec("pbcopy", { input: text });
  } else if (platform === "win32") {
    exec("clip", { input: text });
  } else {
    // Linux: try xclip, fall back to xsel
    try {
      exec("xclip -selection clipboard", { input: text });
    } catch {
      exec("xsel --clipboard --input", { input: text });
    }
  }
}
