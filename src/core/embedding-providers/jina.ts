import { OpenAIEmbeddingClient } from "../openai-embedding.ts";
import { profile, requiredValue } from "./environment.ts";
import { commonOpenAiOptions } from "./openai.ts";
import type { EmbeddingProviderFactory } from "./types.ts";

export const jinaEmbeddingProvider: EmbeddingProviderFactory = {
  name: "jina",
  create(environment) {
    return new OpenAIEmbeddingClient({
      ...commonOpenAiOptions(environment),
      baseUrl: environment.NMG_EMBED_BASE_URL ?? "https://api.jina.ai/v1",
      apiKey: requiredValue(
        environment.NMG_EMBED_API_KEY ?? environment.JINA_API_KEY,
        "Jina embedding API key",
      ),
      model: environment.NMG_EMBED_MODEL ?? "jina-embeddings-v3",
      profile: profile(environment, "plain"),
      indexNamespace: "jina",
      queryBody: { task: "retrieval.query" },
      documentBody: { task: "retrieval.passage" },
    });
  },
};
