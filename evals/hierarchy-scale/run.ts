import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { HashingVectorEmbedder, NmgStore, OpenAIEmbeddingClient, UsearchAnnIndex } from "../../src/index.ts";

const sizes = (process.env.NMG_HIERARCHY_SIZES?.split(",").map(Number) ?? [100, 1_000, 10_000])
  .filter((value) => Number.isInteger(value) && value >= 16);
const outputDir = join(process.cwd(), "evals", "hierarchy-scale", ".tmp");
const embedder = new HashingVectorEmbedder();
const qwen = process.env.NMG_EMBED_BASE_URL ? new OpenAIEmbeddingClient({
  baseUrl: process.env.NMG_EMBED_BASE_URL,
  apiKey: process.env.NMG_EMBED_API_KEY,
  model: process.env.NMG_EMBED_MODEL,
  profile: process.env.NMG_EMBED_PROFILE as "bge-en" | "plain" | "qwen3" | undefined,
  queryTemplate: process.env.NMG_EMBED_QUERY_TEMPLATE,
  documentTemplate: process.env.NMG_EMBED_DOCUMENT_TEMPLATE,
}) : null;
const vectorModel = qwen?.model ?? embedder.model;
const annCandidates = Math.max(8, Math.min(Number(process.env.NMG_ANN_CANDIDATES ?? 64), 2_000));
const blockLimit = Math.max(1, Math.min(Number(process.env.NMG_BLOCK_LIMIT ?? 8), 50));
const defaultModes = ["full-record-scan", "node-only+fts", "node+leaf", "record-ann", "leaf-ann"];
const selectedModes = new Set((process.env.NMG_HIERARCHY_MODES ?? defaultModes.join(","))
  .split(",").map((mode) => mode.trim()));
mkdirSync(outputDir, { recursive: true });

const cases = [
  ["access", "The telescope access code is ORBIT-7319", "What is the telescope access code?", "identity", "fact", "telescope"],
  ["nickname", "The archive nickname is cobalt heron", "What is the archive nickname?", "identity", "fact", "archive"],
  ["city", "The backup city is Valparaíso", "What is the backup city?", "identity", "fact", "travel"],
  ["codename", "The retired project codename is lantern fern", "What was the retired project codename?", "identity", "event", "project"],
  ["alerts", "Avoid auditory alerts after midnight", "Should notifications make sound late at night?", "preferences", "preference", "notifications"],
  ["imports", "For import failures, inspect the selected runtime before reinstalling packages", "What should I check first when imports fail?", "troubleshooting", "strategy", "python"],
  ["safety", "Never delete the lunar telemetry archive", "May I remove the lunar telemetry archive?", "safety", "constraint", "telemetry"],
  ["rendering", "A display startup failure was fixed by switching to software graphics", "How did I previously solve the display startup issue?", "troubleshooting", "event", "graphics"],
] as const;

const reports = [];
const queryVectors = qwen
  ? await qwen.embedQueries(cases.map((item) => item[2]))
  : cases.map((item) => embedder.embed(item[2]));
