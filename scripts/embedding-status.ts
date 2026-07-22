import { resolve } from "node:path";

import { NmgStore, OpenAIEmbeddingClient } from "../src/index.ts";

const client = new OpenAIEmbeddingClient({
  model: process.env.NMG_EMBED_MODEL,
  profile: process.env.NMG_EMBED_PROFILE as "bge-en" | "plain" | "qwen3" | undefined,
  queryTemplate: process.env.NMG_EMBED_QUERY_TEMPLATE,
  documentTemplate: process.env.NMG_EMBED_DOCUMENT_TEMPLATE,
  dimensions: process.env.NMG_EMBED_DIMENSIONS
    ? Number(process.env.NMG_EMBED_DIMENSIONS)
    : undefined,
});
const databasePath = resolve(process.env.NMG_DB_PATH ?? ".nmg/nmg.sqlite");
const store = new NmgStore(databasePath);

try {
  const health = store.embeddingIndexHealth(client.indexId);
  console.log(
    JSON.stringify(
      health ?? {
        indexId: client.indexId,
        model: client.model,
        profile: client.profile,
        status: "uninitialized",
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
}
