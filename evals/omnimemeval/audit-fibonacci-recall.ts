/**
 * Offline audit (fast): evidence recall scaling curve vs K + Fibonacci walk.
 *
 * Fixed side: ONE searchContext(limit=34) per question, then truncate the
 * ranked results at each K in {1,2,3,5,8,13,21,34} — top-K recall needs no
 * re-retrieval. Adaptive side: searchContextWithSecondPass once per question
 * per requested limit. This cuts retrievals from ~48k to ~4k.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeQppComponents, qppCandidates } from "../../src/core/qpp.ts";
import { CachedOmniEmbeddingClient } from "./embedding-cache.ts";
import { createEmbeddingClientFromEnv } from "../../src/core/embedding-provider.ts";
import { syncRecordEmbeddings } from "../../src/core/embedding-sync.ts";
import { NmgStore } from "../../src/core/store.ts";
import type { MemoryContext } from "../../src/core/types.ts";
import { loadLocomo } from "../benchmarks/loaders.ts";

const DATA = process.argv[2] ?? ".benchmarks/official/OmniMemEval/data/locomo/locomo10.json";
const MAX_CASES = Number.parseInt(process.argv[3] ?? "2000", 10);
const KS = [1, 2, 3, 5, 8, 13, 21, 34];
const ADAPTIVE_LIMITS = (process.argv[4] ?? "21").split(",").map(Number);
const THRESHOLDS = (process.argv[5] ?? "0.7").split(",").map(Number);
const JSON_OUT = process.argv[6] ?? ""; // per-question rows for K_need vs QPP analysis
const EMBED_CACHE = ".benchmarks/shared-embedding-cache.sqlite";
const STORE_DIR = "evals/results/audit-stores";

function evidenceRecall(results: MemoryContext["results"], diaIds: Set<string>): number {
  const hits = results.filter(
    (result) => result.memory.scope?.diaId && diaIds.has(result.memory.scope.diaId),
  ).length;
  return diaIds.size === 0 ? 0 : hits / diaIds.size;
}

function hitsInPrefix(results: MemoryContext["results"], k: number, diaIds: Set<string>): number {
  return results
    .slice(0, k)
    .filter((result) => result.memory.scope?.diaId && diaIds.has(result.memory.scope.diaId)).length;
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

  // fixed: per-K aggregates; adaptive: per limit:threshold aggregates
  const fixedHits = new Map<number, number[]>(); // K -> recall values
  for (const k of KS) fixedHits.set(k, []);
  interface AdaptStat { results: number[]; recalls: number[]; triggers: number; stages: number[]; }
  const adapt = new Map<string, AdaptStat>();
  for (const limit of ADAPTIVE_LIMITS) for (const thr of THRESHOLDS) adapt.set(`${limit}:${thr}`, { results: [], recalls: [], triggers: 0, stages: [] });

  let built = 0;
  let questions = 0;
  const root = mkdtempSync(join(tmpdir(), "nmg-fib-audit-"));  const start = Date.now();
  const rows: Array<{ top1: number; nqc: number; c: number; kneed100: number; kneed80: number; numEvidence: number; stageHit: number }> = [];

  for (const [, group] of conversations) {
    const storePath = join(STORE_DIR, `case-${built}.sqlite`);
    const exists = new NmgStore(storePath);
    const ready = exists.embeddingIndexHealth(cached.indexId)?.status === "ready";
    const store = ready ? exists : new NmgStore(storePath);
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
      // ONE retrieval at limit 34; truncate for all K.
      const pool = store.searchContext(caseQa.question, {
        limit: 34,
        maxTier: 3,
        activeGraphBudget: { maxNodes: 34, maxEvidence: 34, maxTokens: 10_000, maxTierBudget: 34 },
        vectorGranularity: "records",
      }, { queryVector, model: client.indexId });
      for (const k of KS) {
        fixedHits.get(k)!.push(hitsInPrefix(pool.results, k, diaIds) / Math.max(diaIds.size, 1));
      }
      // K_need: earliest position at which all / 80% evidence is covered.
      const ranks = new Set<number>();
      const evidenceSet = new Set(caseQa.evidenceIds);
      pool.results.forEach((result, index) => {
        if (evidenceSet.has(result.memory.scope?.diaId as string)) ranks.add(index + 1);
      });
      const sortedRanks = [...ranks].sort((a, b) => a - b);
      const kneed100 = sortedRanks.length > 0 ? sortedRanks[sortedRanks.length - 1]! : 0;
      const target80 = Math.ceil(diaIds.size * 0.8);
      const kneed80 = sortedRanks.length > 0 ? sortedRanks[Math.min(target80, sortedRanks.length) - 1]! : 0;
      // QPP components from the same ranked pool (selection = top 34).
      const selections = pool.results.map((result, index) => ({
        memoryId: result.memory.id,
        nodeId: result.node.id,
        source: "direct" as const,
        reason: "hybrid_match" as const,
        rank: index + 1,
        tier: result.memory.tier,
        estimatedTokens: 1,
        scores: { lexical: result.lexicalScore, vector: result.vectorScore, route: result.routeScore, combined: result.combinedScore },
      }));
      const comps = computeQppComponents(caseQa.question, qppCandidates(pool.results, selections));
      const c = comps.top1 + 0.5 * comps.nqc;
      const stageHit = KS.find((k) => kneed100 > 0 && k >= kneed100) ?? 0;
      rows.push({ top1: comps.top1, nqc: comps.nqc, c, kneed100, kneed80, numEvidence: diaIds.size, stageHit });
      // adaptive walks
      for (const limit of ADAPTIVE_LIMITS) {
        const budget = { maxNodes: limit, maxEvidence: limit, maxTokens: Math.max(1_000, limit * 300), maxTierBudget: limit };
        for (const thr of THRESHOLDS) {
          const stat = adapt.get(`${limit}:${thr}`)!;
          const ctx = store.searchContextWithSecondPass(caseQa.question, {
            limit,
            maxTier: 3,
            qppThreshold: thr,
            activeGraphBudget: budget,
            vectorGranularity: "records",
          }, { queryVector, model: client.indexId });
          stat.results.push(ctx.results.length);
          stat.recalls.push(evidenceRecall(ctx.results, diaIds));
          if (ctx.activeGraph?.qpp?.trigger === true) stat.triggers += 1;
          stat.stages.push(ctx.activeGraph?.qpp?.expansion?.stages?.length ?? 0);
        }
      }
    }
    store.close();
    if (built % 2 === 0) process.stderr.write(`built ${built}/${conversations.size} | ${questions} questions | ${((Date.now() - start) / 1000).toFixed(0)}s\r`);
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(rows));
  rmSync(root, { recursive: true, force: true });

  const mean = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
  console.log(`\nconversations: ${built} | questions: ${questions} | ${((Date.now() - start) / 1000).toFixed(0)}s | model: ${client.indexId}`);
  console.log(`\n=== fixed top-K recall@returned (single retrieval, truncated) ===`);
  for (const k of KS) {
    const r = mean(fixedHits.get(k)!);
    console.log(`  K=${String(k).padEnd(2)} recall=${r.toFixed(4)}`);
  }
  for (const [key, stat] of adapt) {
    const [limit, thr] = key.split(":");
    const n = mean(stat.results);
    const r = mean(stat.recalls);
    console.log(`\n=== adaptive limit=${limit} thr=${thr} ===`);
    console.log(`  results: ${n.toFixed(2)} (min ${Math.min(...stat.results)} max ${Math.max(...stat.results)}) | recall: ${r.toFixed(4)} | trigger: ${stat.triggers}/${stat.questions ?? questions} | stages: ${(stat.stages.reduce((a, b) => a + b, 0) / stat.stages.length).toFixed(2)}`);
    // per-record efficiency vs the K=limit fixed point
    const fixedR = mean(fixedHits.get(Number(limit)) ?? []);
    console.log(`  vs fixed K=${limit} (recall ${fixedR.toFixed(4)}): delta ${(r - fixedR).toFixed(4)} | recall/record ${(r / Math.max(n, 1)).toFixed(4)}`);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
