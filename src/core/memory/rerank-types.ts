import type { MemoryMarker } from "../types.ts";

export interface RerankCandidate {
  readonly id: string;
  readonly statement: string;
  readonly combinedScore: number;
  readonly eventTime: string | null;
  readonly createdAt?: string;
  readonly sessionId: string | null;
  readonly nodeId: string;
  readonly evidenceId?: string;
  readonly turnOrdinal?: number | null;
  readonly markers?: readonly MemoryMarker[];
  readonly stateKey?: string | null;
  readonly predicateKey?: string | null;
  readonly supersedesId?: string | null;
  readonly relatedMemoryIds?: readonly string[];
}

export interface ScoredCandidateId {
  readonly id: string;
  readonly score: number;
}

export interface RerankContext {
  readonly queryText: string;
  readonly candidates: readonly RerankCandidate[];
  readonly sessionKeyOf?: (candidate: RerankCandidate) => string;
}

export interface RerankCandidateIndex {
  readonly byId: ReadonlyMap<string, RerankCandidate>;
  readonly timestampMs: ReadonlyMap<string, number | null>;
  readonly maxTimestampMs: number;
  readonly maxTurnOrdinal: number;
  eventDays(): ReadonlyMap<string, string | null>;
}

const RERANK_INDEX_CACHE = new WeakMap<readonly RerankCandidate[], RerankCandidateIndex>();

export function compareScored(left: ScoredCandidateId, right: ScoredCandidateId): number {
  return right.score - left.score || (left.id < right.id ? -1 : Number(left.id > right.id));
}

export function baseScored(candidates: readonly RerankCandidate[]): ScoredCandidateId[] {
  return candidates
    .map((candidate) => ({ id: candidate.id, score: candidate.combinedScore }))
    .sort(compareScored);
}

export function inputScored(
  inputs: Readonly<Record<string, unknown>>,
  candidates: readonly RerankCandidate[],
): ScoredCandidateId[] {
  const raw = inputs.default;
  if (Array.isArray(raw)) return raw as ScoredCandidateId[];
  return baseScored(candidates);
}

export function numParam(
  params: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseCandidateTimestampMs(candidate: RerankCandidate): number | null {
  const raw = candidate.eventTime ?? candidate.createdAt;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Lazily build and memoize a shared index over `context.candidates` (WeakMap by array identity)
 * so multi-operator rerank DAGs parse timestamps and build `byId` lookup tables once.
 */
export function getRerankCandidateIndex(
  candidates: readonly RerankCandidate[],
): RerankCandidateIndex {
  const cached = RERANK_INDEX_CACHE.get(candidates);
  if (cached) return cached;

  const byId = new Map<string, RerankCandidate>();
  const timestampMs = new Map<string, number | null>();
  let maxMs = 0;
  let maxOrd = 0;

  for (const candidate of candidates) {
    byId.set(candidate.id, candidate);
    const ms = parseCandidateTimestampMs(candidate);
    timestampMs.set(candidate.id, ms);
    if (ms !== null && ms > maxMs) maxMs = ms;
    if (
      typeof candidate.turnOrdinal === "number" &&
      Number.isFinite(candidate.turnOrdinal) &&
      candidate.turnOrdinal > maxOrd
    ) {
      maxOrd = candidate.turnOrdinal;
    }
  }

  let dayMap: Map<string, string | null> | undefined;
  const index: RerankCandidateIndex = {
    byId,
    timestampMs,
    maxTimestampMs: maxMs,
    maxTurnOrdinal: maxOrd,
    eventDays: () => {
      if (dayMap) return dayMap;
      dayMap = new Map<string, string | null>();
      for (const candidate of candidates) {
        if (!candidate.eventTime) {
          dayMap.set(candidate.id, null);
          continue;
        }
        const parsed = Date.parse(candidate.eventTime);
        dayMap.set(
          candidate.id,
          Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null,
        );
      }
      return dayMap;
    },
  };
  RERANK_INDEX_CACHE.set(candidates, index);
  return index;
}
