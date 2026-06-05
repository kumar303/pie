import { execFile } from "node:child_process";

/**
 * Copy text to the system clipboard. Uses pbcopy on macOS, xclip on Linux.
 */
export async function copyToClipboard(text: string): Promise<void> {
  const cmd = process.platform === "darwin" ? "pbcopy" : "xclip";
  const args = process.platform === "darwin" ? [] : ["-selection", "clipboard"];

  return new Promise((resolve, reject) => {
    const proc = execFile(cmd, args, (err) => {
      if (err) reject(err);
      else resolve();
    });
    proc.stdin?.write(text);
    proc.stdin?.end();
  });
}
