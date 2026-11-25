import { setImmediate } from "node:timers/promises";
import type { EmbeddingClient } from "../core/embedding-provider.ts";
import { getRuntimeScheduler, withRuntimePolicy } from "../core/runtime/scheduler.ts";
import type { RuntimePolicy } from "../core/capability-config.ts";
import type {
  MemoryVectorCursor,
  MemoryVectorIndex,
  MemoryVectorQuery,
} from "../core/memory/backend.ts";
import { HashingVectorEmbedder } from "../core/vector.ts";
import { memoryEmbeddingModelId } from "../core/store/search-ranking.ts";
import { saveEmbeddedDocuments } from "../core/memory/vector-backfill.ts";
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
  "indexId" | "batchSize" | "embedDocuments" | "embedDocumentsForStorage" | "embedQueries"
>;
type IndexUpdate = { pending: boolean; task: Promise<void> };
export type QueryEmbedding = { semantic?: MemoryVectorQuery; reason?: string };

/** Provider I/O stays outside SQLite transactions. Missing vectors remain durable work. */
export class LocalMemoryEmbeddings {
  private readonly configured: () => EmbeddingClient | undefined;
  private readonly unavailable: () => boolean;
  private readonly runtime: () => RuntimePolicy | undefined;
  private readonly jobs = new Map<MemoryVectorIndex, Map<string, IndexUpdate>>();
  private readonly failures = new Map<string, number>();
  private closing = false;

  constructor(
    configured: () => EmbeddingClient | undefined,
    unavailable: () => boolean = () => false,
    runtime: () => RuntimePolicy | undefined = () => undefined,
  ) {
    this.configured = configured;
    this.unavailable = unavailable;
    this.runtime = runtime;
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
        client.embedQueries(texts, { signal: requestSignal, probeEncoding: !params.autoRecall });
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

  close(): Promise<void> | undefined {
    this.closing = true;
    return this.pendingBackfill();
  }

  pendingBackfill(): Promise<void> | undefined {
    const tasks = [...this.jobs.values()].flatMap((jobs) =>
      [...jobs.values()].map(({ task }) => task),
    );
    if (tasks.length) return Promise.all(tasks).then(() => undefined);
  }

  private schedule(index: MemoryVectorIndex, client: IndexClient, changed = false): void {
    if (this.closing || this.coolingDown(client)) return;
    const jobs = this.jobs.get(index) ?? new Map<string, IndexUpdate>();
    this.jobs.set(index, jobs);
    const existing = jobs.get(client.indexId);
    if (existing) {
      if (changed) existing.pending = true;
      return;
    }
    const job: IndexUpdate = { pending: false, task: Promise.resolve() };
    job.task = Promise.resolve()
      .then(() => this.indexBatch(index, client, job))
      .catch(() => this.failures.set(client.indexId, Date.now() + 30_000))
      .then(() => {
        jobs.delete(client.indexId);
        if (!jobs.size) this.jobs.delete(index);
        if (job.pending) this.schedule(index, client, true);
      });
    jobs.set(client.indexId, job);
  }

  private async indexBatch(
    index: MemoryVectorIndex,
    client: IndexClient,
    job: IndexUpdate,
  ): Promise<void> {
    const limit = backfillPageSize(client);
    do {
      job.pending = false;
      await this.sweep(index, client, limit);
    } while (job.pending && !this.closing);
  }

  prepareIndex(index: MemoryVectorIndex, client: IndexClient, signal: AbortSignal): Promise<void> {
    return this.sweep(index, client, backfillPageSize(client), signal);
  }

  private async sweep(
    index: MemoryVectorIndex,
    client: IndexClient,
    limit: number,
    signal?: AbortSignal,
  ): Promise<void> {
    let after: MemoryVectorCursor | undefined;
    do {
      signal?.throwIfAborted();
      const hasMore = await withRuntimePolicy(this.runtime(), () =>
        getRuntimeScheduler().runTask(
          async (taskSignal) => {
            const documents = index.pending(client.indexId, limit, after);
            if (!documents.length) return false;
            await saveEmbeddedDocuments(index, client, documents, taskSignal);
            if (documents.length < limit) return false;
            after = documents.at(-1);
            return true;
          },
          {
            priority: "background",
            effect: "write",
            signal,
            label: `embedding_backfill:${client.indexId}`,
          },
        ),
      );
      if (!hasMore) return;
      // Yield between full pages so foreground work stays responsive.
      await setImmediate();
    } while (!this.closing);
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
