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
