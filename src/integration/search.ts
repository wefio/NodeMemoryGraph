import type { EmbeddingClient } from "../core/embedding-provider.ts";
import type { NmgStore } from "../core/store.ts";
import type { MemoryContext } from "../core/types.ts";

export type QueryEmbeddingClient = Pick<EmbeddingClient, "embedQueries" | "indexId">;

export async function searchMemoryContext(
  store: NmgStore,
  embeddingClient: QueryEmbeddingClient | undefined,
  query: string,
  options: Parameters<NmgStore["searchContext"]>[1],
): Promise<MemoryContext> {
  const vectorGranularity = options?.vectorGranularity ?? "records";
  if (!embeddingClient || options?.retrievalMode === "fts5") {
    return {
      ...store.searchContext(query, { ...options, retrievalMode: "fts5" }),
      retrieval: { mode: "lexical", degraded: false },
    };
  }

  const indexHealth = store.embeddingIndexHealth(embeddingClient.indexId);
  if (!indexHealth?.lastSucceededAt) {
    return lexicalFallback(store, query, options, "embedding_index_not_ready");
  }
  const requiredTargets: Array<"nodes" | "leaves" | "records"> =
    vectorGranularity === "records"
      ? ["records"]
      : vectorGranularity === "hierarchy"
        ? ["nodes", "leaves"]
        : ["nodes", "leaves", "records"];
  if (requiredTargets.some((target) => !indexHealth.targets.includes(target))) {
    return lexicalFallback(store, query, options, "embedding_index_missing_targets");
  }

  let queryVector: number[];
  try {
    const vectors = await embeddingClient.embedQueries([query]);
    if (!vectors[0]?.length) throw new Error("embedding provider returned no query vector");
    queryVector = vectors[0];
  } catch {
    return lexicalFallback(store, query, options, "embedding_unavailable");
  }
  return {
    ...store.searchContext(
      query,
      { ...options, vectorGranularity },
      { queryVector, model: embeddingClient.indexId },
    ),
    retrieval: { mode: "hybrid", degraded: false },
  };
}

function lexicalFallback(
  store: NmgStore,
  query: string,
  options: Parameters<NmgStore["searchContext"]>[1],
  reason: "embedding_index_missing_targets" | "embedding_index_not_ready" | "embedding_unavailable",
): MemoryContext {
  return {
    ...store.searchContext(query, { ...options, retrievalMode: "fts5" }),
    retrieval: { mode: "lexical", degraded: true, reason },
  };
}
