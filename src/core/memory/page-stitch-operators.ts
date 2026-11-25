import type { MemoryRecord, MemorySearchResult } from "../types.ts";
import { rankLocalLogOdds } from "./local-log-odds.ts";
import type { RerankCandidate } from "./piecewise-rerank.ts";

export interface DualChannelCandidateInput {
  readonly memory: MemoryRecord;
  readonly bm25?: number;
  readonly vectorScore?: number;
}

/** True when a search result was injected as an adjacent source dialogue turn. */
export function isAdjacentTurnResult(result: MemorySearchResult): boolean {
  return result.neighborhood === "previous_turn" || result.neighborhood === "next_turn";
}

/** True when a search result belongs to the supplemental tail slot category. */
export function isSupplementalTailResult(result: MemorySearchResult): boolean {
  return isAdjacentTurnResult(result) || result.neighborhood === "due_today";
}

/** Cap a supplemental item's combinedScore strictly below the primary floor score. */
export function capScoreBelowFloor(
  score: number,
  floor: number | undefined,
  index: number,
): number {
  if (floor === undefined) return score;
  return Math.min(score, Math.max(0, floor - (index + 1) * 1e-6));
}

/** Cap supplemental MemorySearchResult scores strictly below the trailing primary result score. */
export function capSupplementalTailScores(
  floor: number | undefined,
  items: readonly MemorySearchResult[],
): MemorySearchResult[] {
  if (floor === undefined) return [...items];
  return items.map((item, index) => {
    const combinedScore = capScoreBelowFloor(item.combinedScore, floor, index);
    return combinedScore === item.combinedScore ? item : { ...item, combinedScore };
  });
}

/** Sort search results deterministically in chronological eventTime/createdAt order. */
export function sortResultsChronologically(
  results: readonly MemorySearchResult[],
): MemorySearchResult[] {
  return [...results].sort((left, right) => {
    const leftTime = left.memory.eventTime ?? left.memory.createdAt ?? "";
    const rightTime = right.memory.eventTime ?? right.memory.createdAt ?? "";
    return leftTime.localeCompare(rightTime) || left.memory.id.localeCompare(right.memory.id);
  });
}

/** Project a MemoryRecord and score into the shared RerankCandidate representation. */
export function toRerankCandidateFromRecord(
  memory: MemoryRecord,
  combinedScore: number,
  extra: Partial<Omit<RerankCandidate, "id" | "statement" | "combinedScore">> = {},
): RerankCandidate {
  return {
    id: memory.id,
    statement: memory.statement,
    combinedScore,
    eventTime: memory.eventTime,
    createdAt: memory.createdAt,
    sessionId: extra.sessionId ?? memory.sourceSessionId ?? memory.sessionId ?? null,
    nodeId: memory.nodeId,
    evidenceId: memory.evidenceId,
    turnOrdinal: extra.turnOrdinal,
    markers: memory.markers,
    stateKey: memory.stateKey,
    predicateKey: memory.predicateKey,
    supersedesId: memory.supersedesId,
    relatedMemoryIds: memory.relatedMemoryIds,
  };
}

/** Fuse lexical and vector candidate lists via shared log-odds scoring into RerankCandidates. */
export function fuseDualChannelCandidates(
  lexical: readonly DualChannelCandidateInput[],
  vector: readonly DualChannelCandidateInput[],
): Array<RerankCandidate & { memory: MemoryRecord }> {
  const byId = new Map<string, { memory: MemoryRecord; bm25: number; vectorScore: number }>();
  for (const item of lexical) {
    byId.set(item.memory.id, {
      memory: item.memory,
      bm25: item.bm25 ?? 0,
      vectorScore: item.vectorScore ?? 0,
    });
  }
  for (const item of vector) {
    const existing = byId.get(item.memory.id);
    if (existing) {
      existing.vectorScore = Math.max(existing.vectorScore, item.vectorScore ?? 0);
      if (item.bm25 && !existing.bm25) existing.bm25 = item.bm25;
    } else {
      byId.set(item.memory.id, {
        memory: item.memory,
        bm25: item.bm25 ?? 0,
        vectorScore: item.vectorScore ?? 0,
      });
    }
  }
  const fused = rankLocalLogOdds([...byId.values()], (row) => ({
    id: row.memory.id,
    bm25: row.bm25,
    vectorScore: row.vectorScore,
  }));
  return fused.map(({ candidate, score }) => ({
    ...toRerankCandidateFromRecord(candidate.memory, score),
    memory: candidate.memory,
  }));
}

/** Stitch ranked hits with adjacent-turn and leaf-peer supplements within the target page limit. */
export function stitchSupplementalPage(
  results: readonly MemorySearchResult[],
  options: {
    readonly limit: number;
    readonly maxAdjacent?: number;
    readonly maxLeafPeers?: number;
  },
): MemorySearchResult[] {
  const maxAdjacent = options.maxAdjacent ?? 2;
  const maxLeafPeers = options.maxLeafPeers ?? 4;
  const ranked = new Map<string, MemorySearchResult>();
  const adjacent = new Map<string, MemorySearchResult>();
  const leaves = new Map<string, MemorySearchResult>();
  for (const item of results) {
    const group = isAdjacentTurnResult(item)
      ? adjacent
      : item.recallReason === "leaf_context"
        ? leaves
        : ranked;
    group.set(item.memory.id, item);
  }
  const neighbors = [...adjacent.values()]
    .filter(({ memory }) => !ranked.has(memory.id))
    .slice(0, Math.min(maxAdjacent, options.limit));
  const hits = [...ranked.values()].slice(0, Math.max(0, options.limit - neighbors.length));
  hits.push(...neighbors);
  const room = Math.min(maxLeafPeers, Math.max(0, options.limit - hits.length));
  if (room === 0) return hits;
  return [
    ...hits,
    ...[...leaves.values()]
      .filter(({ memory }) => !ranked.has(memory.id) && !adjacent.has(memory.id))
      .slice(0, room),
  ];
}
