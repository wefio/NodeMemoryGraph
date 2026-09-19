/**
 * The clock the current-value windows are compared against, in one place.
 *
 * A write stamps its validity and expiry from JavaScript (`new Date()`), and a read compares against
 * SQLite's `now`. Those are two clock readers and they disagree at millisecond granularity: measured on
 * this machine, a row stamped `...T02:58:38.468Z` was read back while SQLite's `now` said `...38.467Z`,
 * so `valid_from <= now` was false and a memory written a moment earlier read as "not active" (about one
 * run in 1500, and the reason a product suite failed intermittently under load).
 *
 * A current-value window therefore applies a named grace, and applies it so it can only **widen** the
 * window, never narrow it: a just-written value is current, and a value that expired a clock tick ago
 * still reads as current. The cost is bounded by the constant below and is the same on every read path.
 */
export const CLOCK_GRACE_MS = 50;

/** SQLite's `now` with the grace applied: `later` moves the instant into the future, `earlier` into the
 *  past. Both are ISO-8601 UTC with milliseconds - the format every stored boundary uses - so the
 *  comparison stays lexicographic. The unit is `seconds` with the grace written as a fraction: SQLite's
 *  date functions have no `milliseconds` modifier, and an unknown one makes the whole expression NULL,
 *  which silently excludes every row rather than erroring. */
export function clockNow(direction: "later" | "earlier" = "later"): string {
  const modifier = direction === "later" ? "+" : "-";
  const seconds = (CLOCK_GRACE_MS / 1000).toFixed(3);
  return `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${modifier}${seconds} seconds')`;
}

/** The freshness half of a current-value window for one table alias: not yet expired. Widened into the
 *  past, so a row whose expiry was stamped a clock tick before the read is still current. */
export function notExpired(alias: string): string {
  return `(${alias}.expires_at IS NULL OR ${alias}.expires_at > ${clockNow("earlier")})`;
}

/** The validity half: `valid_from` has already started (widened into the future) and `valid_until` has
 *  not passed (widened into the past). Both are applied together, so the window includes more and never
 *  less - a future-dated value stays excluded, which is what the comparison is for. */
export function currentlyValid(alias: string): string {
  return (
    `((${alias}.valid_from IS NULL OR ${alias}.valid_from <= ${clockNow("later")})` +
    ` AND (${alias}.valid_until IS NULL OR ${alias}.valid_until > ${clockNow("earlier")}))`
  );
}
