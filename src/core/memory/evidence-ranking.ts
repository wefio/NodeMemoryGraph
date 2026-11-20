import type { MemoryContext, MemorySearchResult } from "../types.ts";
import { MAX_EVIDENCE_SOURCE_CHARACTERS } from "../types.ts";
import { MAX_RANKED_EVIDENCE_RECORDS, packRankedEvidence } from "./evidence-page.ts";
import type { EvidencePackItem } from "./evidence-page.ts";

export const MAX_EVIDENCE_CANDIDATES = 100;

export interface EvidenceRankingCandidate {
  statement: string;
  source: string;
  context: string;
  lexicalScore: number;
  vectorScore: number;
  hybridScore: number;
}

export interface EvidenceRanker {
  score(
    query: string,
    candidates: readonly EvidenceRankingCandidate[],
    signal?: AbortSignal,
  ): Promise<readonly number[]>;
}

function recordText(result: MemorySearchResult): string {
  return [
    ...new Set(
      [result.memory.statement, ...result.evidenceRecords.map((source) => source.content)]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].join("\n\n");
}

function scoringCandidate(result: MemorySearchResult): EvidenceRankingCandidate {
  const context = result.evidenceRecords
    .filter((source) => source.id !== result.evidence.id)
    .map((source) => source.content)
    .join("\n\n")
    .slice(0, MAX_EVIDENCE_SOURCE_CHARACTERS);
  return {
    source: result.evidence.content.slice(0, MAX_EVIDENCE_SOURCE_CHARACTERS),
    statement: result.memory.statement.slice(0, MAX_EVIDENCE_SOURCE_CHARACTERS),
    context,
    lexicalScore: result.lexicalScore,
    vectorScore: result.vectorScore,
    hybridScore: result.combinedScore,
  };
}

function sourceKey(result: MemorySearchResult): string {
  return result.evidence.content.trim() || result.evidence.id;
}

function packItem(
  result: MemorySearchResult,
  utility: number,
): EvidencePackItem<MemorySearchResult> {
  return {
    value: result,
    key: sourceKey(result),
    text: recordText(result),
    utility,
  };
}

type RankedScores = { scores: readonly number[]; degraded: boolean };

async function scoresForPage(
  query: string,
  eligible: readonly MemorySearchResult[],
  ranker: EvidenceRanker,
  signal?: AbortSignal,
): Promise<RankedScores> {
  if (!eligible.length) return { scores: [], degraded: false };
  try {
    const scores = await ranker.score(query, eligible.map(scoringCandidate), signal);
    signal?.throwIfAborted();
    validateRankingScores(scores, eligible.length);
    return { scores, degraded: false };
  } catch {
    signal?.throwIfAborted();
    return { scores: eligible.map((_, rank) => 1 / (rank + 1)), degraded: true };
  }
}

/** Rank one merged shortlist. Callers retain ownership of admission, snapshot and cancellation. */
export async function rankEvidencePage(
  query: string,
  context: MemoryContext,
  ranker: EvidenceRanker,
  limit = MAX_RANKED_EVIDENCE_RECORDS,
  signal?: AbortSignal,
): Promise<MemoryContext> {
  signal?.throwIfAborted();
  const seen = new Set<string>();
  const eligible: MemorySearchResult[] = [];
  for (const result of context.results) {
    const key = sourceKey(result);
    if (seen.has(key)) continue;
    seen.add(key);
    eligible.push(result);
    if (eligible.length === MAX_EVIDENCE_CANDIDATES) break;
  }
  const { scores, degraded } = await scoresForPage(query, eligible, ranker, signal);
  const selected = packRankedEvidence(
    scores.map((utility, i) => packItem(eligible[i]!, utility)),
    limit,
  );
  const results = [...selected.values];
  const retained = new Set(results.map((item) => item.memory.id));
  return {
    ...context,
    evidencePage: { characters: selected.characters, ranked: !degraded },
    ...(degraded && !context.retrieval?.degraded
      ? {
          retrieval: {
            mode: context.retrieval?.mode ?? "lexical",
            degraded: true,
            reason: "evidence_reranker_unavailable",
          },
        }
      : {}),
    results,
    chainEdges: context.chainEdges?.filter(
      (edge) => retained.has(edge.sourceMemoryId) && retained.has(edge.targetMemoryId),
    ),
  };
}

function validateRankingScores(scores: readonly number[], candidates: number): void {
  if (
    !Array.isArray(scores) ||
    scores.length !== candidates ||
    scores.some((score) => !Number.isFinite(score) || score < 0 || score > 1)
  ) {
    throw new Error("Invalid evidence ranking scores");
  }
}

/** Reserve ranked hybrid results, then admit disjoint vector and lexical candidates before hydration. */
export function evidenceShortlist<T extends { memory: { id: string } }>(
  hybrid: readonly T[],
  vectorIds: readonly string[],
  lexicalIds: readonly string[],
  limit: number,
): T[] {
  const selected = new Map(
    hybrid
      .slice(0, Math.min(limit, MAX_RANKED_EVIDENCE_RECORDS))
      .map((item) => [item.memory.id, item]),
  );
  const byId = new Map(hybrid.map((item) => [item.memory.id, item]));
  const positions = Math.max(hybrid.length, vectorIds.length, lexicalIds.length);
  for (let index = 0; index < positions && selected.size < limit; index++) {
    for (const id of [vectorIds[index], lexicalIds[index], hybrid[index]?.memory.id]) {
      if (id === undefined || selected.has(id)) continue;
      const item = byId.get(id);
      if (item) selected.set(id, item);
      if (selected.size === limit) break;
    }
  }
  return [...selected.values()];
}
