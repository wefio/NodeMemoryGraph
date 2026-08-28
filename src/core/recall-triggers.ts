import type { MemoryMarker } from "./types.ts";

export const RECALL_TRIGGER_MARKER = "recall_trigger";
export const LEGACY_RECALL_TRIGGER_MARKER = "retrieveHint";
export const MAX_RECALL_TRIGGERS = 16;
export const MAX_RECALL_TRIGGER_CHARACTERS = 80;

/**
 * Explicit recall triggers are short aliases or likely query phrases. They are
 * retrieval metadata, never part of the factual statement.
 */
export function normalizeRecallTriggers(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  if (values.length > MAX_RECALL_TRIGGERS) {
    throw new Error(`recallTriggers must contain at most ${MAX_RECALL_TRIGGERS} entries`);
  }
  const normalized = new Map<string, string>();
  for (const value of values) {
    if (typeof value !== "string") throw new Error("recallTriggers entries must be strings");
    const trigger = value.replace(/\s+/gu, " ").trim();
    if (!trigger) throw new Error("recallTriggers entries must not be empty");
    if (trigger.length > MAX_RECALL_TRIGGER_CHARACTERS) {
      throw new Error(
        `recallTriggers entries must not exceed ${MAX_RECALL_TRIGGER_CHARACTERS} characters`,
      );
    }
    const key = trigger.toLocaleLowerCase();
    if (!normalized.has(key)) normalized.set(key, trigger);
  }
  return [...normalized.values()];
}

export function recallTriggerMarkers(values: readonly string[] | undefined): MemoryMarker[] {
  return normalizeRecallTriggers(values).map((value) => ({
    kind: RECALL_TRIGGER_MARKER,
    attributes: { value },
  }));
}

/** Reads both the canonical marker and the pre-existing feedback marker. */
export function recallTriggersFromMarkers(markers: readonly MemoryMarker[]): string[] {
  return normalizeRecallTriggers(
    markers.flatMap((marker) => {
      if (marker.kind !== RECALL_TRIGGER_MARKER && marker.kind !== LEGACY_RECALL_TRIGGER_MARKER) {
        return [];
      }
      const value = marker.attributes?.value;
      return typeof value === "string" ? [value] : [];
    }),
  );
}

export function recallTriggersFromStoredMarkers(value: unknown): string[] {
  if (value == null) return [];
  try {
    const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
    return Array.isArray(parsed)
      ? recallTriggersFromMarkers(
          parsed.filter(
            (marker): marker is MemoryMarker =>
              Boolean(marker) &&
              typeof marker === "object" &&
              typeof (marker as { kind?: unknown }).kind === "string",
          ),
        )
      : [];
  } catch {
    return [];
  }
}
