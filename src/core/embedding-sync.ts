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

interface EmbeddingSyncDocument {
  id: string;
  text: string;
}

interface EmbeddingSyncTarget {
  target: "records" | "leaves";
  label: string;
  read(cursor: string, limit: number, indexId: string): EmbeddingSyncDocument[];
  write(indexId: string, documents: EmbeddingSyncDocument[], vectors: number[][]): void;
}

async function syncEmbeddingTarget(
  store: NmgStore,
  client: RecordEmbeddingClient,
  batchSize: number,
  target: EmbeddingSyncTarget,
): Promise<RecordEmbeddingSyncResult> {
  const limit = Math.max(1, Math.min(Math.trunc(batchSize), 2_048));
  let indexed = 0;
  store.beginEmbeddingIndex({
    indexId: client.indexId,
    model: client.model ?? client.indexId,
    profile: client.profile ?? "external",
    targets: [target.target],
  });
  try {
    let cursor = "";
    while (true) {
      const documents = target.read(cursor, limit, client.indexId);
      if (documents.length === 0) break;
      const vectors = await client.embedDocuments(documents.map((document) => document.text));
      if (vectors.length !== documents.length) {
        throw new Error(
          `embedding provider returned ${vectors.length} vectors for ` +
            `${documents.length} ${target.label}`,
        );
      }
      vectors.forEach((vector, index) => {
        if (!vector?.length) {
          throw new Error(`embedding provider returned an empty vector at index ${index}`);
        }
      });
      target.write(client.indexId, documents, vectors);
      indexed += documents.length;
      cursor = documents.at(-1)!.id;
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
  return syncEmbeddingTarget(store, client, batchSize, {
    target: "records",
    label: "records",
    read: (cursor, limit, indexId) =>
      store.embeddingDocuments(cursor, limit, indexId).map((document) => ({
        id: document.memoryId,
        text: document.text,
      })),
    write: (indexId, documents, vectors) =>
      store.upsertExternalEmbeddings(
        indexId,
        documents.map((document, index) => ({ memoryId: document.id, vector: vectors[index]! })),
      ),
  });
}

/**
 * Incrementally embeds leaf blocks missing from (or staler than) the selected
 * external index. Block embedding text prefers the semantic summary when one
 * was written (store.leafEmbeddingDocuments), so this is what makes the
 * summary index reachable by vector routing, not only by block FTS.
 */
export async function syncLeafEmbeddings(
  store: NmgStore,
  client: RecordEmbeddingClient,
  batchSize = 64,
): Promise<RecordEmbeddingSyncResult> {
  return syncEmbeddingTarget(store, client, batchSize, {
    target: "leaves",
    label: "leaf blocks",
    read: (cursor, limit, indexId) =>
      store.leafEmbeddingDocuments(cursor, limit, indexId).map((document) => ({
        id: document.blockId,
        text: document.text,
      })),
    write: (indexId, documents, vectors) =>
      store.upsertExternalLeafEmbeddings(
        indexId,
        documents.map((document, index) => ({ blockId: document.id, vector: vectors[index]! })),
      ),
  });
}
