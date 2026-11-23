import {
  ComputeRegistry,
  INPUT_NODE_ID,
  evaluateSyncComputeGraph,
  type ComputeGraphSpec,
} from "../compute-graph.ts";
import { normalize } from "../memory-normalization.ts";
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
  readonly markers?: readonly MemoryMarker[];
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

const DATE_QUERY_RE =
  /\b(?:when|what date|what day|which day|what year|what month|how long)\b|哪一天|哪天|什么时候|啥时候|几号|哪年|哪个月|多久/i;
const DATE_CAND_RE =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|yesterday|today|tomorrow|last\s+(?:week|month|year)|next\s+(?:week|month|year))\b|\b(?:19|20)\d{2}\b|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|(?:上|下|这|本)周[一二三四五六日天]|昨天|今天|明天|元旦|春节/i;
const NUM_QUERY_RE = /\b(?:how many|how much)\b|多少|几个|几岁|几元|多少钱|几次/i;
const NUM_CAND_RE = /\d|[一二三四五六七八九十百千万亿两]+(?:个|次|天|年|月|元|块|岁|小时|分钟)/u;
const PAST_CONSTRAINT_RE =
  /\b(?:19|20)\d{2}\b|\blast\s+(?:year|month|week)\b|去年|前年|上个月|上周/i;

const DEDUP_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "you",
  "your",
  "are",
  "was",
  "were",
  "have",
  "had",
  "has",
  "not",
  "but",
  "what",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "whose",
  "how",
  "why",
  "from",
  "about",
  "into",
  "their",
  "there",
  "they",
  "them",
  "been",
  "being",
  "will",
  "would",
  "could",
  "should",
  "can",
  "did",
  "does",
  "just",
  "than",
  "then",
  "also",
  "more",
  "some",
  "any",
  "all",
  "out",
  "over",
  "after",
  "before",
  "only",
  "our",
  "very",
  "such",
]);

function compareScored(left: ScoredCandidateId, right: ScoredCandidateId): number {
  return right.score - left.score || (left.id < right.id ? -1 : Number(left.id > right.id));
}

function baseScored(candidates: readonly RerankCandidate[]): ScoredCandidateId[] {
  return candidates
    .map((candidate) => ({ id: candidate.id, score: candidate.combinedScore }))
    .sort(compareScored);
}

function inputScored(
  inputs: Readonly<Record<string, unknown>>,
  candidates: readonly RerankCandidate[],
): ScoredCandidateId[] {
  const raw = inputs.default;
  if (Array.isArray(raw)) return raw as ScoredCandidateId[];
  return baseScored(candidates);
}

