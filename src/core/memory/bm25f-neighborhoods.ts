import type { ComputeOperator } from "../compute-graph.ts";
import { eventDateIndexText, normalize } from "../memory-normalization.ts";
import { recallTriggersFromStoredMarkers } from "../recall-triggers.ts";
import { searchTerms } from "../store/search-ranking.ts";
import {
  compareScored,
  getRerankCandidateIndex,
  inputScored,
  numParam,
  type RerankCandidate,
  type RerankContext,
} from "./rerank-types.ts";

const CONCEPT_STOP_WORDS = new Set([
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
  "said",
  "told",
  "asked",
]);

function fieldTokens(text: string): string[] {
  if (!text) return [];
  return searchTerms(normalize(text));
}

interface CandidateFields {
  readonly id: string;
  readonly statementTokens: string[];
  readonly triggerTokens: string[];
  readonly dateTokens: string[];
}

function buildFieldCounts(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function extractCandidateFields(candidate: RerankCandidate): CandidateFields {
  const triggers = recallTriggersFromStoredMarkers(candidate.markers ?? []).join(" ");
  const dates = eventDateIndexText(candidate.eventTime);
  return {
    id: candidate.id,
    statementTokens: fieldTokens(candidate.statement),
    triggerTokens: fieldTokens(triggers),
    dateTokens: fieldTokens(dates),
  };
}

function normalizedTf(tf: number, dl: number, avdl: number, weight: number, b: number): number {
  if (tf <= 0) return 0;
  const norm = 1 - b + b * (dl / Math.max(1, avdl));
  return weight * (tf / Math.max(0.25, norm));
}

export interface Bm25fParams {
  readonly weight: number;
  readonly k1: number;
  readonly wText: number;
  readonly wTriggers: number;
  readonly wDates: number;
  readonly bText: number;
  readonly bTriggers: number;
  readonly bDates: number;
}

function resolveBm25fParams(params: Readonly<Record<string, unknown>>): Bm25fParams {
  return {
    weight: numParam(params, "weight", 0.15),
    k1: numParam(params, "k1", 1.2),
    wText: numParam(params, "wText", 1.0),
    wTriggers: numParam(params, "wTriggers", 1.5),
    wDates: numParam(params, "wDates", 1.2),
    bText: numParam(params, "bText", 0.75),
    bTriggers: numParam(params, "bTriggers", 0.25),
    bDates: numParam(params, "bDates", 0.0),
  };
}

interface DocFieldCounts {
  readonly id: string;
  readonly tfText: Map<string, number>;
  readonly tfTrig: Map<string, number>;
  readonly tfDate: Map<string, number>;
  readonly dlText: number;
  readonly dlTrig: number;
  readonly dlDate: number;
}

interface CorpusFieldStats {
  readonly n: number;
  readonly avgText: number;
  readonly avgTrig: number;
  readonly avgDate: number;
  readonly df: Map<string, number>;
}

function scoreDocBm25f(
  doc: DocFieldCounts,
  queryTerms: readonly string[],
  stats: CorpusFieldStats,
  cfg: Bm25fParams,
): number {
  let total = 0;
  for (const term of queryTerms) {
    const termDf = stats.df.get(term) ?? 0;
    if (termDf === 0) continue;
    const idf = Math.log(1 + (stats.n - termDf + 0.5) / (termDf + 0.5));
    const pseudoTf =
      normalizedTf(doc.tfText.get(term) ?? 0, doc.dlText, stats.avgText, cfg.wText, cfg.bText) +
      normalizedTf(
        doc.tfTrig.get(term) ?? 0,
        doc.dlTrig,
        stats.avgTrig,
        cfg.wTriggers,
        cfg.bTriggers,
      ) +
      normalizedTf(doc.tfDate.get(term) ?? 0, doc.dlDate, stats.avgDate, cfg.wDates, cfg.bDates);
    if (pseudoTf > 0) total += (idf * (pseudoTf * (cfg.k1 + 1))) / (cfg.k1 + pseudoTf);
  }
  return total;
}

function computeBm25fScores(
  candidates: readonly RerankCandidate[],
  queryTerms: readonly string[],
  cfg: Bm25fParams,
): Map<string, number> {
  const n = candidates.length;
  const docs = candidates.map(extractCandidateFields);
  const termMaps: DocFieldCounts[] = docs.map((d) => ({
    id: d.id,
    tfText: buildFieldCounts(d.statementTokens),
    tfTrig: buildFieldCounts(d.triggerTokens),
    tfDate: buildFieldCounts(d.dateTokens),
    dlText: d.statementTokens.length,
    dlTrig: d.triggerTokens.length,
    dlDate: d.dateTokens.length,
  }));
  const df = new Map<string, number>();
  for (const term of queryTerms) {
    let count = 0;
    for (const doc of termMaps) {
      if (doc.tfText.has(term) || doc.tfTrig.has(term) || doc.tfDate.has(term)) count += 1;
    }
    df.set(term, count);
  }
  const stats: CorpusFieldStats = {
    n,
    avgText: Math.max(1, docs.reduce((s, d) => s + d.statementTokens.length, 0) / n),
    avgTrig: Math.max(1, docs.reduce((s, d) => s + d.triggerTokens.length, 0) / n),
    avgDate: Math.max(1, docs.reduce((s, d) => s + d.dateTokens.length, 0) / n),
    df,
  };
  const rawScores = new Map<string, number>();
  let maxScore = 0;
  for (const doc of termMaps) {
    const score = scoreDocBm25f(doc, queryTerms, stats, cfg);
    if (score > maxScore) maxScore = score;
    rawScores.set(doc.id, score);
  }
  if (maxScore <= 0) return rawScores;
  for (const [id, score] of rawScores) rawScores.set(id, score / maxScore);
  return rawScores;
}

/**
 * True Robertson-Zaragoza (2004) BM25F over statement, recall_triggers, and eventTime dates
 * with per-field average length normalization before non-linear k1 term saturation.
 */
export const bm25fFieldScoreOperator: ComputeOperator<RerankContext> = (
  inputs,
  context,
  params,
) => {
  const base = inputScored(inputs, context.candidates);
  if (context.candidates.length < 2) return base;
  const queryTerms = [...new Set(fieldTokens(context.queryText))];
  if (!queryTerms.length) return base;
  const cfg = resolveBm25fParams(params);
  const poolSize = Math.max(2, Math.floor(numParam(params, "poolSize", 200)));
  const poolEntries = base.slice(0, poolSize);
  const { byId } = getRerankCandidateIndex(context.candidates);
  const poolCandidates = poolEntries.flatMap((entry) => {
    const candidate = byId.get(entry.id);
    return candidate ? [candidate] : [];
  });
  const scores = computeBm25fScores(poolCandidates, queryTerms, cfg);
  const reorderedPool = poolEntries
    .map((entry) => ({
      id: entry.id,
      score: entry.score + cfg.weight * (scores.get(entry.id) ?? 0),
    }))
    .sort(compareScored);
  return [...reorderedPool, ...base.slice(poolSize)];
};

/** Boost candidates co-occurring on the same calendar event day as top-ranked anchors. */
export const temporalPivotOperator: ComputeOperator<RerankContext> = (inputs, context, params) => {
  const base = inputScored(inputs, context.candidates);
  const weight = numParam(params, "weight", 0.14);
  const anchorTopK = Math.max(1, Math.floor(numParam(params, "anchorTopK", 5)));
  const dayById = getRerankCandidateIndex(context.candidates).eventDays();
  const dayVotes = new Map<string, number>();

  for (let i = 0; i < Math.min(anchorTopK, base.length); i += 1) {
    const day = dayById.get(base[i]!.id);
    if (!day) continue;
    dayVotes.set(day, (dayVotes.get(day) ?? 0) + 1 / (60 + i + 1));
  }
  if (!dayVotes.size) return base;

  const rankedDays = [...dayVotes.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([day], rank) => [day, rank] as const);
  const dayRank = new Map(rankedDays);

  return base
    .map((entry) => {
      const day = dayById.get(entry.id);
      const rank = day ? dayRank.get(day) : undefined;
      const boost = rank === undefined ? 0 : weight / (1 + 0.25 * rank);
      return { id: entry.id, score: entry.score + boost };
    })
    .sort(compareScored);
};

function conceptTokensOf(candidate: RerankCandidate): Set<string> {
  const raw = `${candidate.statement} ${recallTriggersFromStoredMarkers(candidate.markers ?? []).join(" ")}`;
  const tokens = normalize(raw).match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return new Set(tokens.filter((token) => !CONCEPT_STOP_WORDS.has(token) && !/^\d+$/u.test(token)));
}

/** 1-hop bipartite diffusion over rare concepts / recall triggers without requiring MemoryNodes. */
export const conceptPivotOperator: ComputeOperator<RerankContext> = (inputs, context, params) => {
  const base = inputScored(inputs, context.candidates);
  if (context.candidates.length < 3) return base;
  const weight = numParam(params, "weight", 0.14);
  const anchorTopK = Math.max(1, Math.floor(numParam(params, "anchorTopK", 5)));
  const maxDf = Math.max(3, Math.floor(context.candidates.length * 0.15));

  const conceptsById = new Map<string, Set<string>>();
  const df = new Map<string, number>();
  for (const candidate of context.candidates) {
    const tokens = conceptTokensOf(candidate);
    conceptsById.set(candidate.id, tokens);
    for (const token of tokens) df.set(token, (df.get(token) ?? 0) + 1);
  }

  const conceptHeat = new Map<string, number>();
  for (let i = 0; i < Math.min(anchorTopK, base.length); i += 1) {
    const id = base[i]!.id;
    const vote = 1 / (60 + i + 1);
    for (const token of conceptsById.get(id) ?? []) {
      const count = df.get(token) ?? 0;
      if (count >= 2 && count <= maxDf) {
        conceptHeat.set(token, (conceptHeat.get(token) ?? 0) + vote);
      }
    }
  }
  if (!conceptHeat.size) return base;

  const maxHeat = Math.max(...conceptHeat.values());
  return base
    .map((entry) => {
      let sum = 0;
      for (const token of conceptsById.get(entry.id) ?? []) {
        sum += conceptHeat.get(token) ?? 0;
      }
      const boost = maxHeat > 0 ? weight * Math.min(1, sum / (2 * maxHeat)) : 0;
      return { id: entry.id, score: entry.score + boost };
    })
    .sort(compareScored);
};

function addVote(map: Map<string, number>, key: string | null | undefined, vote: number): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + vote);
}

