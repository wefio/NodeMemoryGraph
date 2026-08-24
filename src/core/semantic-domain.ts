import type { MemoryScope } from "./types.ts";

export interface TemporalValidity {
  eventTime?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
}

/**
 * Scope objects are conjunctions of exact key/value constraints. Their
 * intersection exists unless a key constrained by both sides disagrees.
 */
export function intersectScopes(left: MemoryScope, right: MemoryScope): MemoryScope | null {
  for (const [key, value] of Object.entries(left)) {
    if (right[key] !== undefined && right[key] !== value) return null;
  }
  return { ...left, ...right };
}

export function scopesOverlap(left: MemoryScope, right: MemoryScope): boolean {
  return intersectScopes(left, right) !== null;
}

/** Half-open validity: [validFrom, validUntil). Missing ends are unbounded. */
export function validityIntervalsOverlap(left: TemporalValidity, right: TemporalValidity): boolean {
  const a = temporalInterval(left);
  const b = temporalInterval(right);
  if (!a || !b) return false;
  return a.start < b.end && b.start < a.end;
}

/** Reject malformed or empty/reversed explicit validity ranges at ingestion. */
export function assertTemporalValidity(value: TemporalValidity): void {
  for (const [name, timestamp] of [
    ["eventTime", value.eventTime],
    ["validFrom", value.validFrom],
    ["validUntil", value.validUntil],
  ] as const) {
    if (timestamp !== undefined && timestamp !== null && !Number.isFinite(Date.parse(timestamp))) {
      throw new Error(`${name} must be a valid timestamp`);
    }
  }
  const interval = temporalInterval(value);
  if (!interval) throw new Error("validFrom must be earlier than validUntil");
}

function temporalInterval(value: TemporalValidity): { start: number; end: number } | null {
  const start = parseBoundary(value.validFrom, Number.NEGATIVE_INFINITY);
  const end = parseBoundary(value.validUntil, Number.POSITIVE_INFINITY);
  if (start === null || end === null || start >= end) return null;
  return { start, end };
}

function parseBoundary(value: string | null | undefined, fallback: number): number | null {
  if (value === undefined || value === null) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
