import type { MemoryMarker } from "./types.ts";

export function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

/**
 * Statement-level normalization for duplicate detection: NFKC, lowercased,
 * punctuation stripped, whitespace collapsed. Two statements that normalize
 * equal are the same fact written again regardless of surface formatting
 * (case, spacing, trailing punctuation, quotes).
 */
export function normalizeStatement(value: string): string {
  return normalize(value)
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeMarkers(markers: readonly MemoryMarker[] | undefined): MemoryMarker[] {
  if (!markers) return [];
  const normalized = markers.flatMap((marker) => {
    const kind = marker.kind?.trim();
    if (!kind) return [];
    const attributes = marker.attributes
      ? Object.fromEntries(
          Object.entries(marker.attributes)
            .filter(
              ([, value]) =>
                value === null ||
                typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "boolean",
            )
            .sort(([left], [right]) => left.localeCompare(right)),
        )
      : undefined;
    return [{ kind, ...(attributes && Object.keys(attributes).length > 0 ? { attributes } : {}) }];
  });
  return [...new Map(normalized.map((marker) => [JSON.stringify(marker), marker])).values()];
}

const INDEX_MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

/** Derive search-only English and Chinese calendar terms from canonical eventTime. */
export function eventDateIndexText(eventTime: unknown): string {
  if (typeof eventTime !== "string" || !eventTime.trim()) return "";
  const ms = Date.parse(eventTime);
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const monthName = INDEX_MONTHS[month - 1]!;
  return `${year}-${mm}-${dd} ${day} ${monthName} ${year} ${monthName} ${year} ${year}年${month}月${day}日 ${month}月${day}日 ${year}年${month}月`;
}
