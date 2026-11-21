import { MemoryEngine } from "../../src/core/memory/engine.ts";
import { SqliteMemoryBackend } from "../../src/core/memory/sqlite-backend.ts";
import {
  HttpMemoryService,
  HTTP_MEMORY_SEARCH_PROFILE,
} from "../../src/integration/memory-http-service.ts";
import type { EmbeddingClient } from "../../src/core/embedding-provider.ts";
import { EmbeddingPreparation } from "./embedding-session.mjs";

export const CORE_SOURCE = "workspace:src";
export const AML_SEARCH_PROFILE = HTTP_MEMORY_SEARCH_PROFILE;

/** Bind the shared HTTP memory service to a request-scoped cloud snapshot. */
export class AmlMemoryService extends HttpMemoryService {
  constructor(key: string, client?: EmbeddingClient, options: { allowBackfill?: boolean } = {}) {
    const backend = new SqliteMemoryBackend(`/tmp/nmg/${key}.sqlite`, key, true);
    backend.activateSnapshot();
    super(new MemoryEngine(backend), client, {
      ...options,
      isDeferredEmbedding: (error) => error instanceof EmbeddingPreparation,
    });
  }
}
