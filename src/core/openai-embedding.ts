import { createHash } from "node:crypto";
import { embeddingHttpTransport } from "./embedding-providers/http.ts";
import type { EmbeddingRequestOptions } from "./embedding-providers/types.ts";

export type EmbeddingProfileName = "bge-en" | "plain" | "qwen3";

export interface OpenAIEmbeddingClientOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  indexNamespace?: string;
  dimensions?: number;
  profile?: EmbeddingProfileName;
  queryInstruction?: string;
  queryTemplate?: string;
  documentTemplate?: string;
  queryBody?: Record<string, unknown>;
  /** Maximum inputs per HTTP request; the client splits larger calls. */
  batchSize?: number;
  /** How many split requests may be in flight at once (default 4). */
  chunkConcurrency?: number;
  documentBody?: Record<string, unknown>;
  timeoutMs?: number;
}

const EMBEDDING_PROFILES: Record<
  EmbeddingProfileName,
  { queryTemplate: string; documentTemplate: string }
> = {
  qwen3: {
    queryTemplate: "Instruct: {instruction}\nQuery:{text}",
    documentTemplate: "{text}",
  },
  "bge-en": {
    queryTemplate: "Represent this sentence for searching relevant passages: {text}",
    documentTemplate: "{text}",
  },
  plain: {
    queryTemplate: "{text}",
    documentTemplate: "{text}",
  },
};

export class OpenAIEmbeddingClient {
  readonly baseUrl: string;
  readonly apiKey?: string;
  /** Normalized model name — the index identity used for memory_embeddings
   *  matching and storage. BAAI/bge-small-en-v1.5 and bge-small-en-v1.5 are
   *  the same model; normalizing keeps one model → one index identity, so two
   *  eval runs pinning different spellings no longer split into duplicate
   *  vectors. */
  readonly model: string;
  /** Raw model name exactly as configured — what the API receives. */
  readonly #apiModel: string;
  readonly indexId: string;
  readonly dimensions?: number;
  readonly batchSize: number;
  readonly chunkConcurrency: number;
  readonly profile: EmbeddingProfileName;
  readonly queryInstruction: string;
  readonly queryTemplate: string;
  readonly documentTemplate: string;
  readonly queryBody: Record<string, unknown>;
  readonly documentBody: Record<string, unknown>;
  readonly timeoutMs: number;

