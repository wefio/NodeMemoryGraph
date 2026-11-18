import { createHash } from "node:crypto";

import { optionalNumber, requiredValue } from "./environment.ts";
import { embeddingFormats, type EmbeddingFormats, type EmbeddingFormatStore } from "./formats.ts";
import { embeddingHttpTransport } from "./http.ts";
import type {
  EmbeddingAttemptObserver,
  EmbeddingProviderFactory,
  EmbeddingRequestOptions,
} from "./types.ts";

type GeminiTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export interface GeminiEmbeddingClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  dimensions?: number;
  timeoutMs?: number;
  chunkConcurrency?: number;
  formatStore?: EmbeddingFormatStore;
  observeAttempt?: EmbeddingAttemptObserver;
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
  private readonly modelPath: string;
  private readonly formats?: EmbeddingFormats;
  private readonly observeAttempt?: EmbeddingAttemptObserver;

  constructor(options: GeminiEmbeddingClientOptions) {
    this.apiKey = requiredValue(options.apiKey, "Gemini embedding API key");
    this.baseUrl = (options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(
      /\/$/u,
      "",
    );
    this.model = options.model ?? "gemini-embedding-001";
    this.modelPath = this.model.startsWith("models/") ? this.model : `models/${this.model}`;
    this.dimensions = options.dimensions;
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 10_000));
    this.chunkConcurrency = Math.max(1, Math.floor(options.chunkConcurrency ?? 4));
    this.observeAttempt = options.observeAttempt;
    this.indexId = `gemini:${this.model}@${createHash("sha256")
      .update(JSON.stringify({ dimensions: this.dimensions ?? null, task: "retrieval" }))
      .digest("hex")
      .slice(0, 12)}`;
    this.formats = embeddingFormats(options.formatStore, {
      endpoint: `${this.baseUrl}/${this.modelPath}:batchEmbedContents`,
      model: this.model,
      indexId: this.indexId,
      credential: this.apiKey,
    });
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
    const url = `${this.baseUrl}/${this.modelPath}:batchEmbedContents`;
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
            model: this.modelPath,
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
        observation: this.observeAttempt && { model: this.model, observe: this.observeAttempt },
      },
    );
    const vectors = (payload.embeddings ?? []).map((embedding) => embedding.values ?? []);
    if (vectors.length !== inputs.length || vectors.some((vector) => vector.length === 0)) {
      throw new Error(
        `embedding server returned ${vectors.length} vectors for ${inputs.length} inputs`,
      );
    }
    this.formats?.noteNativeJson(taskType === "RETRIEVAL_DOCUMENT" ? "document" : "query");
    return vectors;
  }
}

export const geminiEmbeddingProvider: EmbeddingProviderFactory = {
  name: "gemini",
  create(environment, options) {
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
      ...options,
    });
  },
};
