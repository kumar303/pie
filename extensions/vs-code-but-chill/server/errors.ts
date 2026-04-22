/**
 * Shared helpers for error formatting and out-of-band reporting.
 *
 * The server has a rich log file (`LogWriter`) and prefers logging
 * there, but several subsystems (the log writer itself, the registry,
 * and IPC parsers) can't reach into the LogWriter without risking
 * re-entrancy or losing the "log-the-log-failure" case. Those sites
 * fall back to `process.stderr` with a consistent prefix.
 */

/** Read the `code` field off a Node error-like value, if present. */
export function errCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    if (typeof err.code === "string") return err.code;
  }
  return undefined;
}

/** Extract a readable message from anything thrown. */
export function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    if (typeof err.message === "string" && err.message) return err.message;
  }
  return String(err);
}

/** Prefix used on every out-of-band stderr line. */
export const STDERR_PREFIX = "[vs-code-but-chill]";

/** Report an unexpected error to stderr with a consistent prefix. */
export function reportStderr(context: string, err: unknown): void {
  process.stderr.write(`${STDERR_PREFIX} ${context}: ${errMessage(err)}\n`);
}

/**
 * Report an unexpected error via `console.error` with a consistent
 * prefix. Used from the extension-side client where pi captures
 * console output, unlike the detached server which uses stderr.
 */
export function reportConsole(context: string, err: unknown): void {
  console.error(`${STDERR_PREFIX} ${context}: ${errMessage(err)}`);
}
