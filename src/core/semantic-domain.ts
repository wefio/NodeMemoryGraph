import { normalizeEventTime } from "./event-time.ts";
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

/** Reject malformed or empty/reversed explicit validity ranges at ingestion.
 *  Date phrases ("2026年11月6日", "上周三") are resolved first, so a stated day
 *  is accepted as the instant it names while genuine garbage is still refused. */
export function assertTemporalValidity(value: TemporalValidity): void {
  const resolved = {
    eventTime: normalizeEventTime(value.eventTime) ?? value.eventTime,
    validFrom: normalizeEventTime(value.validFrom) ?? value.validFrom,
    validUntil: normalizeEventTime(value.validUntil) ?? value.validUntil,
  };
  for (const [name, timestamp] of [
    ["eventTime", resolved.eventTime],
    ["validFrom", resolved.validFrom],
    ["validUntil", resolved.validUntil],
  ] as const) {
    if (timestamp !== undefined && timestamp !== null && !Number.isFinite(Date.parse(timestamp))) {
      throw new Error(`${name} must be a valid timestamp`);
    }
  }
  const interval = temporalInterval(resolved);
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