/** Boost candidates connected by explicit memory relations, stateKey, or predicateKey lineage. */
export const lineagePivotOperator: ComputeOperator<RerankContext> = (inputs, context, params) => {
  const base = inputScored(inputs, context.candidates);
  const weight = numParam(params, "weight", 0.16);
  const anchorTopK = Math.max(1, Math.floor(numParam(params, "anchorTopK", 5)));
  const { byId } = getRerankCandidateIndex(context.candidates);

  const stateHeat = new Map<string, number>();
  const predicateHeat = new Map<string, number>();
  const directLinks = new Map<string, number>();

  for (let i = 0; i < Math.min(anchorTopK, base.length); i += 1) {
    const anchor = byId.get(base[i]!.id);
    if (!anchor) continue;
    const vote = 1 / (1 + 0.3 * i);
    addVote(stateHeat, anchor.stateKey, vote);
    addVote(predicateHeat, anchor.predicateKey, vote);
    addVote(directLinks, anchor.supersedesId, vote);
    for (const relId of anchor.relatedMemoryIds ?? []) addVote(directLinks, relId, vote);
  }
  for (const candidate of context.candidates) {
    if (candidate.supersedesId && byId.has(candidate.supersedesId)) {
      const targetIdx = base.findIndex((e) => e.id === candidate.supersedesId);
      if (targetIdx >= 0 && targetIdx < anchorTopK) {
        addVote(directLinks, candidate.id, 1 / (1 + 0.3 * targetIdx));
      }
    }
  }

  if (!stateHeat.size && !predicateHeat.size && !directLinks.size) return base;

  return base
    .map((entry) => {
      const c = byId.get(entry.id);
      if (!c) return entry;
      const linkSignal =
        (directLinks.get(c.id) ?? 0) +
        0.7 * (c.stateKey ? (stateHeat.get(c.stateKey) ?? 0) : 0) +
        0.5 * (c.predicateKey ? (predicateHeat.get(c.predicateKey) ?? 0) : 0);
      const boost = weight * Math.min(1, linkSignal);
      return { id: entry.id, score: entry.score + boost };
    })
    .sort(compareScored);
};

