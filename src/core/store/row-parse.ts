/**
 * Lenient decoders for JSON-encoded SQLite columns.
 *
 * Several columns hold JSON arrays rather than normalized rows. Malformed or
 * absent values decode to an empty array instead of throwing: a corrupt
 * denormalized column should degrade one record, not break the read path for
 * every query touching that table.
 */

export function parseStringArray(value: string | number | Uint8Array | null): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/** Lenient numeric-array decoder (e.g. perf_aggregates.buckets_json). */
export function parseNumberArray(value: string | number | Uint8Array | null): number[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
      : [];
  } catch {
    return [];
  }
}
