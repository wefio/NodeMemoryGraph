import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { NmgStore, OpenAIEmbeddingClient } from "../../src/index.ts";

const DEFAULT_SIZES = [100, 1_000, 10_000, 100_000];
const sizes = (process.env.NMG_SCALE_SIZES?.split(",").map(Number) ?? DEFAULT_SIZES)
  .filter((value) => Number.isInteger(value) && value >= 10);
const outputDir = join(process.cwd(), "evals", "scale", ".tmp");
const qwenClient = process.env.NMG_EMBED_BASE_URL
  ? new OpenAIEmbeddingClient({
      baseUrl: process.env.NMG_EMBED_BASE_URL,
      apiKey: process.env.NMG_EMBED_API_KEY,
      model: process.env.NMG_EMBED_MODEL,
    })
  : null;
const modes = qwenClient
  ? (["legacy", "fts5", "hashing", "qwen3", "hybrid"] as const)
  : (["legacy", "fts5", "hashing", "hybrid"] as const);
mkdirSync(outputDir, { recursive: true });

const cases = [
  { id: "hot-exact", statement: "The user's telescope access code is ORBIT-7319", query: "What is my telescope access code?", tier: 0 as const },
  { id: "warm-exact", statement: "The user's archive nickname is cobalt heron", query: "What is my archive nickname?", tier: 1 as const },
  { id: "cool-exact", statement: "The user's backup city is Valparaíso", query: "What is my backup city?", tier: 2 as const },
  { id: "cold-exact", statement: "The user's retired project codename is lantern fern", query: "What was my retired project codename?", tier: 3 as const },
  { id: "hot-semantic", statement: "The user avoids auditory alerts after midnight", query: "Should notifications make sound late at night?", tier: 0 as const },
  { id: "warm-semantic", statement: "For build failures, inspect the selected runtime before reinstalling packages", query: "What should I check first when imports fail?", tier: 1 as const },
  { id: "rare-critical", statement: "Never delete the lunar telemetry archive", query: "May I remove the lunar telemetry archive?", tier: 0 as const },
  { id: "cold-semantic", statement: "The user once fixed rendering by switching to software graphics", query: "How did I previously solve the display startup issue?", tier: 3 as const },
];
const qwenQueries = qwenClient
  ? await qwenClient.embedQueries(cases.map((item) => item.query))
  : [];

const reports = [];
for (const size of sizes) {
  const path = join(outputDir, `scale-${size}.sqlite`);
  rmSync(path, { force: true });
  const seed = new NmgStore(path);
  const expected = new Map<string, string>();
  for (const item of cases) {
    const saved = seed.remember({
      statement: item.statement,
      nodeName: `scale ${item.id}`,
      memoryType: item.id === "rare-critical" ? "constraint" : "fact",
      tier: item.tier,
      importance: item.id === "rare-critical" ? 1 : 0.7,
      evidence: item.statement,
      sessionId: `scale-${size}`,
    });
    expected.set(item.id, saved.memory.id);
  }
  seed.close();

  const insertStarted = performance.now();
  insertDistractors(path, Math.max(0, size - cases.length));
  const insertMs = performance.now() - insertStarted;
  const openStarted = performance.now();
  const store = new NmgStore(path);
  const openAndIndexMs = performance.now() - openStarted;
  const qwenIndexStarted = performance.now();
  const qwenIndexed = qwenClient ? await indexWithClient(store, qwenClient) : 0;
  const qwenIndexMs = performance.now() - qwenIndexStarted;
  const modeReports = [];
  for (const mode of modes) {
    const queries = cases.map((item, caseIndex) => {
      const started = performance.now();
      const results = (mode === "qwen3" || (mode === "hybrid" && qwenClient))
        ? store.searchByVector(item.query, qwenQueries[caseIndex]!, qwenClient!.model, {
            maxTier: 3,
            limit: 8,
            retrievalMode: mode,
          })
        : store.search(item.query, { maxTier: 3, limit: 8, retrievalMode: mode });
      const latencyMs = performance.now() - started;
      const rank = results.findIndex((result) => result.memory.id === expected.get(item.id));
      return {
        id: item.id,
        expectedTier: item.tier,
        hit: rank >= 0,
        rank: rank >= 0 ? rank + 1 : null,
        latencyMs,
        returned: results.length,
        returnedChars: results.reduce((sum, result) =>
          sum + result.memory.statement.length + result.evidence.content.length, 0),
        tiers: results.map((result) => result.memory.tier),
      };
    });
    const latencies = queries.map((item) => item.latencyMs).sort((a, b) => a - b);
    modeReports.push({
      mode,
      accuracy: queries.filter((item) => item.hit).length / queries.length,
      tierHitRate: Object.fromEntries([0, 1, 2, 3].map((tier) => {
        const tierCases = queries.filter((item) => item.expectedTier === tier);
        return [tier, tierCases.filter((item) => item.hit).length / tierCases.length];
      })),
      latencyMs: {
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        max: latencies.at(-1) ?? 0,
      },
      estimatedReturnedTokens: Math.ceil(
        queries.reduce((sum, item) => sum + item.returnedChars, 0) / 4,
      ),
      queries,
    });
  }
  store.close();

  reports.push({
    size,
    maintenance: {
      bulkInsertMs: insertMs,
      openAndFtsBackfillMs: openAndIndexMs,
      qwenIndexMs,
      qwenIndexed,
      recordsPerSecond: (size - cases.length) / (insertMs / 1_000),
    },
    modes: modeReports,
  });
}

