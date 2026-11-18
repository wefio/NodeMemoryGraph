export interface EmbeddingRequestOptions {
  signal?: AbortSignal;
  /** An optional lower parallelism bound for this call's document chunks. */
  chunkConcurrency?: number;
}

export interface EmbeddingClient {
  readonly indexId: string;
  readonly model: string;
  readonly profile: string;
  /** Maximum items in one provider request, when the client splits a larger batch. */
  readonly batchSize?: number;
  embed(inputs: string[], options?: EmbeddingRequestOptions): Promise<number[][]>;
  embedDocuments(inputs: string[], options?: EmbeddingRequestOptions): Promise<number[][]>;
  embedQueries(inputs: string[], options?: EmbeddingRequestOptions): Promise<number[][]>;
}

export interface EmbeddingProviderFactory {
  readonly name: string;
  create(environment: NodeJS.ProcessEnv): EmbeddingClient;
}