function defaultTurnSessionKey(candidate: RerankCandidate): string {
  if (candidate.sessionId) return candidate.sessionId;
  const amlSession = candidate.markers?.find((m) => m.kind === "aml_session")?.attributes
    ?.session_id;
  if (typeof amlSession === "string" && amlSession) return amlSession;
  return "";
}

function deriveSessionTurnOrdinals(
  candidates: readonly RerankCandidate[],
  sessionKeyOf: (candidate: RerankCandidate) => string,
): Map<string, { session: string; ordinal: number }> {
  const result = new Map<string, { session: string; ordinal: number }>();
  for (const candidate of candidates) {
    if (typeof candidate.turnOrdinal !== "number" || !Number.isFinite(candidate.turnOrdinal)) {
      continue;
    }
    const session = sessionKeyOf(candidate);
    if (!session) continue;
    result.set(candidate.id, { session, ordinal: candidate.turnOrdinal });
  }
  return result;
}

/** Boost candidates adjacent within +-maxRadius dialogue turns of top anchors in the same session. */
export const turnPivotOperator: ComputeOperator<RerankContext> = (inputs, context, params) => {
  const base = inputScored(inputs, context.candidates);
  if (base.length < 3) return base;
  const weight = numParam(params, "weight", 0.16);
  const anchorTopK = Math.max(1, Math.floor(numParam(params, "anchorTopK", 6)));
  const maxRadius = Math.max(1, Math.floor(numParam(params, "maxRadius", 2)));
  const sessionKeyOf = context.sessionKeyOf ?? defaultTurnSessionKey;
  const ordinals = deriveSessionTurnOrdinals(context.candidates, sessionKeyOf);
  if (!ordinals.size) return base;

  const anchorsBySession = new Map<string, Array<{ ordinal: number; vote: number }>>();
  for (let i = 0; i < Math.min(anchorTopK, base.length); i += 1) {
    const info = ordinals.get(base[i]!.id);
    if (!info) continue;
    const list = anchorsBySession.get(info.session) ?? [];
    list.push({ ordinal: info.ordinal, vote: 1 / (1 + 0.25 * i) });
    anchorsBySession.set(info.session, list);
  }
  if (!anchorsBySession.size) return base;

  return base
    .map((entry) => {
      const info = ordinals.get(entry.id);
      const anchors = info ? anchorsBySession.get(info.session) : undefined;
      if (!info || !anchors) return entry;
      let bestSignal = 0;
      for (const anchor of anchors) {
        const dist = Math.abs(info.ordinal - anchor.ordinal);
        if (dist >= 1 && dist <= maxRadius) {
          const signal = anchor.vote / (1 + 0.5 * (dist - 1));
          if (signal > bestSignal) bestSignal = signal;
        }
      }
      return bestSignal > 0 ? { id: entry.id, score: entry.score + weight * bestSignal } : entry;
    })
    .sort(compareScored);
};

