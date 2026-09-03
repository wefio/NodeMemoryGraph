import type { EmbeddingClient } from "../core/embedding-provider.ts";
import type { NmgStore } from "../core/store.ts";
import type { MemoryContext } from "../core/types.ts";

export type QueryEmbeddingClient = Pick<EmbeddingClient, "embedQueries" | "indexId">;

type SearchOptions = Exclude<Parameters<NmgStore["searchContext"]>[1], undefined>;

export async function searchMemoryContext(
  store: NmgStore,
  embeddingClient: QueryEmbeddingClient | undefined,
  query: string,
  options: SearchOptions,
  degradedReason?: string,
): Promise<MemoryContext> {
  // degradedReason is set by the caller when the embedding provider is known
  // to be unavailable (cooldown after a failure). The search still runs, but
  // lexically and explicitly degraded instead of attempting a provider call
  // that would hang or fail again.
  if (!embeddingClient || options.retrievalMode === "fts5" || degradedReason) {
    return lexicalResult(store, query, options, degradedReason);
  }

  const indexHealth = store.embeddingIndexHealth(embeddingClient.indexId);
  // A partial index is usable: searchContext LEFT-JOINs the vector table, so
  // records without a vector still rank by their lexical score while indexed
  // records get the vector lift. Only a store that never began this index
  // falls back (nothing to query and every call would be a wasted embed).
  // A previously failed/429'd index therefore still serves hybrid from
  // whatever it has, and the per-operation bounded drain keeps converging.
  if (!indexHealth) {
    return lexicalFallback(store, query, options, "embedding_index_not_ready");
  }
  const granularity = options.vectorGranularity ?? "records";
  if (missingVectorTarget(granularity, indexHealth.targets)) {
    return lexicalFallback(store, query, options, "embedding_index_missing_targets");
  }

  const queryVector = await embedQuery(embeddingClient, query);
  if (!queryVector) {
    return lexicalFallback(store, query, options, "embedding_unavailable");
  }
  return {
    ...store.searchContext(
      query,
      { ...options, vectorGranularity: granularity },
      { queryVector, model: embeddingClient.indexId },
    ),
    retrieval: { mode: "hybrid", degraded: false },
  };
}

async function embedQuery(
  client: QueryEmbeddingClient,
  query: string,
): Promise<number[] | undefined> {
  try {
    const vectors = await client.embedQueries([query]);
    return vectors[0]?.length ? vectors[0] : undefined;
  } catch {
    return undefined;
  }
}

/** Lexical search result. Undegraded when no embedding provider is configured;
 *  degraded with the caller-supplied reason when a provider exists but is in
 *  cooldown. */
function lexicalResult(
  store: NmgStore,
  query: string,
  options: SearchOptions,
  degradedReason?: string,
): MemoryContext {
  return {
    ...store.searchContext(query, { ...options, retrievalMode: "fts5" }),
    retrieval: degradedReason
      ? { mode: "lexical", degraded: true, reason: degradedReason }
      : { mode: "lexical", degraded: false },
  };
}

function lexicalFallback(
  store: NmgStore,
  query: string,
  options: SearchOptions,
  reason: string,
): MemoryContext {
  return {
    ...store.searchContext(query, { ...options, retrievalMode: "fts5" }),
    retrieval: { mode: "lexical", degraded: true, reason },
  };
}

function requiredTargets(granularity: string): Array<"nodes" | "leaves" | "records"> {
  if (granularity === "records") return ["records"];
  if (granularity === "hierarchy") return ["nodes", "leaves"];
  return ["nodes", "leaves", "records"];
}

function missingVectorTarget(granularity: string, present: string[]): boolean {
  return requiredTargets(granularity).some((target) => !present.includes(target));
}
