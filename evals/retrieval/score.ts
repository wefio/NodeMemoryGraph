/**
 * Pure scoring for the formalized retrieval-quality benchmark.
 *
 * Two match directions, one per gold granularity:
 *
 * - `gold-in-candidate` (LoCoMo, BEAM): gold is one source message; a ranked
 *   candidate hits it when the normalized gold text appears inside the
 *   normalized candidate text.
 * - `candidate-in-gold` (LongMemEval): gold is a whole answer session; a
 *   ranked candidate hits it when the normalized candidate text appears
 *   inside the normalized gold session blob (i.e. the candidate is backed by
 *   that session).
 *
 * Normalization mirrors the existing audit scripts
 * (evals/omnimemeval/audit-*.ts/py): lowercase, fold non-alphanumeric runs to
 * one space, trim.
 */

export type MatchDirection = "gold-in-candidate" | "candidate-in-gold";

export interface QuestionInput {
  /** Stratification label: LoCoMo category, LME question_type, BEAM capability. */
  category: string;
  /** Gold evidence texts (messages or whole-session blobs). Empty strings are ignored. */
  golds: readonly string[];
  /** Ranked candidates, best first; each candidate is a list of alternative
   *  texts (statement, evidence excerpt) — a hit on any part counts. */
  candidates: ReadonlyArray<readonly string[]>;
  /** Rendered context for the legacy audit-comparable coverage metrics. */
  contextText?: string;
  durationMs?: number;
}

export interface ScoredQuestion {
  category: string;
  /** Per-gold first-hit rank (1-based), null when never hit. */
  goldRanks: Array<number | null>;
  /** Per-gold hit in the rendered context (legacy audit-compatible coverage). */
  legacyHits: boolean[];
  contextChars: number;
  durationMs?: number;
}

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function scoreQuestion(input: QuestionInput, direction: MatchDirection): ScoredQuestion {
  const golds = input.golds.map(normalizeText).filter((gold) => gold.length > 0);
  const candidates = input.candidates.map((parts) =>
    parts.map(normalizeText).filter((part) => part.length > 0),
  );
  const context = input.contextText === undefined ? null : normalizeText(input.contextText);

  const goldRanks = golds.map((gold) => {
    for (let index = 0; index < candidates.length; index += 1) {
      const parts = candidates[index]!;
      const hit = parts.some((part) =>
        direction === "gold-in-candidate" ? part.includes(gold) : gold.includes(part),
      );
      if (hit) return index + 1;
    }
    return null;
  });

  const legacyHits = golds.map((gold, index) => {
    if (context !== null && direction === "gold-in-candidate") {
      return context.includes(gold);
    }
    return goldRanks[index] !== null;
  });

  return {
    category: input.category,
    goldRanks,
    legacyHits,
    contextChars: input.contextText?.length ?? 0,
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
  };
}

export interface AggregateMetrics {
  questions: number;
  questionsWithGolds: number;
  golds: number;
  /** Fraction of gold evidences hit within rank k. */
  recallAt: Record<string, number>;
  /** Fraction of questions with at least one gold hit within the full window. */
  anyEvidenceRate: number;
  /** Fraction of questions with every gold hit within the full window. */
  allEvidenceRate: number;
  /** Same as anyEvidenceRate but restricted to rank ≤ max(ks) — the honest
   *  "@20" reading; the full-window rates above count appended (unranked)
   *  candidates too. */
  anyEvidenceAtK: number;
  allEvidenceAtK: number;
  /** Mean 1/rank over golds (miss = 0). */
  mrrGold: number;
  /** Mean 1/rank of each question's first-hit gold (no hit = 0). */
  mrrQuestion: number;
  legacy: {
    anyEvidenceRate: number;
    allEvidenceRate: number;
    evidenceRecall: number;
  };
  meanContextChars: number;
  latencyMs: { mean: number; p50: number; p95: number };
}

export function aggregate(
  questions: readonly ScoredQuestion[],
  ks: readonly number[] = [1, 5, 10, 20],
): AggregateMetrics {
  let golds = 0;
  let rankSumReciprocal = 0;
  let questionReciprocalSum = 0;
  let anyHit = 0;
  let allHit = 0;
  let anyHitK = 0;
  let allHitK = 0;
  const maxK = Math.max(...ks);
  let legacyAny = 0;
  let legacyAll = 0;
  let legacyHits = 0;
  const hitCountAt = new Map(ks.map((k) => [k, 0]));
  const latencies: number[] = [];
  let contextCharsTotal = 0;
  let questionsWithGolds = 0;

  for (const question of questions) {
    if (question.goldRanks.length === 0) continue;
    questionsWithGolds += 1;
    golds += question.goldRanks.length;
    let firstRank: number | null = null;
    let every = true;
    let everyK = true;
    for (const rank of question.goldRanks) {
      if (rank === null) {
        every = false;
        everyK = false;
        continue;
      }
      if (rank > maxK) everyK = false;
      for (const k of ks) {
        if (rank <= k) hitCountAt.set(k, hitCountAt.get(k)! + 1);
      }
      rankSumReciprocal += 1 / rank;
      if (firstRank === null || rank < firstRank) firstRank = rank;
    }
    if (firstRank !== null) {
      anyHit += 1;
      if (firstRank <= maxK) anyHitK += 1;
      questionReciprocalSum += 1 / firstRank;
    }
    if (every) allHit += 1;
    if (everyK) allHitK += 1;
    const legacyEvery = question.legacyHits.length > 0 && question.legacyHits.every(Boolean);
    if (question.legacyHits.some(Boolean)) legacyAny += 1;
    if (legacyEvery) legacyAll += 1;
    legacyHits += question.legacyHits.filter(Boolean).length;
    contextCharsTotal += question.contextChars;
    if (question.durationMs !== undefined && Number.isFinite(question.durationMs)) {
      latencies.push(question.durationMs);
    }
  }

  const recallAt: Record<string, number> = {};
  for (const k of ks) recallAt[String(k)] = ratio(hitCountAt.get(k)!, golds);

  return {
    questions: questions.length,
    questionsWithGolds,
    golds,
    recallAt,
    anyEvidenceRate: ratio(anyHit, questionsWithGolds),
    allEvidenceRate: ratio(allHit, questionsWithGolds),
    anyEvidenceAtK: ratio(anyHitK, questionsWithGolds),
    allEvidenceAtK: ratio(allHitK, questionsWithGolds),
    mrrGold: ratio(rankSumReciprocal, golds),
    mrrQuestion: ratio(questionReciprocalSum, questionsWithGolds),
    legacy: {
      anyEvidenceRate: ratio(legacyAny, questionsWithGolds),
      allEvidenceRate: ratio(legacyAll, questionsWithGolds),
      evidenceRecall: ratio(legacyHits, golds),
    },
    meanContextChars: ratio(contextCharsTotal, questionsWithGolds),
    latencyMs: {
      mean: ratio(latencies.reduce((sum, value) => sum + value, 0), latencies.length),
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
  };
}

/** Aggregate per category, preserving first-seen order, plus an "overall" key. */
export function aggregateByCategory(
  questions: readonly ScoredQuestion[],
  ks?: readonly number[],
): Record<string, AggregateMetrics> {
  const buckets = new Map<string, ScoredQuestion[]>();
  for (const question of questions) {
    const bucket = buckets.get(question.category) ?? [];
    bucket.push(question);
    buckets.set(question.category, bucket);
  }
  const result: Record<string, AggregateMetrics> = { overall: aggregate(questions, ks) };
  for (const [category, bucket] of buckets) result[category] = aggregate(bucket, ks);
  return result;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}
