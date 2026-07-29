import { OpenAIEmbeddingClient } from "../openai-embedding.ts";
import { profile, requiredValue } from "./environment.ts";
import { commonOpenAiOptions } from "./openai.ts";
import type { EmbeddingProviderFactory } from "./types.ts";

export const cloudflareEmbeddingProvider: EmbeddingProviderFactory = {
  name: "cloudflare",
  create(environment) {
    const accountId = requiredValue(
      environment.NMG_CLOUDFLARE_ACCOUNT_ID ?? environment.CLOUDFLARE_ACCOUNT_ID,
      "Cloudflare account ID",
    );
    return new OpenAIEmbeddingClient({
      ...commonOpenAiOptions(environment),
      baseUrl:
        environment.NMG_EMBED_BASE_URL ??
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
      apiKey: requiredValue(
        environment.NMG_EMBED_API_KEY ?? environment.CLOUDFLARE_API_TOKEN,
        "Cloudflare embedding API key",
      ),
      model: environment.NMG_EMBED_MODEL ?? "@cf/baai/bge-m3",
      profile: profile(environment, "plain"),
      indexNamespace: "cloudflare",
    });
  },
};
