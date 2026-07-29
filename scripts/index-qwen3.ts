import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { createEmbeddingClientFromEnv, NmgStore } from "../src/index.ts";

const databasePath = resolve(process.env.NMG_DB_PATH ?? ".nmg/nmg.sqlite");
const batchSize = Math.max(1, Math.min(Number(process.env.NMG_EMBED_BATCH_SIZE ?? 64), 2_048));
const client = createEmbeddingClientFromEnv(process.env, { required: true })!;
const store = new NmgStore(databasePath);
type EmbeddingTarget = "leaves" | "nodes" | "records";
const validTargets = new Set<EmbeddingTarget>(["nodes", "leaves", "records"]);
const targets = new Set<EmbeddingTarget>(
  (process.env.NMG_EMBED_TARGETS ?? "records")
    .split(",")
    .map((target) => target.trim())
    .filter((target): target is EmbeddingTarget => validTargets.has(target as EmbeddingTarget)),
);
if (targets.size === 0) throw new Error("NMG_EMBED_TARGETS must include nodes, leaves, or records");
const indexed = { nodes: 0, leaves: 0, records: 0 };
let acknowledgedDelta = 0;
const started = performance.now();
let health;

store.beginEmbeddingIndex({
  indexId: client.indexId,
  model: client.model,
  profile: client.profile,
  targets: [...targets],
});
try {
  if (targets.has("nodes")) {
    let cursor = "";
    while (true) {
      const documents = store.nodeEmbeddingDocuments(cursor, batchSize, client.indexId);
      if (documents.length === 0) break;
      const vectors = await client.embed(documents.map((document) => document.text));
      store.upsertExternalNodeEmbeddings(
        client.indexId,
        documents.map((document, index) => ({
          nodeId: document.nodeId,
          vector: vectors[index]!,
        })),
      );
      indexed.nodes += documents.length;
      cursor = documents.at(-1)!.nodeId;
    }
  }
  if (targets.has("leaves")) {
    const dirtyNodeIds = store.dirtyLeafNodeIds();
    for (const nodeId of dirtyNodeIds) store.rebuildLeafBlocks(nodeId);
    let cursor = "";
    while (true) {
      const documents = store.leafEmbeddingDocuments(cursor, batchSize, client.indexId);
      if (documents.length === 0) break;
      const vectors = await client.embed(documents.map((document) => document.text));
      store.upsertExternalLeafEmbeddings(
        client.indexId,
        documents.map((document, index) => ({
          blockId: document.blockId,
          vector: vectors[index]!,
        })),
      );
      indexed.leaves += documents.length;
      cursor = documents.at(-1)!.blockId;
    }
    acknowledgedDelta = store.acknowledgeIndexDelta(dirtyNodeIds);
  }
  if (targets.has("records")) {
    let cursor = "";
    while (true) {
      const documents = store.embeddingDocuments(cursor, batchSize, client.indexId);
      if (documents.length === 0) break;
      const vectors = await client.embed(documents.map((document) => document.text));
      store.upsertExternalEmbeddings(
        client.indexId,
        documents.map((document, index) => ({
          memoryId: document.memoryId,
          vector: vectors[index]!,
        })),
      );
      indexed.records += documents.length;
      cursor = documents.at(-1)!.memoryId;
    }
  }
  store.completeEmbeddingIndex(client.indexId);
  health = store.embeddingIndexHealth(client.indexId);
} catch (error) {
  store.failEmbeddingIndex(client.indexId, error);
  throw error;
} finally {
  store.close();
}

const elapsedMs = performance.now() - started;
console.log(
  JSON.stringify(
    {
      databasePath,
      model: client.model,
      indexId: client.indexId,
      profile: client.profile,
      targets: [...targets],
      indexed,
      acknowledgedDelta,
      health,
      elapsedMs,
      vectorsPerSecond:
        elapsedMs > 0
          ? Object.values(indexed).reduce((sum, count) => sum + count, 0) / (elapsedMs / 1_000)
          : 0,
    },
    null,
    2,
  ),
);