function chronoGroupKey(
  candidate: RerankCandidate,
  sessionKeyOf: (candidate: RerankCandidate) => string,
): string {
  if (candidate.stateKey) return `state:${candidate.stateKey}`;
  if (candidate.nodeId) return `node:${candidate.nodeId}`;
  const session = sessionKeyOf(candidate);
  return session ? `sess:${session}` : "";
}

function collectChronoBuckets(
  candidates: readonly RerankCandidate[],
  timestampMs: ReadonlyMap<string, number | null>,
  sessionKeyOf: (candidate: RerankCandidate) => string,
): Map<string, Map<number, string[]>> {
  const buckets = new Map<string, Map<number, string[]>>();
  for (const candidate of candidates) {
    const group = chronoGroupKey(candidate, sessionKeyOf);
    if (!group) continue;
    const ms = timestampMs.get(candidate.id);
    if (ms === null || ms === undefined) continue;
    let byMs = buckets.get(group);
    if (!byMs) {
      byMs = new Map<number, string[]>();
      buckets.set(group, byMs);
    }
    const ids = byMs.get(ms) ?? [];
    ids.push(candidate.id);
    byMs.set(ms, ids);
  }
  return buckets;
}

function deriveChronoStepPositions(
  candidates: readonly RerankCandidate[],
  timestampMs: ReadonlyMap<string, number | null>,
  sessionKeyOf: (candidate: RerankCandidate) => string,
): Map<string, { group: string; stepIdx: number }> {
  const positions = new Map<string, { group: string; stepIdx: number }>();
  for (const [group, byMs] of collectChronoBuckets(candidates, timestampMs, sessionKeyOf)) {
    if (byMs.size < 2) continue;
    const orderedSteps = [...byMs.entries()].sort((left, right) => left[0] - right[0]);
    for (let stepIdx = 0; stepIdx < orderedSteps.length; stepIdx += 1) {
      for (const id of orderedSteps[stepIdx]![1]) {
        positions.set(id, { group, stepIdx });
      }
    }
  }
  return positions;
}

