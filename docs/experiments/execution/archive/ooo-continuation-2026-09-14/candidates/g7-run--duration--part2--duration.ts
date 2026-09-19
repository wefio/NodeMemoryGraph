// parseDuration(text) reads a duration such as "2s" and returns milliseconds, or null when the
// text is not a duration. This covers the single-unit cases (ms, s) and the sequential h/m/s
// forms such as "1h2m3s", plus the refusals: empty text, a bare number, or an unknown unit
// such as "1x". The result is always a number or null, never NaN.
export function parseDuration(text: string): number | null {
  if (typeof text !== "string") return null;

  // Sticky matcher: every token must begin exactly where the previous one ended, so the only
  // accepted shape is a contiguous run of number+unit tokens that consumes the whole string.
  const token = /([0-9]+(?:\.[0-9]+)?)(ms|h|m|s)/y;

  let total = 0;
  let index = 0;
  let previousRank = Number.POSITIVE_INFINITY;

  while (index < text.length) {
    token.lastIndex = index;
    const match = token.exec(text);
    if (match === null) return null;

    const rank = unitRank(match[2]);
    // Units must walk outward -> inward (h, m, s, ms); a repeat or an out-of-order unit is
    // refused, which keeps them in h, m, s order.
    if (rank >= previousRank) return null;
    previousRank = rank;

    total += Number(match[1]) * unitMilliseconds(match[2]);
    index = token.lastIndex;
  }

  // No token at all (empty text) or leftover text that was not a number+unit segment.
  if (index === 0 || index !== text.length) return null;
  return total;
}

function unitRank(unit: string): number {
  if (unit === "h") return 3;
  if (unit === "m") return 2;
  if (unit === "s") return 1;
  return 0; // "ms"
}

function unitMilliseconds(unit: string): number {
  if (unit === "h") return 3600000;
  if (unit === "m") return 60000;
  if (unit === "s") return 1000;
  return 1; // "ms"
}
