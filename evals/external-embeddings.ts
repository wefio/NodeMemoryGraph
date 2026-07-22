import { resolve } from "node:path";

import { OpenAIEmbeddingClient } from "../src/core/openai-embedding.ts";
import { NmgStore } from "../src/core/store.ts";

export async function indexExternalEmbeddings(dataDirectory: string): Promise<void> {
  if (!process.env.NMG_EMBED_BASE_URL) return;
  const client = new OpenAIEmbeddingClient({
    baseUrl: process.env.NMG_EMBED_BASE_URL,
    apiKey: process.env.NMG_EMBED_API_KEY,
    model: process.env.NMG_EMBED_MODEL,
    profile: process.env.NMG_EMBED_PROFILE as "bge-en" | "plain" | "qwen3" | undefined,
    queryTemplate: process.env.NMG_EMBED_QUERY_TEMPLATE,
    documentTemplate: process.env.NMG_EMBED_DOCUMENT_TEMPLATE,
    dimensions: process.env.NMG_EMBED_DIMENSIONS
      ? Number(process.env.NMG_EMBED_DIMENSIONS)
      : undefined,
  });
  const store = new NmgStore(resolve(dataDirectory, "nmg.sqlite"));
  try {
    store.rebuildLeafBlocks();
    const nodes = store.nodeEmbeddingDocuments("", 2_048, client.indexId);
    const nodeVectors = await client.embed(nodes.map((document) => document.text));
    store.upsertExternalNodeEmbeddings(client.indexId, nodes.map((document, index) => ({
      nodeId: document.nodeId,
      vector: nodeVectors[index]!,
    })));
    const leaves = store.leafEmbeddingDocuments("", 2_048, client.indexId);
    const leafVectors = await client.embed(leaves.map((document) => document.text));
    store.upsertExternalLeafEmbeddings(client.indexId, leaves.map((document, index) => ({
      blockId: document.blockId,
      vector: leafVectors[index]!,
    })));
    store.acknowledgeIndexDelta(nodes.map((document) => document.nodeId));
  } finally {
    store.close();
  }
}
