import type { EmbeddingProfileName } from "../openai-embedding.ts";

export function optionalNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function profile(
  environment: NodeJS.ProcessEnv,
  fallback: EmbeddingProfileName,
): EmbeddingProfileName {
  return (environment.NMG_EMBED_PROFILE as EmbeddingProfileName | undefined) ?? fallback;
}

export function requiredValue(value: string | undefined, description: string): string {
  if (!value?.trim()) throw new Error(`${description} is required`);
  return value;
}
