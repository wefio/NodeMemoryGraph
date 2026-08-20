export interface EvaluationResult {
  questionId: string;
  mode: string;
  passed: boolean;
  repeat: number;
  durationMs?: number;
  retrievalContextChars?: number;
  retrievalPassed?: boolean | null;
  officialRetrieval?: { recallAny: number; recallAll: number; recall: number; ndcg: number } | null;
  answerTiming?: AnswerTiming;
  tokenUsage?: TokenUsage;
}

export interface AnswerTiming {
  startupMs: number;
  promptMs: number;
  modelStreamMs: number;
  toolExecutionMs: number;
  shutdownMs: number;
}

export interface AnswerTimingSummary extends AnswerTiming {
  count: number;
}

export interface InjectedContextSummary {
  count: number;
  meanCharacters: number;
  meanEstimatedTokens: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface TokenUsageSummary extends TokenUsage {
  count: number;
}

export interface AccuracySummary {
  passed: number;
  total: number;
  accuracy: number;
  confidence95: { lower: number; upper: number };
}

export interface PairedSummary {
  baseline: string;
  candidate: string;
  pairs: number;
  bothPass: number;
  candidateOnly: number;
  baselineOnly: number;
  bothFail: number;
  netWins: number;
}

export interface LatencySummary {
  count: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface PipelineSummary {
  evaluated: number;
  retrievalPassed: number;
  sufficientAnswerCorrect: number;
  sufficientAnswerWrong: number;
  insufficientAnswerCorrect: number;
  insufficientAnswerWrong: number;
}

export function summarizeAccuracy(results: readonly EvaluationResult[]): AccuracySummary {
  const passed = results.filter((result) => result.passed).length;
  return {
    passed,
    total: results.length,
    accuracy: results.length === 0 ? 0 : passed / results.length,
    confidence95: wilsonInterval(passed, results.length),
  };
}

export function summarizeByMode(
  results: readonly EvaluationResult[],
): Record<string, AccuracySummary> {
  return Object.fromEntries(
    [...new Set(results.map((result) => result.mode))]
      .sort()
      .map((mode) => [mode, summarizeAccuracy(results.filter((result) => result.mode === mode))]),
  );
}

export function pairedAgainst(
  results: readonly EvaluationResult[],
  baseline: string,
): Record<string, PairedSummary> {
  const baselineRows = new Map(
    results.filter((result) => result.mode === baseline).map((result) => [pairKey(result), result]),
  );
  const candidates = [...new Set(results.map((result) => result.mode))]
    .filter((mode) => mode !== baseline)
    .sort();

  return Object.fromEntries(
    candidates.map((candidate) => {
      let bothPass = 0;
      let candidateOnly = 0;
      let baselineOnly = 0;
      let bothFail = 0;
      let pairs = 0;
      for (const row of results.filter((result) => result.mode === candidate)) {
        const baselineRow = baselineRows.get(pairKey(row));
        if (!baselineRow) continue;
        pairs += 1;
        if (row.passed && baselineRow.passed) bothPass += 1;
        else if (row.passed) candidateOnly += 1;
        else if (baselineRow.passed) baselineOnly += 1;
        else bothFail += 1;
      }
      return [
        candidate,
        {
          baseline,
          candidate,
          pairs,
          bothPass,
          candidateOnly,
          baselineOnly,
          bothFail,
          netWins: candidateOnly - baselineOnly,
        },
      ];
    }),
  );
}

export function summarizeLatencyByMode(
  results: readonly EvaluationResult[],
): Record<string, LatencySummary> {
  return Object.fromEntries(
    [...new Set(results.map((result) => result.mode))].sort().map((mode) => {
      const durations = results
        .filter((result) => result.mode === mode && result.durationMs !== undefined)
        .map((result) => result.durationMs!)
        .sort((left, right) => left - right);
      return [
        mode,
        {
          count: durations.length,
          meanMs:
            durations.length === 0
              ? 0
              : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
          p50Ms: percentile(durations, 0.5),
          p95Ms: percentile(durations, 0.95),
        },
      ];
    }),
  );
}

export interface OfficialRetrievalSummary {
  count: number;
  recallAny: number;
  recallAll: number;
  recall: number;
  ndcg: number;
}

export function summarizeTokenUsageByMode(
  results: readonly EvaluationResult[],
): Record<string, TokenUsageSummary | null> {
  return Object.fromEntries(
    [...new Set(results.map((result) => result.mode))].sort().map((mode) => {
      const usages = results
        .filter((result) => result.mode === mode)
        .flatMap((result) => (result.tokenUsage ? [result.tokenUsage] : []));
      if (usages.length === 0) return [mode, null];
      return [
        mode,
        usages.reduce<TokenUsageSummary>(
          (total, usage) => ({
            count: total.count + 1,
            input: total.input + usage.input,
            output: total.output + usage.output,
            cacheRead: total.cacheRead + usage.cacheRead,
            cacheWrite: total.cacheWrite + usage.cacheWrite,
            total: total.total + usage.total,
          }),
          { count: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        ),
      ];
    }),
  );
}

export function summarizeAnswerTimingByMode(
  results: readonly EvaluationResult[],
): Record<string, AnswerTimingSummary | null> {
  return Object.fromEntries(
    [...new Set(results.map((result) => result.mode))].sort().map((mode) => {
      const timings = results
        .filter((result) => result.mode === mode)
        .flatMap((result) => (result.answerTiming ? [result.answerTiming] : []));
      if (timings.length === 0) return [mode, null];
      const sum = timings.reduce<AnswerTiming>(
        (total, timing) => ({
          startupMs: total.startupMs + timing.startupMs,
          promptMs: total.promptMs + timing.promptMs,
          modelStreamMs: total.modelStreamMs + timing.modelStreamMs,
          toolExecutionMs: total.toolExecutionMs + timing.toolExecutionMs,
          shutdownMs: total.shutdownMs + timing.shutdownMs,
        }),
        { startupMs: 0, promptMs: 0, modelStreamMs: 0, toolExecutionMs: 0, shutdownMs: 0 },
      );
      return [
        mode,
        {
          count: timings.length,
          startupMs: Math.round(sum.startupMs / timings.length),
          promptMs: Math.round(sum.promptMs / timings.length),
          modelStreamMs: Math.round(sum.modelStreamMs / timings.length),
          toolExecutionMs: Math.round(sum.toolExecutionMs / timings.length),
          shutdownMs: Math.round(sum.shutdownMs / timings.length),
        },
      ];
    }),
  );
}

export function summarizeInjectedContextByMode(
  results: readonly EvaluationResult[],
): Record<string, InjectedContextSummary | null> {
  return Object.fromEntries(
    [...new Set(results.map((result) => result.mode))].sort().map((mode) => {
      const sizes = results
        .filter((result) => result.mode === mode && result.retrievalContextChars !== undefined)
        .map((result) => result.retrievalContextChars!);
      if (sizes.length === 0) return [mode, null];
      const meanCharacters = sizes.reduce((sum, size) => sum + size, 0) / sizes.length;
      return [
        mode,
        {
          count: sizes.length,
          meanCharacters: Math.round(meanCharacters),
          // Benchmark-independent approximation. Provider usage remains separately reported.
          meanEstimatedTokens: Math.ceil(meanCharacters / 4),
        },
      ];
    }),
  );
}

export function summarizeRetrievalByMode(
  results: readonly EvaluationResult[],
): Record<string, AccuracySummary | null> {
  return Object.fromEntries(
    [...new Set(results.map((result) => result.mode))].sort().map((mode) => {
      const evaluated = results.filter(
        (result) => result.mode === mode && typeof result.retrievalPassed === "boolean",
      );
      return [
        mode,
        evaluated.length === 0
          ? null
          : summarizeAccuracy(
              evaluated.map((result) => ({
                ...result,
                passed: result.retrievalPassed === true,
              })),
            ),
      ];
    }),
  );
}

export function summarizeOfficialRetrievalByMode(
  results: readonly EvaluationResult[],
): Record<string, OfficialRetrievalSummary | null> {
  return Object.fromEntries(
    [...new Set(results.map((result) => result.mode))].sort().map((mode) => {
      const metrics = results
        .filter((result) => result.mode === mode)
        .flatMap((result) => (result.officialRetrieval ? [result.officialRetrieval] : []));
      if (metrics.length === 0) return [mode, null];
      const sum = metrics.reduce(
        (total, metric) => ({
          recallAny: total.recallAny + metric.recallAny,
          recallAll: total.recallAll + metric.recallAll,
          recall: total.recall + metric.recall,
          ndcg: total.ndcg + metric.ndcg,
        }),
        { recallAny: 0, recallAll: 0, recall: 0, ndcg: 0 },
      );
      return [
        mode,
        {
          count: metrics.length,
          recallAny: sum.recallAny / metrics.length,
          recallAll: sum.recallAll / metrics.length,
          recall: sum.recall / metrics.length,
          ndcg: sum.ndcg / metrics.length,
        },
      ];
    }),
  );
}

export function summarizePipelineByMode(
  results: readonly EvaluationResult[],
): Record<string, PipelineSummary | null> {
  return Object.fromEntries(
    [...new Set(results.map((result) => result.mode))].sort().map((mode) => {
      const evaluated = results.filter(
        (result) => result.mode === mode && typeof result.retrievalPassed === "boolean",
      );
      if (evaluated.length === 0) return [mode, null];
      return [
        mode,
        {
          evaluated: evaluated.length,
          retrievalPassed: evaluated.filter((result) => result.retrievalPassed).length,
          sufficientAnswerCorrect: evaluated.filter(
            (result) => result.retrievalPassed && result.passed,
          ).length,
          sufficientAnswerWrong: evaluated.filter(
            (result) => result.retrievalPassed && !result.passed,
          ).length,
          insufficientAnswerCorrect: evaluated.filter(
            (result) => !result.retrievalPassed && result.passed,
          ).length,
          insufficientAnswerWrong: evaluated.filter(
            (result) => !result.retrievalPassed && !result.passed,
          ).length,
        },
      ];
    }),
  );
}

function pairKey(result: EvaluationResult): string {
  return `${result.questionId}\u0000${result.repeat}`;
}

function wilsonInterval(successes: number, total: number): { lower: number; upper: number } {
  if (total === 0) return { lower: 0, upper: 0 };
  const z = 1.959963984540054;
  const proportion = successes / total;
  const denominator = 1 + z ** 2 / total;
  const centre = (proportion + z ** 2 / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((proportion * (1 - proportion) + z ** 2 / (4 * total)) / total)) / denominator;
  return {
    lower: Math.max(0, centre - margin),
    upper: Math.min(1, centre + margin),
  };
}

function percentile(sortedValues: readonly number[], quantile: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil(quantile * sortedValues.length) - 1;
  return sortedValues[Math.max(0, index)]!;
}
