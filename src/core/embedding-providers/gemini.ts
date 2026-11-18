import { createHash } from "node:crypto";

import { optionalNumber, requiredValue } from "./environment.ts";
import { embeddingHttpTransport } from "./http.ts";
import type { EmbeddingProviderFactory, EmbeddingRequestOptions } from "./types.ts";

type GeminiTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export interface GeminiEmbeddingClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  dimensions?: number;
  timeoutMs?: number;
  chunkConcurrency?: number;
}

/** Gemini batchEmbedContents adapter with retrieval-specific task types. */
export class GeminiEmbeddingClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly indexId: string;
  readonly dimensions?: number;
  readonly profile = "gemini-retrieval";
  readonly timeoutMs: number;
  private readonly chunkConcurrency: number;

  constructor(options: GeminiEmbeddingClientOptions) {
    this.apiKey = requiredValue(options.apiKey, "Gemini embedding API key");
    this.baseUrl = (options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(
      /\/$/u,
      "",
    );
    this.model = options.model ?? "gemini-embedding-001";
    this.dimensions = options.dimensions;
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 10_000));
    this.chunkConcurrency = Math.max(1, Math.floor(options.chunkConcurrency ?? 4));
    this.indexId = `gemini:${this.model}@${createHash("sha256")
      .update(JSON.stringify({ dimensions: this.dimensions ?? null, task: "retrieval" }))
      .digest("hex")
      .slice(0, 12)}`;
  }

  embedQueries(inputs: string[], options?: EmbeddingRequestOptions): Promise<number[][]> {
    return this.request(inputs, "RETRIEVAL_QUERY", options);
  }

  embedDocuments(inputs: string[], options?: EmbeddingRequestOptions): Promise<number[][]> {
    return this.request(inputs, "RETRIEVAL_DOCUMENT", options);
  }

  embed(inputs: string[], options?: EmbeddingRequestOptions): Promise<number[][]> {
    return this.embedDocuments(inputs, options);
  }

  private async request(
    inputs: string[],
    taskType: GeminiTaskType,
    options?: EmbeddingRequestOptions,
  ): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const modelPath = this.model.startsWith("models/") ? this.model : `models/${this.model}`;
    const url = `${this.baseUrl}/${modelPath}:batchEmbedContents`;
    const payload = await embeddingHttpTransport(url, this.apiKey, this.chunkConcurrency).json<{
      embeddings?: Array<{ values?: number[] }>;
    }>(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          requests: inputs.map((text) => ({
            model: modelPath,
            content: { parts: [{ text }] },
            taskType,
            ...(this.dimensions ? { outputDimensionality: this.dimensions } : {}),
          })),
        }),
      },
      {
        background: taskType === "RETRIEVAL_DOCUMENT",
        timeoutMs: this.timeoutMs,
        signal: options?.signal,
        retry: false,
      },
    );
    const vectors = (payload.embeddings ?? []).map((embedding) => embedding.values ?? []);
    if (vectors.length !== inputs.length || vectors.some((vector) => vector.length === 0)) {
      throw new Error(
        `embedding server returned ${vectors.length} vectors for ${inputs.length} inputs`,
      );
    }
    return vectors;
  }
}

export const geminiEmbeddingProvider: EmbeddingProviderFactory = {
  name: "gemini",
  create(environment) {
    return new GeminiEmbeddingClient({
      apiKey: requiredValue(
        environment.NMG_EMBED_API_KEY ?? environment.GEMINI_API_KEY,
        "Gemini embedding API key",
      ),
      baseUrl: environment.NMG_EMBED_BASE_URL,
      model: environment.NMG_EMBED_MODEL,
      dimensions: optionalNumber(environment.NMG_EMBED_DIMENSIONS),
      timeoutMs: optionalNumber(environment.NMG_EMBED_TIMEOUT_MS),
      chunkConcurrency: optionalNumber(environment.NMG_EMBED_CHUNK_CONCURRENCY),
    });
  },
};