function bestChronoStepSignal(
  stepIdx: number,
  anchors: readonly { stepIdx: number; vote: number }[],
  maxSteps: number,
): number {
  let bestSignal = 0;
  for (const anchor of anchors) {
    const dist = Math.abs(stepIdx - anchor.stepIdx);
    if (dist < 1 || dist > maxSteps) continue;
    const signal = anchor.vote / (1 + 0.5 * (dist - 1));
    if (signal > bestSignal) bestSignal = signal;
  }
  return bestSignal;
}

/** Boost distinct-timestamp chronological neighbors (+-maxSteps) within the same state/node/session group. */
export const chronoSequencePivotOperator: ComputeOperator<RerankContext> = (
  inputs,
  context,
  params,
) => {
  const base = inputScored(inputs, context.candidates);
  if (base.length < 3) return base;
  const weight = numParam(params, "weight", 0.18);
  const anchorTopK = Math.max(1, Math.floor(numParam(params, "anchorTopK", 5)));
  const maxSteps = Math.max(1, Math.floor(numParam(params, "maxSteps", 2)));
  const sessionKeyOf = context.sessionKeyOf ?? defaultTurnSessionKey;
  const { timestampMs } = getRerankCandidateIndex(context.candidates);
  const positions = deriveChronoStepPositions(context.candidates, timestampMs, sessionKeyOf);
  if (!positions.size) return base;

  const anchorsByGroup = new Map<string, Array<{ stepIdx: number; vote: number }>>();
  for (let i = 0; i < Math.min(anchorTopK, base.length); i += 1) {
    const info = positions.get(base[i]!.id);
    if (!info) continue;
    const list = anchorsByGroup.get(info.group) ?? [];
    list.push({ stepIdx: info.stepIdx, vote: 1 / (1 + 0.25 * i) });
    anchorsByGroup.set(info.group, list);
  }
  if (!anchorsByGroup.size) return base;

  return base
    .map((entry) => {
      const info = positions.get(entry.id);
      const anchors = info ? anchorsByGroup.get(info.group) : undefined;
      if (!info || !anchors) return entry;
      const signal = bestChronoStepSignal(info.stepIdx, anchors, maxSteps);
      return signal > 0 ? { id: entry.id, score: entry.score + weight * signal } : entry;
    })
    .sort(compareScored);
};
