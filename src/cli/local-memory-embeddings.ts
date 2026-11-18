import { setTimeout as delay } from "node:timers/promises";
import type { EmbeddingClient } from "../core/embedding-provider.ts";
import type {
  MemoryVectorCursor,
  MemoryVectorIndex,
  MemoryVectorQuery,
} from "../core/memory/backend.ts";
import { HashingVectorEmbedder } from "../core/vector.ts";
import { memoryEmbeddingModelId } from "../core/store/search-ranking.ts";
import { DAEMON_AUTOMATIC_RECALL_MAX_MS, RecallBudget } from "../integration/recall-budget.ts";
import type { NmgSearchParams } from "./protocol.ts";

const hashing = new HashingVectorEmbedder();
const hashingClient = {
  indexId: memoryEmbeddingModelId(hashing.model),
  embedDocuments: async (texts: string[]) => texts.map((text) => [...hashing.embed(text)]),
  embedQueries: async (texts: string[]) => texts.map((text) => [...hashing.embed(text)]),
};

type IndexClient = Pick<
  EmbeddingClient,
  "indexId" | "batchSize" | "embedDocuments" | "embedQueries"
>;
const BACKFILL_PAUSE_MS = 250;

type IndexUpdate = { cursor?: MemoryVectorCursor; queued: boolean; dirty: boolean };
type QueryEmbedding = { semantic?: MemoryVectorQuery; reason?: string };

/** Provider I/O stays outside SQLite transactions. Missing vectors remain durable work. */
export class LocalMemoryEmbeddings {
  private readonly configured: () => EmbeddingClient | undefined;
  private readonly unavailable: () => boolean;
  private readonly updates = new WeakMap<MemoryVectorIndex, Map<string, IndexUpdate>>();
  private readonly failures = new Map<string, number>();
  private readonly backfillAbort = new AbortController();
  private backfillTail?: Promise<void>;
  private backfillReadyAt = 0;
  private closing = false;

  constructor(
    configured: () => EmbeddingClient | undefined,
    unavailable: () => boolean = () => false,
  ) {
    this.configured = configured;
    this.unavailable = unavailable;
  }

  async queries(
    texts: string[],
    params: NmgSearchParams,
    indexes: MemoryVectorIndex[],
    signal?: AbortSignal,
  ): Promise<QueryEmbedding[]> {
    if (params.retrievalMode === "fts5") return emptyQueries(texts);
    const client: IndexClient | undefined =
      params.retrievalMode === "hashing" ? hashingClient : this.configured();
    if (!client)
      return this.unavailable() ||
        params.retrievalMode === "hybrid" ||
        params.retrievalMode === "qwen3"
        ? emptyQueries(texts, "embedding_unavailable")
        : emptyQueries(texts);
    if (this.coolingDown(client)) return emptyQueries(texts, "embedding_unavailable");
    for (const index of indexes) this.schedule(index, client);
    if (!indexes.some((index) => index.has(client.indexId)))
      return emptyQueries(texts, "embedding_index_not_ready");
    const budget = params.autoRecall
      ? new RecallBudget(
          Math.min(DAEMON_AUTOMATIC_RECALL_MAX_MS, params.autoRecallBudgetMs ?? 850),
          signal,
        )
      : undefined;
    try {
      const size = client.batchSize ?? 32;
      const batches: Promise<QueryEmbedding[]>[] = [];
      for (let offset = 0; offset < texts.length; offset += size) {
        const batch = texts.slice(offset, offset + size);
        batches.push(this.requestVectors(batch, params, client, indexes, signal, budget));
      }
      return (await Promise.all(batches)).flat();
    } finally {
      budget?.close();
    }
  }

