import type { EmbeddingClient } from "../core/embedding-provider.ts";
import { cosineSimilarity } from "../core/vector.ts";

interface HttpRankedRow {
  id: string;
  score: number;
}

interface PendingHttpRow extends HttpRankedRow {
  content: string;
  vector?: readonly number[] | null;
  vector_model?: string | null;
}

type ScoredPending<Row> = { record: Row; clause: number };

export function rankHttpRows<Row extends HttpRankedRow>(rows: Row[], limit: number): Row[] {
  return rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

function queryTerms(features: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const feature of features) {
    for (const term of feature.toLowerCase().split(/[^a-z0-9一-鿿]+/u)) {
      if (term.length > 2) seen.add(term);
    }
  }
  return [...seen];
}

function lexicalScore(content: string, terms: readonly string[]): number {
  const text = content.toLowerCase();
  return terms.filter((term) => text.includes(term)).length;
}

function scoredRow<Row extends PendingHttpRow>(record: Row, scores: number[]): ScoredPending<Row> {
  const score = Math.max(...scores);
  return { record: { ...record, score }, clause: scores.indexOf(score) };
}

type PendingEmbedding = Pick<EmbeddingClient, "indexId" | "embedQueries">;

async function scorePendingVectors<Row extends PendingHttpRow>(
  waiting: readonly Row[],
  features: readonly (readonly string[])[],
  client: PendingEmbedding,
): Promise<ScoredPending<Row>[]> {
  function storedVector(record: Row) {
    return record.vector_model === client.indexId ? record.vector : undefined;
  }
  const texts = [
    ...new Set([
      ...features.flat(),
      ...waiting.filter((record) => !storedVector(record)).map((record) => record.content),
    ]),
  ];
  const vectors = texts.length ? await client.embedQueries(texts).catch(() => []) : [];
  const byText = new Map(texts.map((text, index) => [text, vectors[index]] as const));
  const vectorsPerClause = features.map((list) =>
    list.map((text) => byText.get(text)).filter((vector) => vector !== undefined),
  );
  const scored: ScoredPending<Row>[] = [];
  for (const record of waiting) {
    const vector = storedVector(record) ?? byText.get(record.content);
    if (!vector) continue;
    const scores = vectorsPerClause.map((clause) =>
      clause.reduce(
        (best, feature) => Math.max(best, cosineSimilarity(vector, feature)),
        -Infinity,
      ),
    );
    const row = scoredRow(record, scores);
    if (Number.isFinite(row.record.score)) scored.push(row);
  }
  return scored;
}

/** Rank transport-neutral pending candidates alongside completed evidence. */
export async function mergePendingHttpRows<Row extends PendingHttpRow>(options: {
  waiting: readonly Row[];
  features: readonly (readonly string[])[];
  candidates: readonly Row[];
  client?: PendingEmbedding | null;
  topK: number;
  contributions?: { contributed: number }[];
  appendOnly?: readonly boolean[];
  appendedById?: Map<string, Row>;
}): Promise<{ results: readonly Row[]; usedVectors: boolean }> {
  const { waiting, features, candidates, client, topK, contributions, appendOnly, appendedById } =
    options;
  if (!waiting.length) return { results: candidates, usedVectors: false };
  const termsPerClause = client ? [] : features.map(queryTerms);
  const scored = client
    ? await scorePendingVectors(waiting, features, client)
    : waiting
        .map((record) =>
          scoredRow(
            record,
            termsPerClause.map((terms) => lexicalScore(record.content, terms)),
          ),
        )
        .filter(({ record }) => record.score > 0);
  const page = [...candidates];
  for (const { record, clause } of scored) {
    const attribution = contributions?.[clause];
    if (attribution) attribution.contributed += 1;
    if (appendOnly?.[clause]) {
      const prior = appendedById?.get(record.id);
      if (!prior || prior.score <= record.score) appendedById?.set(record.id, record);
    } else {
      page.push(record);
    }
  }
  return { results: rankHttpRows(page, topK), usedVectors: Boolean(client && scored.length) };
}
