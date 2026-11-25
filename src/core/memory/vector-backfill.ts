import type { EmbeddingClient } from "../embedding-provider.ts";
import { getRuntimeScheduler } from "../runtime/scheduler.ts";
import type { MemoryVectorDocument, MemoryVectorIndex } from "./backend.ts";

/** Validate a complete vector batch before publishing it to the index. */
export async function saveEmbeddedDocuments(
  index: MemoryVectorIndex,
  client: Pick<EmbeddingClient, "indexId" | "embedDocuments" | "embedDocumentsForStorage">,
  documents: readonly MemoryVectorDocument[],
  signal: AbortSignal,
): Promise<void> {
  const texts = [...new Set(documents.map(({ text }) => text))];
  const options = { signal };
  const vectors = await (client.embedDocumentsForStorage?.(texts, options) ??
    client.embedDocuments(texts, options));
  signal.throwIfAborted();
  getRuntimeScheduler().runCpuSlice(() => {
    if (vectors.length !== texts.length) throw new Error("Invalid document vector batch");
    const byText = new Map(texts.map((text, i) => [text, vectors[i]!]));
    index.save(
      client.indexId,
      documents,
      documents.map(({ text }) => byText.get(text)!),
    );
  });
}
