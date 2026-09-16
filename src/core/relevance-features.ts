import {
  boundedRelevance,
  queryScoreStats,
  rawRelevance,
  type RelevanceScale,
} from "./relevance-gate.ts";
import type { HybridWeights } from "./store/search-ranking.ts";
import type { MemorySearchResult } from "./types.ts";

/**
 * Deterministic feature extraction for the learned (model-side) relevance gate.
 *
 * The model gate is the strict half of the two-gate design; it must run on
 * features the program gate cannot already decide — and crucially on a scale
 * that keeps its range (the bounded `hybridScore` compresses dispersion away,
 * see `docs/experiments/retrieval-quality/relevance-gate-calibration-2026-09-09.md`).
 * So this mixes raw-scale score shape with semantic and structural evidence.
 */

export const RELEVANCE_FEATURE_NAMES = [
  /** log1p of the unbounded (raw-scale) relevance — keeps dynamic range. */
  "raw_log",
  "vector",
  "route",
  /** Bounded, portable absolute relevance in [0,1]. */
  "bounded",
  /** σ-distance of this candidate from the query's own mean (raw scale). */
  "rel_z",
  /** raw / top1 within the query (0..1). */
  "rel_ratio",
  /** 0 for the first candidate, up to 1 for the last — rank position. */
  "rank_norm",
  /** Fraction of query tokens that appear in the statement. */
  "term_coverage",
  /** Jaccard of query and statement tokens: |Q∩S| / |Q∪S|. */
  "jaccard",
  /** IDF-weighted query coverage: share of the query's information (local IDF
   *  over the candidate set) the statement carries. */
  "idf_coverage",
  /** Character-level query coverage (tolerant of tokenisation mismatch). */
  "char_overlap",
  /** 1 when the whole (normalized) query appears in the statement. */
  "phrase_match",
  "stmt_len",
  /** Memory tier normalised to [0,1]. */
  "tier",
  "importance",
  /** log1p of age in days (event time, else creation time). */
  "recency_days",
  "confidence",
] as const;

export type RelevanceFeatureName = (typeof RELEVANCE_FEATURE_NAMES)[number];
export const RELEVANCE_FEATURE_COUNT = RELEVANCE_FEATURE_NAMES.length;

/**
 * Absolute retriever scores. Their value depends on which retrieval arms produced
 * the candidate scores and, for the vector arm, on the embedder that produced the
 * vectors — so weights trained on one score scale must not be fed another.
 * Everything not listed here is textual, *relative* to the query's own candidate
 * set, or record metadata, and survives a retriever/embedder swap unchanged.
 */
export const OPTIONAL_FEATURE_NAMES = ["raw_log", "bounded", "vector"] as const;

/** `core` is always available; `retrieval` is scale-bound. */
export type FeatureBlockId = "core" | "retrieval";

export const FEATURE_BLOCK_IDS: readonly FeatureBlockId[] = ["core", "retrieval"];

/** Columns belonging to each block, in RELEVANCE_FEATURE_NAMES order. */
export const BLOCK_COLUMNS: Record<FeatureBlockId, number[]> = (() => {
  const optional = new Set<string>(OPTIONAL_FEATURE_NAMES);
  const core: number[] = [];
  const retrieval: number[] = [];
  RELEVANCE_FEATURE_NAMES.forEach((name, index) => {
    (optional.has(name) ? retrieval : core).push(index);
  });
  if (core.length + retrieval.length !== RELEVANCE_FEATURE_COUNT) {
    throw new Error("feature blocks must partition the feature vector");
  }
  return { core, retrieval };
})();

/**
 * Columns selected by `blocks`, in RELEVANCE_FEATURE_NAMES order. A model stores
 * this column list and projects every input row with it, so a core-only model
 * never reads (and never depends on) the scale-bound block.
 */
export function columnsForBlocks(blocks: readonly FeatureBlockId[]): number[] {
  if (blocks.length === 0) throw new Error("at least one feature block is required");
  const selected = new Set<number>();
  for (const block of blocks) {
    const columns = BLOCK_COLUMNS[block];
    if (!columns) throw new Error(`unknown feature block: ${block}`);
    for (const column of columns) selected.add(column);
  }
  if (selected.size === 0) throw new Error("selected feature blocks select no column");
  return [...selected].sort((left, right) => left - right);
}

const DAY_MS = 86_400_000;

