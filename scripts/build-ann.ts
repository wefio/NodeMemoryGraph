import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { NmgStore, UsearchAnnIndex } from "../src/index.ts";

const databasePath = resolve(process.env.NMG_DB_PATH ?? ".nmg/nmg.sqlite");
const model = process.env.NMG_EMBED_MODEL ?? "Qwen/Qwen3-Embedding-0.6B";
const indexPath = resolve(process.env.NMG_ANN_PATH ?? ".nmg/indexes/qwen3.usearch");
const batchSize = Math.max(1, Math.min(Number(process.env.NMG_ANN_BATCH_SIZE ?? 512), 2_048));
const store = new NmgStore(databasePath);
const index = new UsearchAnnIndex(indexPath);
const started = performance.now();

try {
  const result = index.buildBatches(model, embeddingBatches(store, model, batchSize));
  const elapsedMs = performance.now() - started;
  console.log(JSON.stringify({
    databasePath,
    indexPath,
    ...result,
    elapsedMs,
    recordsPerSecond: result.count / (elapsedMs / 1_000),
  }, null, 2));
} finally {
  store.close();
}

function* embeddingBatches(store: NmgStore, model: string, limit: number) {
  let cursor = "";
  while (true) {
    const rows = store.storedEmbeddings(model, cursor, limit);
    if (rows.length === 0) return;
    yield rows;
    cursor = rows.at(-1)!.memoryId;
  }
}
