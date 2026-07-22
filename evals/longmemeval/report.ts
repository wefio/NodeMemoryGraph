export interface EvaluationResult {
  questionId: string;
  mode: string;
  passed: boolean;
  repeat: number;
  durationMs?: number;
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