function numParam(
  params: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function tokenizeForDedup(text: string): Set<string> {
  const tokens = normalize(text).match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return new Set(tokens.filter((token) => !DEDUP_STOP_WORDS.has(token) && !/^\d+$/.test(token)));
}

function jaccardSet(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const token of small) {
    if (large.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function timestampMs(candidate: RerankCandidate): number | null {
  const raw = candidate.eventTime ?? candidate.createdAt;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function maxTimestampMs(candidates: readonly RerankCandidate[]): number {
  let maxMs = 0;
  for (const candidate of candidates) {
    const ms = timestampMs(candidate);
    if (ms !== null && ms > maxMs) maxMs = ms;
  }
  return maxMs;
}

function pickNextUnselectedIndex(
  pool: readonly ScoredCandidateId[],
  used: Uint8Array,
  penalized: Uint8Array,
  dupPenalty: number,
): number {
  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < pool.length; i += 1) {
    if (used[i]) continue;
    const adjusted = pool[i]!.score - (penalized[i] ? dupPenalty : 0);
    if (adjusted > bestScore) {
      bestScore = adjusted;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function markJaccardNeighbors(
  pool: readonly ScoredCandidateId[],
  tokenSets: ReadonlyArray<ReadonlySet<string>>,
  chosenTokens: ReadonlySet<string>,
  used: Uint8Array,
  penalized: Uint8Array,
  jaccardThresh: number,
): void {
  if (!chosenTokens.size) return;
  for (let i = 0; i < pool.length; i += 1) {
    if (used[i] || penalized[i]) continue;
    if (jaccardSet(tokenSets[i]!, chosenTokens) >= jaccardThresh) penalized[i] = 1;
  }
}

function defaultSessionKey(candidate: RerankCandidate): string {
  if (candidate.sessionId) return candidate.sessionId;
  const amlSession = candidate.markers?.find((m) => m.kind === "aml_session")?.attributes
    ?.session_id;
  if (typeof amlSession === "string" && amlSession) return amlSession;
  return candidate.nodeId || candidate.evidenceId || candidate.id;
}

function sessionRankMap(
  entries: readonly ScoredCandidateId[],
  byId: ReadonlyMap<string, RerankCandidate>,
  sessionKeyOf: (candidate: RerankCandidate) => string,
): Map<string, number> {
  const topRrfBySession = new Map<string, number[]>();
  for (let i = 0; i < entries.length; i += 1) {
    const candidate = byId.get(entries[i]!.id);
    if (!candidate) continue;
    const key = sessionKeyOf(candidate);
    const list = topRrfBySession.get(key) ?? [];
    if (list.length < 5) list.push(1 / (60 + i + 1));
    topRrfBySession.set(key, list);
  }
  const rankedSessions = [...topRrfBySession.entries()]
    .map(([key, scores]) => ({ key, score: scores.reduce((sum, item) => sum + item, 0) }))
    .sort((left, right) => right.score - left.score || left.key.localeCompare(right.key));
  return new Map(rankedSessions.map((item, rank) => [item.key, rank]));
}

function candidateId(entry: string | ScoredCandidateId): string {
  return typeof entry === "string" ? entry : entry.id;
}

interface BandSpec {
  readonly port: string;
  readonly endRank: number;
}

function resolveBands(params: Readonly<Record<string, unknown>>): readonly BandSpec[] {
  const raw = params.bands;
  if (Array.isArray(raw)) return raw as BandSpec[];
  return [
    { port: "head", endRank: 5 },
    { port: "mid", endRank: 20 },
    { port: "tail", endRank: 100 },
  ];
}

function buildRerankRegistry(): ComputeRegistry<RerankContext> {
  const registry = new ComputeRegistry<RerankContext>();

  registry.register("identity_rank", (inputs, context) => inputScored(inputs, context.candidates));

  registry.register("r3_intent_boost", (inputs, context, params) => {
    const base = inputScored(inputs, context.candidates);
    const isDate = DATE_QUERY_RE.test(context.queryText);
    const isNum = NUM_QUERY_RE.test(context.queryText);
    if (!isDate && !isNum) return base;
    const weight = numParam(params, "weight", 0.12);
    const byId = new Map(context.candidates.map((candidate) => [candidate.id, candidate]));
    return base
      .map((entry) => {
        const statement = byId.get(entry.id)?.statement ?? "";
        const dateBonus = isDate && DATE_CAND_RE.test(statement) ? weight : 0;
        const numBonus = isNum && NUM_CAND_RE.test(statement) ? weight : 0;
        return { id: entry.id, score: entry.score + dateBonus + numBonus };
      })
      .sort(compareScored);
  });

  registry.register("r5_recency_boost", (inputs, context, params) => {
    const base = inputScored(inputs, context.candidates);
    if (PAST_CONSTRAINT_RE.test(context.queryText)) return base;
    const maxMs = maxTimestampMs(context.candidates);
    if (maxMs <= 0) return base;
    const weight = numParam(params, "weight", 0.12);
    const byId = new Map(context.candidates.map((candidate) => [candidate.id, candidate]));
    return base
      .map((entry) => {
        const candidate = byId.get(entry.id);
        const ms = candidate ? timestampMs(candidate) : null;
        if (ms === null) return entry;
        const ageDays = Math.max(0, (maxMs - ms) / 86_400_000);
        return { id: entry.id, score: entry.score + weight / (1 + ageDays / 90) };
      })
      .sort(compareScored);
  });

  registry.register("r1_incremental_dedup", (inputs, context, params) => {
    const base = inputScored(inputs, context.candidates);
    const poolSize = Math.max(1, Math.floor(numParam(params, "poolSize", 40)));
    const limit = Math.max(1, Math.floor(numParam(params, "limit", 25)));
    const jaccardThresh = numParam(params, "jaccardThresh", 0.6);
    const dupPenalty = numParam(params, "dupPenalty", 0.5);
    const byId = new Map(context.candidates.map((candidate) => [candidate.id, candidate]));
    const pool = base.slice(0, poolSize);
    const tokenSets = pool.map((entry) => tokenizeForDedup(byId.get(entry.id)?.statement ?? ""));
    const used = new Uint8Array(pool.length);
    const penalized = new Uint8Array(pool.length);
    const selected: ScoredCandidateId[] = [];
    const target = Math.min(limit, pool.length);
    for (let step = 0; step < target; step += 1) {
      const idx = pickNextUnselectedIndex(pool, used, penalized, dupPenalty);
      if (idx < 0) break;
      used[idx] = 1;
      selected.push(pool[idx]!);
      markJaccardNeighbors(pool, tokenSets, tokenSets[idx]!, used, penalized, jaccardThresh);
    }
    return [...selected, ...pool.filter((_, i) => !used[i]), ...base.slice(pool.length)];
  });

  registry.register("w_session_pivot", (inputs, context, params) => {
    const base = inputScored(inputs, context.candidates);
    const weight = numParam(params, "weight", 0.2);
    const byId = new Map(context.candidates.map((candidate) => [candidate.id, candidate]));
    const sessionKeyOf = context.sessionKeyOf ?? defaultSessionKey;
    const sRank = sessionRankMap(base, byId, sessionKeyOf);
    return base
      .map((entry) => {
        const candidate = byId.get(entry.id);
        const rank = candidate ? sRank.get(sessionKeyOf(candidate)) : undefined;
        const boost = rank === undefined ? 0 : weight / (1 + 0.25 * rank);
        return { id: entry.id, score: entry.score + boost };
      })
      .sort(compareScored);
  });

  registry.register("causal_band_stitch", (inputs, _context, params) => {
    const bands = resolveBands(params);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const band of bands) {
      const entries =
        (inputs[band.port] as readonly (string | ScoredCandidateId)[] | undefined) ?? [];
      for (const entry of entries) {
        if (out.length >= band.endRank) break;
        const id = candidateId(entry);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  });

  return registry;
}

export const RERANK_COMPUTE_REGISTRY = buildRerankRegistry();

export interface PiecewiseRerankGraphOptions {
  readonly id?: string;
  readonly headWeight?: number;
  readonly recencyWeight?: number;
  readonly dedupPoolSize?: number;
  readonly dedupLimit?: number;
  readonly jaccardThresh?: number;
  readonly dupPenalty?: number;
  readonly sessionWeight?: number;
  readonly bands?: readonly BandSpec[];
}

export const MID_DEDUP_RECENCY_SUBGRAPH: ComputeGraphSpec = {
  id: "mid-r5-r1-40",
  nodes: [
    { id: "r5", op: "r5_recency_boost", params: { weight: 0.12 } },
    {
      id: "r1",
      op: "r1_incremental_dedup",
      params: { poolSize: 40, jaccardThresh: 0.6, dupPenalty: 0.5, limit: 25 },
    },
  ],
  edges: [
    { from: INPUT_NODE_ID, to: "r5" },
    { from: "r5", to: "r1" },
  ],
  output: "r1",
};

function resolveMidSubgraph(options: PiecewiseRerankGraphOptions): ComputeGraphSpec {
  if (
    options.recencyWeight === undefined &&
    options.dedupPoolSize === undefined &&
    options.jaccardThresh === undefined &&
    options.dupPenalty === undefined &&
    options.dedupLimit === undefined
  ) {
    return MID_DEDUP_RECENCY_SUBGRAPH;
  }
  return {
    id: `${options.id ?? "piecewise"}-mid`,
    nodes: [
      { id: "r5", op: "r5_recency_boost", params: { weight: options.recencyWeight ?? 0.12 } },
      {
        id: "r1",
        op: "r1_incremental_dedup",
        params: {
          poolSize: options.dedupPoolSize ?? 40,
          jaccardThresh: options.jaccardThresh ?? 0.6,
          dupPenalty: options.dupPenalty ?? 0.5,
          limit: options.dedupLimit ?? 25,
        },
      },
    ],
    edges: [
      { from: INPUT_NODE_ID, to: "r5" },
      { from: "r5", to: "r1" },
    ],
    output: "r1",
  };
}

/** Build a parameterized 3-band piecewise rerank ComputeGraphSpec. */
export function createPiecewiseRerankGraph(
  options: PiecewiseRerankGraphOptions = {},
): ComputeGraphSpec {
  return {
    id: options.id ?? "piecewise-r3-r1r5-wsess020",
    nodes: [
      { id: "head_r3", op: "r3_intent_boost", params: { weight: options.headWeight ?? 0.12 } },
      { id: "mid_r1_r5", op: "subgraph", subgraph: resolveMidSubgraph(options) },
      {
        id: "tail_wsess",
        op: "w_session_pivot",
        params: { weight: options.sessionWeight ?? 0.2 },
      },
      {
        id: "stitch",
        op: "causal_band_stitch",
        params: {
          bands: options.bands ?? [
            { port: "head", endRank: 5 },
            { port: "mid", endRank: 20 },
            { port: "tail", endRank: 100 },
          ],
        },
      },
    ],
    edges: [
      { from: INPUT_NODE_ID, to: "head_r3" },
      { from: INPUT_NODE_ID, to: "mid_r1_r5" },
      { from: INPUT_NODE_ID, to: "tail_wsess" },
      { from: "head_r3", to: "stitch", port: "head" },
      { from: "mid_r1_r5", to: "stitch", port: "mid" },
      { from: "tail_wsess", to: "stitch", port: "tail" },
    ],
    output: "stitch",
  };
}

export const DEFAULT_PIECEWISE_RERANK_GRAPH: ComputeGraphSpec = createPiecewiseRerankGraph();

/** Reorder candidates with a causal piecewise rerank ComputeGraphSpec, preserving score scale. */
export function rerankCandidatesWithGraph<T extends RerankCandidate>(
  candidates: readonly T[],
  queryText: string,
  graph: ComputeGraphSpec = DEFAULT_PIECEWISE_RERANK_GRAPH,
): T[] {
  if (candidates.length < 2) return [...candidates];
  const baseScores = candidates
    .map((candidate) => candidate.combinedScore)
    .sort((left, right) => right - left);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const context: RerankContext = { queryText, candidates };
  const rankedIds = evaluateSyncComputeGraph<readonly ScoredCandidateId[], string[], RerankContext>(
    graph,
    RERANK_COMPUTE_REGISTRY,
    baseScored(candidates),
    context,
  );
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const id of rankedIds) {
    const item = byId.get(id);
    if (!item || seen.has(id)) continue;
    seen.add(id);
    ordered.push(item);
  }
  for (const candidate of candidates) {
    if (!seen.has(candidate.id)) ordered.push(candidate);
  }
  return ordered.map((candidate, index) => ({
    ...candidate,
    combinedScore: baseScores[index] ?? candidate.combinedScore,
  }));
}
