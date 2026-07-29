import { OpenAIEmbeddingClient, type OpenAIEmbeddingClientOptions } from "../openai-embedding.ts";
import { optionalNumber, profile } from "./environment.ts";
import type { EmbeddingProviderFactory } from "./types.ts";

export function commonOpenAiOptions(environment: NodeJS.ProcessEnv): OpenAIEmbeddingClientOptions {
  return {
    baseUrl: environment.NMG_EMBED_BASE_URL,
    apiKey: environment.NMG_EMBED_API_KEY,
    model: environment.NMG_EMBED_MODEL,
    profile: profile(environment, "qwen3"),
    queryTemplate: environment.NMG_EMBED_QUERY_TEMPLATE,
    documentTemplate: environment.NMG_EMBED_DOCUMENT_TEMPLATE,
    dimensions: optionalNumber(environment.NMG_EMBED_DIMENSIONS),
    timeoutMs: optionalNumber(environment.NMG_EMBED_TIMEOUT_MS),
  };
}

export const openAiEmbeddingProvider: EmbeddingProviderFactory = {
  name: "openai",
  create(environment) {
    return new OpenAIEmbeddingClient(commonOpenAiOptions(environment));
  },
};
