export interface OpenAiCompletionOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
  fetch?: typeof fetch;
}

/** Host-neutral OpenAI-compatible text completion transport. Domain prompts
 * remain with their caller; this class owns only request and response mechanics. */
export class OpenAiCompletionClient {
  readonly model: string;
  readonly baseUrl: string;
  readonly #apiKey?: string;
  readonly #timeoutMs: number;
  readonly #maxTokens: number;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiCompletionOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxTokens = options.maxTokens ?? 600;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      stream: false,
      max_tokens: this.#maxTokens,
      temperature: 0,
    };
    if (/deepseek/i.test(this.baseUrl) || /deepseek/i.test(this.model)) {
      body.thinking = { type: "disabled" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`summary endpoint HTTP ${response.status}`);
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const content = payload.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("summary endpoint returned empty content");
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}
