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
let indexed = 0;
let cursor = "";
const started = performance.now();

try {
  while (true) {
    const documents = store.embeddingDocuments(cursor, batchSize, client.model);
    if (documents.length === 0) break;
    const vectors = await client.embed(documents.map((document) => document.text));
    store.upsertExternalEmbeddings(client.model, documents.map((document, index) => ({
      memoryId: document.memoryId,
      vector: vectors[index]!,
    })));
    indexed += documents.length;
    cursor = documents.at(-1)!.memoryId;
    if (indexed % (batchSize * 10) === 0) {
      console.error(`indexed ${indexed} memories`);
    }
  }
} finally {
  store.close();
}

const elapsedMs = performance.now() - started;
console.log(JSON.stringify({
  databasePath,
  model: client.model,
  indexed,
  elapsedMs,
  recordsPerSecond: elapsedMs > 0 ? indexed / (elapsedMs / 1_000) : 0,
}, null, 2));
