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
  target: "records" | "leaves" | "nodes";
  label: string;
  read(cursor: string, limit: number, indexId: string): EmbeddingSyncDocument[];
  write(indexId: string, documents: EmbeddingSyncDocument[], vectors: number[][]): void;
}

interface EmbeddingSyncOptions {
  /** Run at most this many batches, then return with the remaining records
   *  still queued. Used by the per-operation drain so one remember/search
   *  tops up only a bounded slice and a rate-limited provider is never hit
   *  with a full backfill in a single call. Omit for a full backfill. */
  maxBatches?: number;
}

async function syncEmbeddingTarget(
  store: NmgStore,
  client: RecordEmbeddingClient,
  batchSize: number,
  target: EmbeddingSyncTarget,
  options: EmbeddingSyncOptions = {},
): Promise<RecordEmbeddingSyncResult> {
  const limit = Math.max(1, Math.min(Math.trunc(batchSize), 2_048));
  const maxBatches = options.maxBatches === undefined ? Infinity : Math.max(1, options.maxBatches);
  let indexed = 0;
  let batches = 0;
  store.beginEmbeddingIndex({
    indexId: client.indexId,
    model: client.model ?? client.indexId,
    profile: client.profile ?? "external",
    targets: [target.target],
  });
  try {
    let cursor = "";
    let exhausted = false;
    while (batches < maxBatches) {
      const documents = target.read(cursor, limit, client.indexId);
      if (documents.length === 0) {
        exhausted = true;
        break;
      }
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
      batches += 1;
      cursor = documents.at(-1)!.id;
    }
    // A bounded run that reached its batch cap leaves the index mid-flight
    // (records still queued); only a run that drained everything is complete.
    if (exhausted) {
      store.completeEmbeddingIndex(client.indexId);
    }
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
  options: EmbeddingSyncOptions = {},
): Promise<RecordEmbeddingSyncResult> {
  return syncEmbeddingTarget(
    store,
    client,
    batchSize,
    {
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
    },
    options,
  );
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
  options: EmbeddingSyncOptions = {},
): Promise<RecordEmbeddingSyncResult> {
  return syncEmbeddingTarget(
    store,
    client,
    batchSize,
    {
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
    },
    options,
  );
}

/** Incrementally embeds node-level semantic summaries for coarse routing. */
export async function syncNodeEmbeddings(
  store: NmgStore,
  client: RecordEmbeddingClient,
  batchSize = 64,
  options: EmbeddingSyncOptions = {},
): Promise<RecordEmbeddingSyncResult> {
  return syncEmbeddingTarget(
    store,
    client,
    batchSize,
    {
      target: "nodes",
      label: "memory nodes",
      read: (cursor, limit, indexId) =>
        store.nodeEmbeddingDocuments(cursor, limit, indexId).map((document) => ({
          id: document.nodeId,
          text: document.text,
        })),
      write: (indexId, documents, vectors) =>
        store.upsertExternalNodeEmbeddings(
          indexId,
          documents.map((document, index) => ({ nodeId: document.id, vector: vectors[index]! })),
        ),
    },
    options,
  );
}
