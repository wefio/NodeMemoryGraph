import type { EmbeddingClient } from "../core/embedding-provider.ts";
import type { MemoryVectorIndex, MemoryVectorQuery } from "../core/memory/backend.ts";
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

type IndexClient = Pick<EmbeddingClient, "indexId" | "embedDocuments" | "embedQueries">;
type IndexUpdate = { pending: boolean; task: Promise<void> };

/** Provider I/O stays outside SQLite transactions. Missing vectors remain durable work. */
export class LocalMemoryEmbeddings {
  private readonly configured: () => EmbeddingClient | undefined;
  private readonly jobs = new Map<MemoryVectorIndex, Map<string, IndexUpdate>>();
  private readonly failures = new Map<string, number>();
  private closing = false;

  constructor(configured: () => EmbeddingClient | undefined) {
    this.configured = configured;
  }

  async query(
    text: string,
    params: NmgSearchParams,
    indexes: MemoryVectorIndex[],
  ): Promise<{
    semantic?: MemoryVectorQuery;
    reason?: string;
  }> {
    if (params.retrievalMode === "fts5") return {};
    const client = params.retrievalMode === "hashing" ? hashingClient : this.configured();
    if (!client)
      return params.retrievalMode === "hybrid" || params.retrievalMode === "qwen3"
        ? { reason: "embedding_unavailable" }
        : {};
    if (this.coolingDown(client)) return { reason: "embedding_unavailable" };
    for (const index of indexes) this.schedule(index, client);
    if (!indexes.some((index) => index.has(client.indexId)))
      return { reason: "embedding_index_not_ready" };
    return this.requestVector(text, params, client, indexes, vectorMode(params.retrievalMode));
  }

  private async requestVector(
    text: string,
    params: NmgSearchParams,
    client: IndexClient,
    indexes: MemoryVectorIndex[],
    mode: MemoryVectorQuery["mode"],
  ): Promise<{ semantic?: MemoryVectorQuery; reason?: string }> {
    const budget = params.autoRecall
      ? new RecallBudget(Math.min(DAEMON_AUTOMATIC_RECALL_MAX_MS, params.autoRecallBudgetMs ?? 850))
      : undefined;
    try {
      const load = () => client.embedQueries([text]);
      const [vector] = budget ? await budget.run("embedding", load) : await load();
      if (!vector?.length || !vector.every(Number.isFinite))
        throw new Error("Invalid query vector");
      if (!indexes.some((index) => index.has(client.indexId, vector.length)))
        return { reason: "embedding_index_not_ready" };
      return {
        semantic: {
          indexId: client.indexId,
          vector,
          granularity: params.vectorGranularity ?? "records",
          mode,
        },
      };
    } catch {
      if (!budget?.expired) this.failures.set(client.indexId, Date.now() + 30_000);
      return {
        reason: budget?.expired ? "automatic_recall_embedding_deadline" : "embedding_unavailable",
      };
    } finally {
      budget?.close();
    }
  }

  afterWrite(index?: MemoryVectorIndex): void {
    const client = this.configured();
    if (index && client) this.schedule(index, client);
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(
      [...this.jobs.values()].flatMap((jobs) => [...jobs.values()].map(({ task }) => task)),
    );
  }

  private schedule(index: MemoryVectorIndex, client: IndexClient): void {
    if (this.closing || this.coolingDown(client)) return;
    const jobs = this.jobs.get(index) ?? new Map<string, IndexUpdate>();
    this.jobs.set(index, jobs);
    const existing = jobs.get(client.indexId);
    if (existing) {
      existing.pending = true;
      return;
    }
    const job: IndexUpdate = { pending: false, task: Promise.resolve() };
    job.task = Promise.resolve()
      .then(() => this.indexBatch(index, client, job))
      .catch(() => this.failures.set(client.indexId, Date.now() + 30_000))
      .then(() => {
        jobs.delete(client.indexId);
      });
    jobs.set(client.indexId, job);
  }

  private async indexBatch(
    index: MemoryVectorIndex,
    client: IndexClient,
    job: IndexUpdate,
  ): Promise<void> {
    do {
      job.pending = false;
      const documents = index.pending(client.indexId, 32);
      if (documents.length === 0) return;
      const vectors = await client.embedDocuments(documents.map((document) => document.text));
      index.save(client.indexId, documents, vectors);
    } while (job.pending && !this.closing);
  }

  private coolingDown(client: IndexClient): boolean {
    return Date.now() < (this.failures.get(client.indexId) ?? 0);
  }
}

function vectorMode(mode: NmgSearchParams["retrievalMode"]): MemoryVectorQuery["mode"] {
  return mode === "qwen3" || mode === "hashing" ? "vector" : "hybrid";
}
