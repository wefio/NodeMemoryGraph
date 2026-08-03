/**
 * Elbow validation: does the ranked score sequence carry a "natural cutoff"
 * (score cliff) that predicts K_need (evidence coverage position)?
 *
 * Per question: one retrieval (limit 34, pure BGE vectors), dump
 *   - sorted combined scores (the ranking the QPP would see)
 *   - kneed100 / kneed80 (true coverage positions from labels)
 *   - numEvidence
 * Output JSON for offline analysis. Cached embeddings + persistent stores
 * make re-runs cheap.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CachedOmniEmbeddingClient } from "./embedding-cache.ts";
import { createEmbeddingClientFromEnv } from "../../src/core/embedding-provider.ts";
import { syncRecordEmbeddings } from "../../src/core/embedding-sync.ts";
import { NmgStore } from "../../src/core/store.ts";
import { loadLocomo } from "../benchmarks/loaders.ts";

const DATA = process.argv[2] ?? ".benchmarks/official/OmniMemEval/data/locomo/locomo10.json";
const MAX_CASES = Number.parseInt(process.argv[3] ?? "2000", 10);
const JSON_OUT = process.argv[4] ?? "evals/results/elbow-data.json";
const EMBED_CACHE = "evals/results/embedding-cache.sqlite";
const STORE_DIR = "evals/results/audit-stores";
const TOPK = 34;

interface Row {
  scores: number[]; // top-TOPK combined scores, descending
  vectorScores: number[]; // raw cosine scores, descending
  kneed100: number;
  kneed80: number;
  numEvidence: number;
  hitAt: number[]; // rank positions where evidence was found (1-based)
}

async function run(): Promise<void> {
  const client = createEmbeddingClientFromEnv();
  if (!client) {
    console.error("no embedding client: set NMG_EMBED_BASE_URL / NMG_EMBED_MODEL / NMG_EMBED_API_KEY");
    process.exit(1);
  }
  const cached = new CachedOmniEmbeddingClient(EMBED_CACHE, client);
  const cases = loadLocomo(DATA).slice(0, MAX_CASES);
  const conversations = new Map<string, { sessions: (typeof cases)[0]["sessions"]; questions: { question: string; evidenceIds: string[] }[] }>();
  for (const benchmarkCase of cases) {
    const key = benchmarkCase.officialMetadata?.sampleId ?? benchmarkCase.sessions[0]?.id ?? "x";
    const group = conversations.get(key) ?? { sessions: benchmarkCase.sessions, questions: [] };
    group.questions.push({ question: benchmarkCase.question, evidenceIds: benchmarkCase.evidenceIds });
    conversations.set(key, group);
  }

  const rows: Row[] = [];
  let built = 0;
  let questions = 0;
  const tmp = mkdtempSync(join(tmpdir(), "nmg-elbow-"));
  const start = Date.now();

  for (const [, group] of conversations) {
    const storePath = join(STORE_DIR, `case-${built}.sqlite`);
    const store = new NmgStore(storePath);
    const ready = store.embeddingIndexHealth(cached.indexId)?.status === "ready";
    if (!ready) {
      for (const session of group.sessions) {
        for (const [index, turn] of session.turns.entries()) {
          const history = store.appendHistory({
            content: turn.content,
            role: turn.role,
            sessionId: session.id,
            sourceMessageId: String(index),
          });
          store.remember({
            statement: turn.content,
            nodeName: `turn-${turn.sourceId}`,
            nodeSummary: turn.content.slice(0, 120),
            memoryType: "conversation_evidence",
            sourceActor: turn.role === "user" ? "user" : "assistant",
            truthStatus: "asserted",
            evidenceHistoryId: history.id,
            tier: 2,
            importance: 0.6,
            scope: { benchmark: "locomo-fibonacci-audit", diaId: turn.sourceId },
            writeSource: "user",
          });
        }
      }
      await syncRecordEmbeddings(store, cached);
    }
    built += 1;

    for (const caseQa of group.questions) {
      questions += 1;
      const diaIds = new Set(caseQa.evidenceIds);
      const queryVector = (await cached.embedQueries([caseQa.question]))[0]!;
      const ctx = store.searchContext(caseQa.question, {
        limit: TOPK,
        maxTier: 3,
        activeGraphBudget: { maxNodes: TOPK, maxEvidence: TOPK, maxTokens: 10_000, maxTierBudget: TOPK },
        vectorGranularity: "records",
      }, { queryVector, model: cached.indexId });
      const hitAt: number[] = [];
      ctx.results.forEach((result, index) => {
        if (diaIds.has(result.memory.scope?.diaId as string)) hitAt.push(index + 1);
      });
      const sortedRanks = [...hitAt].sort((a, b) => a - b);
      const kneed100 = sortedRanks.length > 0 ? sortedRanks[sortedRanks.length - 1]! : 0;
      const target80 = Math.ceil(diaIds.size * 0.8);
      const kneed80 = sortedRanks.length > 0 ? sortedRanks[Math.min(target80, sortedRanks.length) - 1]! : 0;
      rows.push({
        scores: ctx.results.map((r) => r.combinedScore),
        vectorScores: ctx.results.map((r) => r.vectorScore),
        kneed100,
        kneed80,
        numEvidence: diaIds.size,
        hitAt,
      });
    }
    store.close();
    if (built % 2 === 0) process.stderr.write(`built ${built}/${conversations.size} | ${questions} questions | ${((Date.now() - start) / 1000).toFixed(0)}s\r`);
  }
  rmSync(tmp, { recursive: true, force: true });
  writeFileSync(JSON_OUT, JSON.stringify(rows));
  console.log(`\nrows: ${rows.length} | ${((Date.now() - start) / 1000).toFixed(0)}s | out: ${JSON_OUT}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