const output = process.env.NMG_SCALE_VERBOSE === "1"
  ? reports
  : reports.map((report) => ({
      ...report,
      modes: report.modes.map(({ queries: _queries, ...summary }) => summary),
    }));
console.log(JSON.stringify({ candidateWindow: 500, sizes: output }, null, 2));

function insertDistractors(path: string, count: number): void {
  if (count === 0) return;
  const db = new DatabaseSync(path);
  const node = db.prepare(
    `INSERT INTO memory_nodes
      (id, canonical_name, kind, summary, created_at, updated_at, status)
     VALUES (?, ?, 'topic', ?, ?, ?, 'active')`,
  );
  const history = db.prepare(
    `INSERT INTO history_records
      (id, session_id, source_message_id, role, content, source_ref, created_at)
     VALUES (?, 'scale-distractors', ?, 'user', ?, 'scale-generator', ?)`,
  );
  const memory = db.prepare(
    `INSERT INTO memory_records
      (id, node_id, evidence_id, statement, memory_type, source_actor, truth_status,
       scope_json, status, evidence_role, tier, importance, access_count,
       pending_access_count, created_at)
     VALUES (?, ?, ?, ?, 'fact', 'user', 'asserted', '{}', 'active', 'support',
             ?, 0.5, 0, 0, ?)`,
  );
  const link = db.prepare(
    "INSERT INTO memory_evidence_links(memory_id, history_id) VALUES (?, ?)",
  );
  db.exec("BEGIN");
  try {
    for (let index = 0; index < count; index += 1) {
      const suffix = String(index).padStart(6, "0");
      const nodeId = `noise-node-${suffix}`;
      const historyId = `noise-history-${suffix}`;
      const memoryId = `noise-memory-${suffix}`;
      const text = `Routine unrelated synthetic observation ${suffix}`;
      const createdAt = new Date(Date.UTC(2030, 0, 1, 0, 0, index % 60, index)).toISOString();
      node.run(nodeId, `noise ${suffix}`, text, createdAt, createdAt);
      history.run(historyId, `noise-message-${suffix}`, text, createdAt);
      memory.run(memoryId, nodeId, historyId, text, index % 4, createdAt);
      link.run(memoryId, historyId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]!;
}

async function indexWithClient(
  store: NmgStore,
  client: OpenAIEmbeddingClient,
  batchSize = Number(process.env.NMG_EMBED_BATCH_SIZE ?? 64),
): Promise<number> {
  let cursor = "";
  let indexed = 0;
  while (true) {
    const documents = store.embeddingDocuments(cursor, batchSize, client.model);
    if (documents.length === 0) return indexed;
    const vectors = await client.embed(documents.map((document) => document.text));
    store.upsertExternalEmbeddings(client.model, documents.map((document, index) => ({
      memoryId: document.memoryId,
      vector: vectors[index]!,
    })));
    indexed += documents.length;
    cursor = documents.at(-1)!.memoryId;
  }
}
