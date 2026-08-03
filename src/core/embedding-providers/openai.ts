import { OpenAIEmbeddingClient, type OpenAIEmbeddingClientOptions } from "../openai-embedding.ts";
import type { EmbeddingProfileName } from "../openai-embedding.ts";
import { optionalNumber, profile } from "./environment.ts";
import type { EmbeddingProviderFactory } from "./types.ts";

export function commonOpenAiOptions(environment: NodeJS.ProcessEnv): OpenAIEmbeddingClientOptions {
  const model = environment.NMG_EMBED_MODEL;
  // BGE-family models ship an instruction-free prompt template; the generic
  // qwen3 "Instruct: ... Query: ..." wrapper breaks their query semantics
  // (measured: evidence rank 14 -> 5 on LongMemEval), so auto-select bge-en
  // unless the user pins NMG_EMBED_PROFILE explicitly.
  const defaultProfile: EmbeddingProfileName = model?.toLowerCase().includes("bge")
    ? "bge-en"
    : "qwen3";
  return {
    baseUrl: environment.NMG_EMBED_BASE_URL,
    apiKey: environment.NMG_EMBED_API_KEY,
    model,
    profile: profile(environment, defaultProfile),
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
