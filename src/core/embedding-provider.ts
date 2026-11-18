import { cloudflareEmbeddingProvider } from "./embedding-providers/cloudflare.ts";
import { geminiEmbeddingProvider } from "./embedding-providers/gemini.ts";
import { jinaEmbeddingProvider } from "./embedding-providers/jina.ts";
import { openAiEmbeddingProvider } from "./embedding-providers/openai.ts";
import type { EmbeddingFormatStore } from "./embedding-providers/formats.ts";
import type { EmbeddingClient, EmbeddingProviderFactory } from "./embedding-providers/types.ts";

const PROVIDERS = {
  cloudflare: cloudflareEmbeddingProvider,
  gemini: geminiEmbeddingProvider,
  jina: jinaEmbeddingProvider,
  openai: openAiEmbeddingProvider,
} satisfies Record<string, EmbeddingProviderFactory>;

export type EmbeddingProvider = keyof typeof PROVIDERS;
export type { EmbeddingClient } from "./embedding-providers/types.ts";

/** Builds the configured local or hosted embedding client without exposing keys. */
export function createEmbeddingClientFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
  options: { required?: boolean; formatStore?: EmbeddingFormatStore } = {},
): EmbeddingClient | undefined {
  const name = configuredProvider(environment);
  if (!name) {
    if (!options.required) return undefined;
    return openAiEmbeddingProvider.create(environment, options.formatStore);
  }
  const provider: EmbeddingProviderFactory = PROVIDERS[name];
  return provider.create(environment, options.formatStore);
}

export function configuredProvider(
  environment: NodeJS.ProcessEnv = process.env,
): EmbeddingProvider | undefined {
  const value = environment.NMG_EMBED_PROVIDER?.trim().toLowerCase();
  if (!value) return environment.NMG_EMBED_BASE_URL ? "openai" : undefined;
  if (value in PROVIDERS) return value as EmbeddingProvider;
  throw new Error(`unknown embedding provider: ${value}`);
}
