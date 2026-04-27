/**
 * Small type-narrowing helpers for parsing untrusted JSON.
 *
 * Centralized so the cache and the config store narrow
 * unknown-typed input the same way, and so we never have to
 * reach for a raw `as string[]` cast after a `for…of` runtime
 * check (TypeScript can't track that pattern).
 */

/** Narrow `unknown` to a plain object (Record<string, unknown>). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Assertion function that an `unknown[]` is in fact a
 * `string[]`. Throws on the first non-string entry, naming
 * `path` so the error points at the offending field.
 *
 * Using an assertion function (rather than `arr as string[]`)
 * means callers don't need a cast: TypeScript narrows `arr`
 * structurally after the call.
 */
export function assertStringArray(
  arr: unknown[],
  path: string,
): asserts arr is string[] {
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== "string")
      throw new Error(
        `${path}: entry at index ${i} must be a string (got ${typeof arr[i]})`,
      );
  }
}
