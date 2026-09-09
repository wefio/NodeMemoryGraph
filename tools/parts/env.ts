/**
 * Environment part shared by one-off scripts. See `docs/guides/parts.md`.
 */

/**
 * The process environment with undefined values dropped, plus `extra` first —
 * `process.env` wins on collision, which is what the eval scripts rely on when
 * they merge benchmark credentials.
 */
export function definedEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...extra,
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  };
}
