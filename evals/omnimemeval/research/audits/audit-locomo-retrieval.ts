import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Turn {
  dia_id: string;
  text: string;
}

interface Question {
  question: string;
  evidence: string[];
  category: number;
}

interface LoCoMoSample {
  qa: Question[];
  conversation: Record<string, unknown>;
}

interface SearchResult {
  query: string;
  context?: string;
  duration_ms?: number;
}

const [datasetArg, ...resultArgs] = process.argv.slice(2);
if (!datasetArg || resultArgs.length === 0) {
  throw new Error(
    "usage: audit-locomo-retrieval.ts <locomo10.json> <search-results.json> [...]",
  );
}
const dataset = JSON.parse(readFileSync(resolve(datasetArg), "utf8")) as LoCoMoSample[];
for (const resultArg of resultArgs) {
  const results = JSON.parse(readFileSync(resolve(resultArg), "utf8")) as Record<
    string,
    SearchResult[]
  >;
  console.log(JSON.stringify(audit(dataset, results, resultArg), null, 2));
}

function audit(
  samples: LoCoMoSample[],
  results: Record<string, SearchResult[]>,
  source: string,
) {
  let questions = 0;
  let anyEvidence = 0;
  let allEvidence = 0;
  let evidenceHits = 0;
  let evidenceTotal = 0;
  let missingLabels = 0;
  const contextCharacters: number[] = [];
  const latencies: number[] = [];
  const categories = new Map<number, { hits: number; total: number }>();

  samples.forEach((sample, sampleIndex) => {
    const evidenceText = new Map<string, string>();
    for (const [key, value] of Object.entries(sample.conversation)) {
      if (!/^session_\d+$/u.test(key) || !Array.isArray(value)) continue;
      for (const turn of value as Turn[]) evidenceText.set(turn.dia_id, turn.text);
    }
    const queryResults = new Map(
      (results[`locomo_exp_user_${sampleIndex}`] ?? []).map((result) => [
        result.query,
        result,
      ]),
    );
    for (const question of sample.qa) {
      if (question.category === 5) continue;
      const result = queryResults.get(question.question);
      if (!result) throw new Error(`missing search result for: ${question.question}`);
      const context = normalize(result.context ?? "");
      const labels = question.evidence.flatMap(splitEvidenceIds);
      const hits: boolean[] = [];
      for (const label of labels) {
        const text = evidenceText.get(label);
        if (!text) {
          missingLabels += 1;
          continue;
        }
        hits.push(context.includes(normalize(text)));
      }
      questions += 1;
      anyEvidence += hits.some(Boolean) ? 1 : 0;
      allEvidence += hits.length > 0 && hits.every(Boolean) ? 1 : 0;
      evidenceHits += hits.filter(Boolean).length;
      evidenceTotal += hits.length;
      contextCharacters.push((result.context ?? "").length);
      if (Number.isFinite(result.duration_ms)) latencies.push(result.duration_ms!);
      const category = categories.get(question.category) ?? { hits: 0, total: 0 };
      category.hits += hits.filter(Boolean).length;
      category.total += hits.length;
      categories.set(question.category, category);
    }
  });

  return {
    source: resolve(source),
    questions,
    missingLabels,
    anyEvidenceRate: ratio(anyEvidence, questions),
    allEvidenceRate: ratio(allEvidence, questions),
    evidenceRecall: ratio(evidenceHits, evidenceTotal),
    meanContextCharacters: mean(contextCharacters),
    latencyMs: {
      mean: mean(latencies),
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
    },
    categoryEvidenceRecall: Object.fromEntries(
      [...categories].sort(([left], [right]) => left - right).map(([category, value]) => [
        category,
        ratio(value.hits, value.total),
      ]),
    ),
  };
}

function splitEvidenceIds(value: string): string[] {
  return value.split(/[;,]\s*/u).map((item) => item.trim()).filter(Boolean);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}