for (const size of sizes) {
  const databasePath = join(outputDir, `hierarchy-${size}.sqlite`);
  const annPath = join(outputDir, `hierarchy-${size}.usearch`);
  const leafAnnPath = join(outputDir, `hierarchy-${size}-leaves.usearch`);
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, annPath,
    `${annPath}.json`, leafAnnPath, `${leafAnnPath}.json`]) {
    rmSync(path, { force: true });
  }
  const seed = new NmgStore(databasePath, embedder);
  const nodeIds = new Map<string, string>();
  for (const name of ["identity", "preferences", "troubleshooting", "safety", ...Array.from({ length: 12 }, (_, index) => `background-${index}`)]) {
    nodeIds.set(name, seed.upsertNode({
      canonicalName: name,
      summary: `${name} long-term memory topic`,
      kind: "topic",
    }).id);
  }
  const expected = new Map<string, string>();
  for (const [id, statement, , node, memoryType, component] of cases) {
    const result = seed.remember({
      statement,
      nodeName: node,
      memoryType,
      scope: { component },
      tier: id === "codename" || id === "rendering" ? 3 : 1,
      importance: id === "safety" ? 1 : 0.7,
    });
    expected.set(id, result.memory.id);
  }
  seed.close();

  const insertStarted = performance.now();
  insertDistractors(databasePath, size - cases.length, [...nodeIds.values()]);
  const insertMs = performance.now() - insertStarted;
  const store = new NmgStore(databasePath, embedder);

  const recordBuildStarted = performance.now();
  const needsRecordVectors = selectedModes.has("full-record-scan") || selectedModes.has("record-ann");
  const recordVectorCount = needsRecordVectors
    ? qwen ? await indexRecordDocuments(store, qwen) : store.rebuildVectorIndex()
    : 0;
  const recordBuildMs = performance.now() - recordBuildStarted;

  const nodeBuildStarted = performance.now();
  const nodeDocuments = allNodeDocuments(store);
  const nodeVectors = qwen
    ? await qwen.embed(nodeDocuments.map((document) => document.text))
    : nodeDocuments.map((document) => embedder.embed(document.text));
  store.upsertExternalNodeEmbeddings(vectorModel, nodeDocuments.map((document, index) => ({
    nodeId: document.nodeId,
    vector: nodeVectors[index]!,
  })));
  const nodeBuildMs = performance.now() - nodeBuildStarted;

  const leafBuildStarted = performance.now();
  store.rebuildLeafBlocks(undefined, 32);
  const leafDocuments = allLeafDocuments(store);
  const leafVectors = qwen ? await embedTexts(qwen, leafDocuments.map((document) => document.text))
    : leafDocuments.map((document) => embedder.embed(document.text));
  store.upsertExternalLeafEmbeddings(vectorModel, leafDocuments.map((document, index) => ({
    blockId: document.blockId,
    vector: leafVectors[index]!,
  })));
  const leafBuildMs = performance.now() - leafBuildStarted;

  const annBuildStarted = performance.now();
  const ann = new UsearchAnnIndex(annPath, annCandidates);
  const annResult = selectedModes.has("record-ann")
    ? ann.buildBatches(vectorModel, recordEmbeddingBatches(store, vectorModel))
    : { count: 0, dimensions: 0, model: vectorModel };
  const annBuildMs = performance.now() - annBuildStarted;
  const leafAnnBuildStarted = performance.now();
  const leafAnn = new UsearchAnnIndex(leafAnnPath, annCandidates);
  const leafAnnResult = leafAnn.buildBatches(vectorModel, leafDocuments.map((document, index) => [{
    memoryId: document.blockId,
    vector: leafVectors[index]!,
  }]));
  const leafAnnBuildMs = performance.now() - leafAnnBuildStarted;

  const modes = [
    {
      name: "full-record-scan",
      search: (query: string, vector: number[]) => store.searchByVector(query, vector, vectorModel,
        { maxTier: 3, limit: 8, retrievalMode: "qwen3" }),
    },
    {
      name: "node-only+fts",
      search: (query: string, vector: number[]) => {
        const routes = store.routeNodesByVector(vector, vectorModel, 4);
        return store.searchNodeFirst(query, vector, vectorModel,
          routes.map((route) => route.node.id), { maxTier: 3, limit: 8 });
      },
    },
    {
      name: "node+leaf",
      search: (query: string, vector: number[]) => store.searchHierarchyByVector(
        query, vector, vectorModel,
        { maxTier: 3, limit: 8, nodeLimit: 4, blockLimit },
      ),
    },
    {
      name: "record-ann",
      search: (query: string, vector: number[]) => {
        return store.searchByVectorCandidates(query, vector, vectorModel, ann.search(vector, annCandidates),
          { maxTier: 3, limit: 8, retrievalMode: "qwen3" });
      },
    },
    {
      name: "leaf-ann",
      search: (query: string, vector: number[]) => {
        const leaves = store.routeLeafBlocksByVector(
          vector, vectorModel, [], blockLimit, leafAnn.search(vector, annCandidates),
        );
        return store.searchLeafBlocks(query, vector, vectorModel,
          leaves.map((route) => route.block.id), { maxTier: 3, limit: 8 },
          new Map(leaves.map((route) => [route.block.id, route.score])));
      },
    },
  ];
  const results = modes.filter((mode) => selectedModes.has(mode.name)).map((mode) => {
    const queries = cases.map(([id, , query], caseIndex) => {
      const started = performance.now();
      const found = mode.search(query, queryVectors[caseIndex]!);
      return {
        id,
        hit: found.some((result) => result.memory.id === expected.get(id)),
        latencyMs: performance.now() - started,
        returnedChars: found.reduce((sum, result) => sum + result.memory.statement.length, 0),
      };
    });
    const latencies = queries.map((query) => query.latencyMs).sort((a, b) => a - b);
    return {
      mode: mode.name,
      accuracy: queries.filter((query) => query.hit).length / queries.length,
      latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
      estimatedReturnedTokens: Math.ceil(queries.reduce((sum, query) => sum + query.returnedChars, 0) / 4),
      ...(process.env.NMG_SCALE_VERBOSE === "1" ? { queries } : {}),
    };
  });
  reports.push({
    size,
    vectors: {
      records: recordVectorCount,
      nodes: nodeDocuments.length,
      leaves: leafDocuments.length,
      recordAnn: annResult.count,
      leafAnn: leafAnnResult.count,
    },
    maintenanceMs: { insert: insertMs, records: recordBuildMs, nodes: nodeBuildMs,
      leaves: leafBuildMs, recordAnn: annBuildMs, leafAnn: leafAnnBuildMs },
    results,
  });
  store.close();
}
console.log(JSON.stringify({ embedding: vectorModel, annCandidates, blockLimit, reports }, null, 2));

