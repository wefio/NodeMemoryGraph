import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { NmgStore, OpenAIEmbeddingClient } from "../src/index.ts";

const databasePath = resolve(process.env.NMG_DB_PATH ?? ".nmg/nmg.sqlite");
const batchSize = Math.max(1, Math.min(Number(process.env.NMG_EMBED_BATCH_SIZE ?? 64), 2_048));
const client = new OpenAIEmbeddingClient({
  baseUrl: process.env.NMG_EMBED_BASE_URL,
  apiKey: process.env.NMG_EMBED_API_KEY,
  model: process.env.NMG_EMBED_MODEL,
  dimensions: process.env.NMG_EMBED_DIMENSIONS
    ? Number(process.env.NMG_EMBED_DIMENSIONS)
    : undefined,
});
const store = new NmgStore(databasePath);
const targets = new Set((process.env.NMG_EMBED_TARGETS ?? "nodes,leaves")
  .split(",").map((target) => target.trim()).filter(Boolean));
const indexed = { nodes: 0, leaves: 0, records: 0 };
let acknowledgedDelta = 0;
const started = performance.now();

try {
  if (targets.has("nodes")) {
    let cursor = "";
    while (true) {
      const documents = store.nodeEmbeddingDocuments(cursor, batchSize, client.model);
      if (documents.length === 0) break;
      const vectors = await client.embed(documents.map((document) => document.text));
      store.upsertExternalNodeEmbeddings(client.model, documents.map((document, index) => ({
        nodeId: document.nodeId,
        vector: vectors[index]!,
      })));
      indexed.nodes += documents.length;
      cursor = documents.at(-1)!.nodeId;
    }
  }
  if (targets.has("leaves")) {
    const dirtyNodeIds = store.dirtyLeafNodeIds();
    for (const nodeId of dirtyNodeIds) store.rebuildLeafBlocks(nodeId);
    let cursor = "";
    while (true) {
      const documents = store.leafEmbeddingDocuments(cursor, batchSize, client.model);
      if (documents.length === 0) break;
      const vectors = await client.embed(documents.map((document) => document.text));
      store.upsertExternalLeafEmbeddings(client.model, documents.map((document, index) => ({
        blockId: document.blockId,
        vector: vectors[index]!,
      })));
      indexed.leaves += documents.length;
      cursor = documents.at(-1)!.blockId;
    }
    acknowledgedDelta = store.acknowledgeIndexDelta(dirtyNodeIds);
  }
  if (targets.has("records")) {
    let cursor = "";
    while (true) {
      const documents = store.embeddingDocuments(cursor, batchSize, client.model);
      if (documents.length === 0) break;
      const vectors = await client.embed(documents.map((document) => document.text));
      store.upsertExternalEmbeddings(client.model, documents.map((document, index) => ({
        memoryId: document.memoryId,
        vector: vectors[index]!,
      })));
      indexed.records += documents.length;
      cursor = documents.at(-1)!.memoryId;
    }
  }
} finally {
  store.close();
}

const elapsedMs = performance.now() - started;
console.log(JSON.stringify({
  databasePath,
  model: client.model,
  targets: [...targets],
  indexed,
  acknowledgedDelta,
  elapsedMs,
  vectorsPerSecond: elapsedMs > 0
    ? Object.values(indexed).reduce((sum, count) => sum + count, 0) / (elapsedMs / 1_000)
    : 0,
}, null, 2));
