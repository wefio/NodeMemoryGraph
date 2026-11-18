import type { EmbeddingFormatStore, EmbeddingStorageVector } from "./formats.ts";

export interface EmbeddingRequestOptions {
  signal?: AbortSignal;
  /** An optional lower parallelism bound for this call's document chunks. */
  chunkConcurrency?: number;
  /** Use an already verified format, but skip new probes on a latency-sensitive request. */
  probeEncoding?: boolean;
}

export interface EmbeddingClient {
  readonly indexId: string;
  readonly model: string;
  readonly profile: string;
  /** Maximum items in one provider request, when the client splits a larger batch. */
  readonly batchSize?: number;
  embed(inputs: string[], options?: EmbeddingRequestOptions): Promise<number[][]>;
  embedDocuments(inputs: string[], options?: EmbeddingRequestOptions): Promise<number[][]>;
  embedDocumentsForStorage?(
    inputs: string[],
    options?: EmbeddingRequestOptions,
  ): Promise<EmbeddingStorageVector[]>;
  embedQueries(inputs: string[], options?: EmbeddingRequestOptions): Promise<number[][]>;
}

export interface EmbeddingProviderFactory {
  readonly name: string;
  create(environment: NodeJS.ProcessEnv, formatStore?: EmbeddingFormatStore): EmbeddingClient;
}