function insertDistractors(path: string, count: number, nodeIds: string[]): void {
  const db = new DatabaseSync(path);
  const history = db.prepare(`INSERT INTO history_records
    (id, session_id, source_message_id, role, content, source_ref, created_at)
    VALUES (?, 'hierarchy-scale', ?, 'user', ?, 'generator', ?)`);
  const memory = db.prepare(`INSERT INTO memory_records
    (id, node_id, evidence_id, statement, memory_type, source_actor, truth_status,
     scope_json, status, evidence_role, tier, importance, access_count,
     pending_access_count, created_at)
    VALUES (?, ?, ?, ?, 'fact', 'user', 'asserted', ?, 'active', 'support', ?, 0.5, 0, 0, ?)`);
  const link = db.prepare("INSERT INTO memory_evidence_links(memory_id, history_id) VALUES (?, ?)");
  db.exec("BEGIN");
  try {
    for (let index = 0; index < count; index += 1) {
      const suffix = String(index).padStart(7, "0");
      const historyId = `h-${suffix}`;
      const memoryId = `m-${suffix}`;
      const text = `Routine synthetic observation batch ${index % 97} item ${suffix}`;
      const createdAt = new Date(Date.UTC(2030, 0, 1, 0, 0, index % 60, index % 1000)).toISOString();
      history.run(historyId, `msg-${suffix}`, text, createdAt);
      memory.run(memoryId, nodeIds[index % nodeIds.length]!, historyId, text,
        JSON.stringify({ bucket: index % 8 }), index % 4, createdAt);
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
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

function allNodeDocuments(store: NmgStore) {
  const documents = [];
  let cursor = "";
  while (true) {
    const batch = store.nodeEmbeddingDocuments(cursor, 2_048);
    if (batch.length === 0) return documents;
    documents.push(...batch);
    cursor = batch.at(-1)!.nodeId;
  }
}

function allLeafDocuments(store: NmgStore) {
  const documents = [];
  let cursor = "";
  while (true) {
    const batch = store.leafEmbeddingDocuments(cursor, 2_048);
    if (batch.length === 0) return documents;
    documents.push(...batch);
    cursor = batch.at(-1)!.blockId;
  }
}

function* recordEmbeddingBatches(store: NmgStore, model: string) {
  let cursor = "";
  while (true) {
    const batch = store.storedEmbeddings(model, cursor, 2_048);
    if (batch.length === 0) return;
    yield batch;
    cursor = batch.at(-1)!.memoryId;
  }
}

async function embedTexts(client: OpenAIEmbeddingClient, texts: string[], batchSize = 64) {
  const vectors: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    vectors.push(...await client.embed(texts.slice(offset, offset + batchSize)));
  }
  return vectors;
}

async function indexRecordDocuments(store: NmgStore, client: OpenAIEmbeddingClient) {
  let cursor = "";
  let count = 0;
  while (true) {
    const documents = store.embeddingDocuments(cursor, 64, client.model);
    if (documents.length === 0) return count;
    const vectors = await client.embed(documents.map((document) => document.text));
    store.upsertExternalEmbeddings(client.model, documents.map((document, index) => ({
      memoryId: document.memoryId,
      vector: vectors[index]!,
    })));
    count += documents.length;
    cursor = documents.at(-1)!.memoryId;
  }
}
