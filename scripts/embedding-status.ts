import { resolve } from "node:path";

import { createEmbeddingClientFromEnv, NmgStore } from "../src/index.ts";

const client = createEmbeddingClientFromEnv(process.env, { required: true })!;
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