/** ASCII words plus individual CJK characters (a simple, deterministic cut). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]/gu) ?? [];
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, " ").trim();
}

export interface RelevanceFeatureOptions {
  weights?: HybridWeights;
  /** Clock for the recency feature; defaults to Date.now(). */
  nowMs?: number;
  scale?: RelevanceScale;
}

/**
 * One feature row per result, aligned with {@link RELEVANCE_FEATURE_NAMES}.
 * Query-level shape features are computed once over the whole candidate list.
 */
export function relevanceFeatureMatrix(
  query: string,
  results: readonly MemorySearchResult[],
  options: RelevanceFeatureOptions = {},
): number[][] {
  const nowMs = options.nowMs ?? Date.now();
  const stats = queryScoreStats(results, options.weights, options.scale ?? "raw");
  const queryTokens = new Set(tokenize(query));
  const normalizedQuery = normalizeText(query);
  const queryChars = new Set([...normalizedQuery.replace(/\s+/gu, "")]);
  const statementTokens = results.map((result) => tokenize(result.memory.statement));
  // Local IDF (over this query's candidates) so rare query terms weigh more.
  const documentFrequency = new Map<string, number>();
  for (const tokens of statementTokens) {
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const total = Math.max(1, results.length);
  const idf = (token: string) => Math.log(1 + total / (documentFrequency.get(token) ?? 0.5));
  const queryIdf = [...queryTokens].reduce((sum, token) => sum + idf(token), 0);
  return results.map((result, index) => {
    const raw = rawRelevance(result, options.weights);
    const memory = result.memory;
    const tokenSet = new Set(statementTokens[index]!);
    const overlap = overlapFeatures({
      queryTokens,
      queryChars,
      tokenSet,
      statement: memory.statement,
      idf,
      queryIdf,
    });
    const statementText = normalizeText(memory.statement);
    return [
      Math.log1p(raw),
      result.vectorScore,
      result.routeScore,
      boundedRelevance(result, options.weights),
      stats.sd > 0 ? (raw - stats.mean) / stats.sd : 0,
      stats.top1 > 0 ? raw / stats.top1 : 0,
      results.length > 1 ? index / (results.length - 1) : 0,
      overlap.coverage,
      overlap.jaccard,
      overlap.idfCoverage,
      overlap.charOverlap,
      normalizedQuery.length > 0 && statementText.includes(normalizedQuery) ? 1 : 0,
      Math.log1p(memory.statement.length) / 10,
      memory.tier / 3,
      memory.importance,
      Math.log1p(ageInDays(memory, nowMs)),
      memory.confidence ?? 0.5,
    ];
  });
}

/** Lexical-overlap features (token and character level), each in [0, 1]. */
function overlapFeatures(input: {
  queryTokens: ReadonlySet<string>;
  queryChars: ReadonlySet<string>;
  tokenSet: ReadonlySet<string>;
  statement: string;
  idf: (token: string) => number;
  queryIdf: number;
}): { coverage: number; jaccard: number; idfCoverage: number; charOverlap: number } {
  const { queryTokens, queryChars, tokenSet, idf, queryIdf } = input;
  const shared = [...queryTokens].filter((token) => tokenSet.has(token));
  const union = new Set([...queryTokens, ...tokenSet]).size;
  const statementChars = new Set([...normalizeText(input.statement).replace(/\s+/gu, "")]);
  let sharedChars = 0;
  for (const char of queryChars) if (statementChars.has(char)) sharedChars += 1;
  return {
    coverage: queryTokens.size === 0 ? 0 : shared.length / queryTokens.size,
    jaccard: union === 0 ? 0 : shared.length / union,
    idfCoverage: queryIdf > 0 ? shared.reduce((sum, token) => sum + idf(token), 0) / queryIdf : 0,
    charOverlap: queryChars.size === 0 ? 0 : sharedChars / queryChars.size,
  };
}

/** Age in days, defaulting to 30 for a missing or unparseable timestamp. */
function ageInDays(
  memory: { eventTime?: string | null; createdAt?: string | null },
  nowMs: number,
): number {
  const stamp = memory.eventTime ?? memory.createdAt;
  const stampMs = stamp ? Date.parse(stamp) : Number.NaN;
  return Number.isFinite(stampMs) ? Math.max(0, (nowMs - stampMs) / DAY_MS) : 30;
}
