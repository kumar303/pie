/**
 * Small utilities shared across server and extension client.
 */

/** Promise-based setTimeout, in milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build a stateful accumulator that splits a stream of raw chunks
 * into newline-delimited lines. Blank lines are dropped. Used on
 * both sides of the IPC channel to assemble NDJSON frames.
 *
 * @example
 *   const framer = createLineFramer();
 *   socket.on("data", (chunk) => {
 *     for (const line of framer(chunk.toString())) handle(line);
 *   });
 */
export function createLineFramer(): (chunk: string) => string[] {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) lines.push(line);
    }
    return lines;
  };
}
