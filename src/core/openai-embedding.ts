import { createHash } from "node:crypto";

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
    this.indexId = `${this.model}@${createHash("sha256")
      .update(
        JSON.stringify({
          ...(options.indexNamespace ? { indexNamespace: options.indexNamespace } : {}),
          dimensions: this.dimensions ?? null,
          documentTemplate: this.documentTemplate,
          ...(Object.keys(this.documentBody).length ? { documentBody: this.documentBody } : {}),
          profile: this.profile,
          queryInstruction: this.queryTemplate.includes("{instruction}")
            ? this.queryInstruction
            : null,
          queryTemplate: this.queryTemplate,
          ...(Object.keys(this.queryBody).length ? { queryBody: this.queryBody } : {}),
        }),
      )
      .digest("hex")
      .slice(0, 12)}`;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
  }

  embedQueries(inputs: string[]): Promise<number[][]> {
    return this.request(
      inputs.map((input) => this.render(this.queryTemplate, input)),
      this.queryBody,
    );
  }

  embedDocuments(inputs: string[]): Promise<number[][]> {
    return this.embed(inputs);
  }

  private render(template: string, text: string): string {
    return template.replaceAll("{instruction}", this.queryInstruction).replaceAll("{text}", text);
  }

  embed(inputs: string[]): Promise<number[][]> {
    return this.request(
      inputs.map((input) => this.render(this.documentTemplate, input)),
      this.documentBody,
    );
  }

  private async request(inputs: string[], extraBody: Record<string, unknown>): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.#apiModel,
        input: inputs,
        ...(this.dimensions ? { dimensions: this.dimensions } : {}),
        ...extraBody,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`embedding server returned ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as {
      data?: Array<{ index: number; embedding: number[] }>;
    };
    const rows = payload.data ?? [];
    if (rows.length !== inputs.length) {
      throw new Error(
        `embedding server returned ${rows.length} vectors for ${inputs.length} inputs`,
      );
    }
    return rows.sort((left, right) => left.index - right.index).map((row) => row.embedding);
  }
}

function requireTextTemplate(template: string): string {
  if (!template.includes("{text}")) {
    throw new Error('embedding template must include "{text}"');
  }
  return template;
}
