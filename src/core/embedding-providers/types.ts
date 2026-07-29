export interface EmbeddingClient {
  readonly indexId: string;
  readonly model: string;
  readonly profile: string;
  embed(inputs: string[]): Promise<number[][]>;
  embedDocuments(inputs: string[]): Promise<number[][]>;
  embedQueries(inputs: string[]): Promise<number[][]>;
}

export interface EmbeddingProviderFactory {
  readonly name: string;
  create(environment: NodeJS.ProcessEnv): EmbeddingClient;
}
