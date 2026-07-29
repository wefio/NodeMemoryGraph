import { resolve } from "node:path";

import { createEmbeddingClientFromEnv } from "../src/core/embedding-provider.ts";
import { NmgStore } from "../src/core/store.ts";

export async function indexExternalEmbeddings(dataDirectory: string): Promise<void> {
  const client = createEmbeddingClientFromEnv();
  if (!client) return;
  const store = new NmgStore(resolve(dataDirectory, "nmg.sqlite"));
  try {
    store.rebuildLeafBlocks();
    const nodes = store.nodeEmbeddingDocuments("", 2_048, client.indexId);
    const nodeVectors = await client.embed(nodes.map((document) => document.text));
    store.upsertExternalNodeEmbeddings(
      client.indexId,
      nodes.map((document, index) => ({
        nodeId: document.nodeId,
        vector: nodeVectors[index]!,
      })),
    );
    const leaves = store.leafEmbeddingDocuments("", 2_048, client.indexId);
    const leafVectors = await client.embed(leaves.map((document) => document.text));
    store.upsertExternalLeafEmbeddings(
      client.indexId,
      leaves.map((document, index) => ({
        blockId: document.blockId,
        vector: leafVectors[index]!,
      })),
    );
    store.acknowledgeIndexDelta(nodes.map((document) => document.nodeId));
  } finally {
    store.close();
  }
}
