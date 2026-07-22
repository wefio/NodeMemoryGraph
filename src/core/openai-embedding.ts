export interface OpenAIEmbeddingClientOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
  queryInstruction?: string;
}

export class OpenAIEmbeddingClient {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly dimensions?: number;
  readonly queryInstruction: string;

  constructor(options: OpenAIEmbeddingClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:8000/v1").replace(/\/$/u, "");
    this.apiKey = options.apiKey;
    this.model = options.model ?? "Qwen/Qwen3-Embedding-0.6B";
    this.dimensions = options.dimensions;
    this.queryInstruction =
      options.queryInstruction ??
      "Given a memory recall query, retrieve relevant personal history passages that answer it";
  }

  embedQueries(inputs: string[]): Promise<number[][]> {
    return this.embed(inputs.map((input) => this.queryText(input)));
  }

  private queryText(input: string): string {
    if (/^BAAI\/bge-(?:base|large|small)-en(?:-|$)/iu.test(this.model)) {
      return `Represent this sentence for searching relevant passages: ${input}`;
    }
    return `Instruct: ${this.queryInstruction}\nQuery:${input}`;
  }

  async embed(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        input: inputs,
        ...(this.dimensions ? { dimensions: this.dimensions } : {}),
      }),
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
