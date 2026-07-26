import type { NmgStore } from "./store.ts";
import type { EmbeddingIndexHealth } from "./types.ts";

export interface RecordEmbeddingClient {
  readonly indexId: string;
  readonly model?: string;
  readonly profile?: string;
  embedDocuments(inputs: string[]): Promise<number[][]>;
}

export interface RecordEmbeddingSyncResult {
  indexed: number;
  health: EmbeddingIndexHealth;
}

/**
 * Incrementally embeds only records missing from the selected external index.
 *
 * SQLite remains the durable work queue: a failed batch is absent from
 * `memory_embeddings` and is selected again on the next call.
 */
export async function syncRecordEmbeddings(
  store: NmgStore,
  client: RecordEmbeddingClient,
  batchSize = 64,
): Promise<RecordEmbeddingSyncResult> {
  const limit = Math.max(1, Math.min(Math.trunc(batchSize), 2_048));
  let indexed = 0;
  store.beginEmbeddingIndex({
    indexId: client.indexId,
    model: client.model ?? client.indexId,
    profile: client.profile ?? "external",
    targets: ["records"],
  });
  try {
    let cursor = "";
    while (true) {
      const documents = store.embeddingDocuments(cursor, limit, client.indexId);
      if (documents.length === 0) break;
      const vectors = await client.embedDocuments(
        documents.map((document) => document.text),
      );
      if (vectors.length !== documents.length) {
        throw new Error(
          `embedding provider returned ${vectors.length} vectors for ` +
            `${documents.length} records`,
        );
      }
      store.upsertExternalEmbeddings(
        client.indexId,
        documents.map((document, index) => {
          const vector = vectors[index];
          if (!vector?.length) {
            throw new Error(`embedding provider returned an empty vector at index ${index}`);
          }
          return { memoryId: document.memoryId, vector };
        }),
      );
      indexed += documents.length;
      cursor = documents.at(-1)!.memoryId;
    }
    store.completeEmbeddingIndex(client.indexId);
    const health = store.embeddingIndexHealth(client.indexId);
    if (!health) throw new Error(`embedding index ${client.indexId} has no health record`);
    return { indexed, health };
  } catch (error) {
    store.failEmbeddingIndex(client.indexId, error);
    throw error;
  }
}
