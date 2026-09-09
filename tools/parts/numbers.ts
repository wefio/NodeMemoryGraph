/**
 * Integer-parsing parts shared by one-off scripts and gates.
 *
 * The eval scripts had three different helpers called `positiveInteger`. Two of
 * them are real parts; the third — truncate a number, fall back when it is absent
 * — has a single caller and stays where it is.
 */

/**
 * Strict: `value` must be a positive integer or this throws. `Number` is used
 * rather than `parseInt`, so `"12abc"` is rejected instead of silently read as 12.
 */
export function requirePositiveInteger(value: string | number, label = "value"): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer, received: ${JSON.stringify(value)}`);
  }
  return parsed;
}

/** Lenient: parse a positive integer, or use `fallback` when it is missing or invalid. */
export function positiveIntegerOr(text: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(text ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