  private async requestVectors(
    texts: string[],
    params: NmgSearchParams,
    client: IndexClient,
    indexes: MemoryVectorIndex[],
    signal?: AbortSignal,
    budget?: RecallBudget,
  ): Promise<QueryEmbedding[]> {
    try {
      const load = (requestSignal?: AbortSignal) =>
        client.embedQueries(texts, { signal: requestSignal });
      const vectors = budget ? await budget.run("embedding", load) : await load(signal);
      if (vectors.length !== texts.length) throw new Error("Invalid query vector batch");
      return vectors.map((vector) => {
        if (!vector?.length || !vector.every(Number.isFinite))
          return { reason: "embedding_unavailable" };
        if (!indexes.some((index) => index.has(client.indexId, vector.length)))
          return { reason: "embedding_index_not_ready" };
        return {
          semantic: {
            indexId: client.indexId,
            vector,
            granularity: params.vectorGranularity ?? "records",
            mode: vectorMode(params.retrievalMode),
          },
        };
      });
    } catch {
      signal?.throwIfAborted();
      if (!budget?.expired) this.failures.set(client.indexId, Date.now() + 30_000);
      return emptyQueries(
        texts,
        budget?.expired ? "automatic_recall_embedding_deadline" : "embedding_unavailable",
      );
    }
  }

  afterWrite(index?: MemoryVectorIndex): void {
    const client = this.configured();
    if (index && client) this.schedule(index, client, true);
  }

  close(cancelBackfill = false): Promise<void> | undefined {
    this.closing = true;
    if (cancelBackfill) this.backfillAbort.abort();
    return this.backfillTail;
  }

  private schedule(index: MemoryVectorIndex, client: IndexClient, changed = false): void {
    if (this.closing || this.coolingDown(client)) return;
    const updates = this.updates.get(index) ?? new Map<string, IndexUpdate>();
    this.updates.set(index, updates);
    const update = updates.get(client.indexId) ?? { queued: false, dirty: false };
    updates.set(client.indexId, update);
    if (changed) {
      update.cursor = undefined;
      update.dirty = true;
    }
    if (update.queued) return;
    update.queued = true;
    this.backfillTail = (this.backfillTail ?? Promise.resolve())
      .then(() => this.indexPage(index, client, update))
      .catch(() => {
        if (!this.backfillAbort.signal.aborted)
          this.failures.set(client.indexId, Date.now() + 30_000);
      })
      .finally(() => {
        update.queued = false;
        if (update.dirty) this.schedule(index, client, true);
      });
  }

  private async indexPage(
    index: MemoryVectorIndex,
    client: IndexClient,
    update: IndexUpdate,
  ): Promise<void> {
    const signal = this.backfillAbort.signal;
    if (signal.aborted || this.coolingDown(client)) return;
    const wait = this.backfillReadyAt - performance.now();
    if (wait > 0) await delay(wait, undefined, { signal });
    signal.throwIfAborted();
    update.dirty = false;
    const limit = backfillPageSize(client);
    try {
      const documents = index.pending(client.indexId, limit, update.cursor);
      if (!documents.length) {
        update.cursor = undefined;
        return;
      }
      const texts = [...new Set(documents.map((document) => document.text))];
      const vectors = await client.embedDocuments(texts, { signal, chunkConcurrency: 1 });
      signal.throwIfAborted();
      if (vectors.length !== texts.length) throw new Error("Invalid document vector batch");
      const byText = new Map(texts.map((text, i) => [text, vectors[i]!]));
      index.save(
        client.indexId,
        documents,
        documents.map(({ text }) => byText.get(text)!),
      );
      if (!update.dirty) update.cursor = documents.length === limit ? documents.at(-1) : undefined;
    } finally {
      this.backfillReadyAt = performance.now() + BACKFILL_PAUSE_MS;
    }
  }

  private coolingDown(client: IndexClient): boolean {
    return Date.now() < (this.failures.get(client.indexId) ?? 0);
  }
}

function emptyQueries(texts: string[], reason?: string): QueryEmbedding[] {
  return texts.map(() => (reason ? { reason } : {}));
}

function backfillPageSize(client: IndexClient): number {
  const target = 32;
  const size = client.batchSize;
  return size && Number.isSafeInteger(size) && size > 0 && size <= target
    ? target - (target % size)
    : target;
}

function vectorMode(mode: NmgSearchParams["retrievalMode"]): MemoryVectorQuery["mode"] {
  return mode === "qwen3" || mode === "hashing" ? "vector" : "hybrid";
}
