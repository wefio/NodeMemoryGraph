import { MemoryEngine } from "../../src/core/memory/engine.ts";
import { SqliteMemoryBackend } from "../../src/core/memory/sqlite-backend.ts";
import {
  HttpMemoryService,
  HTTP_MEMORY_SEARCH_PROFILE,
} from "../../src/integration/memory-http-service.ts";
import type { EmbeddingClient } from "../../src/core/embedding-provider.ts";
import { ResourceLockManager, UnifiedRuntimeScheduler } from "../../src/core/runtime/scheduler.ts";
import { SchedulingDomain } from "../../src/core/runtime/worker-pool.ts";
import {
  bindMemoryEngineConfig,
  resolveEffectiveNmgConfig,
} from "../../src/integration/runtime-config.ts";
import { EmbeddingPreparation } from "./embedding-session.mjs";

export const CORE_SOURCE = "workspace:src";
export const AML_SEARCH_PROFILE = HTTP_MEMORY_SEARCH_PROFILE;

/** Bind the shared HTTP memory service to a request-scoped cloud snapshot. */
export class AmlMemoryService extends HttpMemoryService {
  constructor(
    key: string,
    client?: EmbeddingClient,
    options: { allowBackfill?: boolean; capabilityConfig?: string } = {},
  ) {
    const config = options.capabilityConfig
      ? resolveEffectiveNmgConfig({
          l1: JSON.parse(options.capabilityConfig),
          l1Source: "NMG_CAPABILITY_CONFIG",
        })
      : undefined;
    const backend = new SqliteMemoryBackend(`/tmp/nmg/${key}.sqlite`, key, true);
    backend.activateSnapshot();
    // A queue that starts work from a different request cannot use this request's
    // SQLite or embedding handles. Workers have no packaged local thread entry.
    const scheduler = new UnifiedRuntimeScheduler({
      domain: new SchedulingDomain("aml-request"),
      locks: new ResourceLockManager(),
    });
    const graphs = config ? bindMemoryEngineConfig(config) : {};
    super(new MemoryEngine(backend, undefined, { ...graphs, scheduler }), client, {
      allowBackfill: options.allowBackfill,
      capabilities: config,
      isDeferredEmbedding: (error) => error instanceof EmbeddingPreparation,
    });
  }
}
