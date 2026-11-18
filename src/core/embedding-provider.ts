import { cloudflareEmbeddingProvider } from "./embedding-providers/cloudflare.ts";
import { geminiEmbeddingProvider } from "./embedding-providers/gemini.ts";
import { jinaEmbeddingProvider } from "./embedding-providers/jina.ts";
import { openAiEmbeddingProvider } from "./embedding-providers/openai.ts";
import type { EmbeddingFormatStore } from "./embedding-providers/formats.ts";
import type {
  EmbeddingAttempt,
  EmbeddingClient,
  EmbeddingProviderFactory,
} from "./embedding-providers/types.ts";

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
  options: {
    required?: boolean;
    formatStore?: EmbeddingFormatStore;
    observeAttempt?: (provider: EmbeddingProvider, attempt: EmbeddingAttempt) => void;
  } = {},
): EmbeddingClient | undefined {
  const name = configuredProvider(environment) ?? (options.required ? "openai" : undefined);
  if (!name) return undefined;
  const observe = options.observeAttempt;
  return PROVIDERS[name].create(environment, {
    formatStore: options.formatStore,
    observeAttempt: observe && ((attempt) => observe(name, attempt)),
  });
}

export function configuredProvider(
  environment: NodeJS.ProcessEnv = process.env,
): EmbeddingProvider | undefined {
  const value = environment.NMG_EMBED_PROVIDER?.trim().toLowerCase();
  if (!value) return environment.NMG_EMBED_BASE_URL ? "openai" : undefined;
  if (value in PROVIDERS) return value as EmbeddingProvider;
  throw new Error(`unknown embedding provider: ${value}`);
}