  constructor(options: OpenAIEmbeddingClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:8000/v1").replace(/\/$/u, "");
    this.apiKey = options.apiKey;
    const rawModel = options.model ?? "Qwen/Qwen3-Embedding-0.6B";
    this.#apiModel = rawModel;
    this.model = rawModel.replace(/^BAAI\//i, "");
    this.dimensions = options.dimensions;
    this.batchSize = Math.max(1, Math.floor(options.batchSize ?? 10));
    this.chunkConcurrency = Math.max(1, Math.floor(options.chunkConcurrency ?? 4));
    this.profile = options.profile ?? "qwen3";
    this.queryInstruction =
      options.queryInstruction ??
      "Given a memory recall query, retrieve relevant personal history passages that answer it";
    const profile = EMBEDDING_PROFILES[this.profile];
    if (!profile) throw new Error(`unknown embedding profile: ${this.profile}`);
    this.queryTemplate = requireTextTemplate(options.queryTemplate ?? profile.queryTemplate);
    this.documentTemplate = requireTextTemplate(
      options.documentTemplate ?? profile.documentTemplate,
    );
    this.queryBody = options.queryBody ?? {};
    this.documentBody = options.documentBody ?? {};
    this.indexId = indexIdentity({
      model: this.model,
      ...(options.indexNamespace ? { indexNamespace: options.indexNamespace } : {}),
      dimensions: this.dimensions,
      documentTemplate: this.documentTemplate,
      documentBody: this.documentBody,
      profile: this.profile,
      queryTemplate: this.queryTemplate,
      queryInstruction: this.queryInstruction,
      queryBody: this.queryBody,
    });
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 10_000));
  }

  embedQueries(inputs: string[], options?: EmbeddingRequestOptions): Promise<number[][]> {
    return this.request(
      inputs.map((input) => this.render(this.queryTemplate, input)),
      this.queryBody,
      false,
      options,
    );
  }

  embedDocuments(inputs: string[], options?: EmbeddingRequestOptions): Promise<number[][]> {
    return this.embed(inputs, options);
  }

  private render(template: string, text: string): string {
    return template.replaceAll("{instruction}", this.queryInstruction).replaceAll("{text}", text);
  }

  embed(inputs: string[], options?: EmbeddingRequestOptions): Promise<number[][]> {
    return this.request(
      inputs.map((input) => this.render(this.documentTemplate, input)),
      this.documentBody,
      true,
      options,
    );
  }

  /**
   * Some compatible-mode providers reject batches above a small cap (DashScope
   * text-embedding-v4: "batch size is invalid, it should not be larger than 10"),
   * so inputs are chunked here instead of relying on the server.
   */
  private async request(
    inputs: string[],
    extraBody: Record<string, unknown>,
    background: boolean,
    options: EmbeddingRequestOptions = {},
  ): Promise<number[][]> {
    if (inputs.length === 0) return [];
    if (inputs.length <= this.batchSize)
      return this.requestBatch(inputs, extraBody, background, options.signal);
    return this.requestChunked(inputs, extraBody, background, options);
  }

  /**
   * Chunks are independent HTTP calls, so a few of them run concurrently.
   * Sequential chunking serializes a large Add behind provider round trips;
   * under 16 concurrent writers that is the difference between ~30 serial calls
   * and ~8 rounds. Results are stitched back in input order.
   */
  private async requestChunked(
    inputs: string[],
    extraBody: Record<string, unknown>,
    background: boolean,
    options: EmbeddingRequestOptions,
  ): Promise<number[][]> {
    const chunks: string[][] = [];
    for (let offset = 0; offset < inputs.length; offset += this.batchSize) {
      chunks.push(inputs.slice(offset, offset + this.batchSize));
    }
    const results: number[][][] = new Array(chunks.length);
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const concurrency = Math.max(
      1,
      Math.min(this.chunkConcurrency, options.chunkConcurrency ?? this.chunkConcurrency),
    );
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const index = next++;
        results[index] = await this.requestBatch(chunks[index], extraBody, background, signal);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
      return results.flat();
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  }

  private async requestBatch(
    inputs: string[],
    extraBody: Record<string, unknown>,
    background: boolean,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    const body = JSON.stringify({
      model: this.#apiModel,
      input: inputs,
      ...(this.dimensions ? { dimensions: this.dimensions } : {}),
      ...extraBody,
    });
    const url = `${this.baseUrl}/embeddings`;
    const payload = await embeddingHttpTransport(url, this.apiKey, this.chunkConcurrency).json<{
      data?: Array<{ index: number; embedding: number[] }>;
    }>(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body,
      },
      { background, timeoutMs: this.timeoutMs, signal },
    );
    const rows = payload.data ?? [];
    if (rows.length !== inputs.length) {
      throw new Error(
        `embedding server returned ${rows.length} vectors for ${inputs.length} inputs`,
      );
    }
    return rows.sort((left, right) => left.index - right.index).map((row) => row.embedding);
  }
}

/**
 * The stored-vector identity: any change to the model, dimensions, templates or
 * per-call bodies means existing embeddings cannot be reused. Serialisation order
 * is part of the contract, so keep the spread order identical when editing.
 */
function indexIdentity(input: {
  model: string;
  indexNamespace?: string;
  dimensions?: number;
  documentTemplate: string;
  documentBody: Record<string, unknown>;
  profile: EmbeddingProfileName;
  queryTemplate: string;
  queryInstruction: string;
  queryBody: Record<string, unknown>;
}): string {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        ...(input.indexNamespace ? { indexNamespace: input.indexNamespace } : {}),
        dimensions: input.dimensions ?? null,
        documentTemplate: input.documentTemplate,
        ...(Object.keys(input.documentBody).length ? { documentBody: input.documentBody } : {}),
        profile: input.profile,
        queryInstruction: input.queryTemplate.includes("{instruction}")
          ? input.queryInstruction
          : null,
        queryTemplate: input.queryTemplate,
        ...(Object.keys(input.queryBody).length ? { queryBody: input.queryBody } : {}),
      }),
    )
    .digest("hex")
    .slice(0, 12);
  return `${input.model}@${fingerprint}`;
}

function requireTextTemplate(template: string): string {
  if (!template.includes("{text}")) {
    throw new Error('embedding template must include "{text}"');
  }
  return template;
}
