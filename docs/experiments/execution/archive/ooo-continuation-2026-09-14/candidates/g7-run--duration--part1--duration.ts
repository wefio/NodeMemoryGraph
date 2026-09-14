// parseDuration(text) reads a duration such as "2s" and returns milliseconds, or null when the
// text is not a duration. This stage covers the single-unit cases: milliseconds and seconds.
// The remaining units and the refusal cases arrive with the next handoff.
export function parseDuration(text: string): number | null {
  if (typeof text !== "string") return null;
  const match = /^([0-9]+(?:\.[0-9]+)?)(ms|s)$/.exec(text);
  if (match === null) return null;
  const magnitude = Number(match[1]);
  const unit = match[2];
  if (unit === "ms") return magnitude;
  return magnitude * 1000;
}
