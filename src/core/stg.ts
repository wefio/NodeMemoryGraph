/**
 * STG isolated store (docs/design/stg-isolated-store.md).
 *
 * Three-storage model support without touching NmgStore internals:
 *   - createStgStore: open/create the project-local shared STG SQLite (Phase 1)
 *   - copyLtgSubsetToStg: usage-driven copy of LTG content into the STG,
 *     each copy carrying a cached_from_ltg marker (Phase 2)
 *   - searchStgFirst: STG-first dual-store search with LTG fallback and
 *     dedupe by sourceMemoryId (Phase 3)
 *
 * STG stores are plain NmgStore instances in one file per project: deletable,
 * row-isolated by session and never authoritative. Sessionless cached copies
 * are project-shared search hints (marker, no re-verification) and are refused
 * by the promotion pipeline (loop guard in promoteMemory). LTG remains the sole
 * authority.
 */
import { mergeStgLtgContexts, stgConsolidationInput, stgStorePath } from "./stg-projection.ts";
export { mergeStgLtgContexts, stgConsolidationInput, stgStorePath } from "./stg-projection.ts";

import type { MemoryContext, MemoryMarker, MemoryScope, SearchOptions } from "./types.ts";
import { NmgStore } from "./store.ts";
import type { VectorEmbedder } from "./types.ts";

/** Marker attached to every LTG copy cached in an STG store. */
export function cachedFromLtgMarker(sourceMemoryId: string, cachedAt: string): MemoryMarker {
  return { kind: "cached_from_ltg", attributes: { sourceMemoryId, cachedAt } };
}

/** Open (or create) the project's shared STG store. Deletable; recreating it is free. */
export function createStgStore(
  projectDir: string,
  embedder?: VectorEmbedder,
  _sessionId = "default",
): NmgStore {
  return new NmgStore(stgStorePath(projectDir), embedder);
}

/**
 * Delete every provisional memory owned by one session from the project STG.
 * Shared cached_from_ltg rows (session_id NULL) are kept — the session's own
 * scratch work is what expires with it (docs/stg-shared-store-v2 §3.3).
 */
export function purgeSessionFromStg(stg: NmgStore, sessionId: string): number {
  return stg.purgeSession(sessionId);
}

/**
 * Phase 2 — usage-driven copy of LTG content into the STG store.
 *
 * Selects LTG memories that match the project scope, ranked by observed access
 * (access_count, tie-broken by recency), and copies the top `limit` into
 * `stg` with a cached_from_ltg marker. Not a blind L1/L2 copy: only
 * project-scoped content is eligible, and the rank is access demand, so a
 * globally-hot-but-project-cold memory is not copied.
 *
 * Idempotent: a memory already cached (same sourceMemoryId marker) is
 * skipped instead of duplicated.
 *
 * Returns the number of new rows copied.
 */
export function copyLtgSubsetToStg(
  ltg: NmgStore,
  stg: NmgStore,
  options: { scope: MemoryScope; limit?: number },
): number {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  // The scope value doubles as the query term ("atlas" searches the atlas
  // project's memories); an empty query matches nothing (normalize("") is
  // empty). Fall back to "a" when the scope value is not queryable.
  const scopeValue = Object.values(options.scope)[0] ?? "";
  const query = scopeValue.trim().length >= 2 ? scopeValue : "a";
  const candidates = ltg.search(query, { maxTier: 3, limit: 200, scope: options.scope });
  const ranked = candidates
    .sort(
      (left, right) =>
        right.memory.accessCount - left.memory.accessCount ||
        Date.parse(right.memory.lastAccessedAt ?? "") -
          Date.parse(left.memory.lastAccessedAt ?? ""),
    )
    .slice(0, limit);
  const cachedAt = new Date().toISOString();
  let written = 0;
  for (const result of ranked) {
    const memory = result.memory;
    const existing = stg.search(memory.statement, {
      nodeName: result.node.canonicalName,
      scope: options.scope,
      maxTier: 3,
      limit: 50,
    });
    const alreadyCached = existing.some((entry) =>
      entry.memory.markers.some(
        (candidate) =>
          candidate.kind === "cached_from_ltg" &&
          candidate.attributes?.sourceMemoryId === memory.id,
      ),
    );
    if (alreadyCached) continue;
    const marker = cachedFromLtgMarker(memory.id, cachedAt);
    stg.remember({
      statement: memory.statement,
      nodeName: result.node.canonicalName,
      memoryType: memory.memoryType,
      stateKey: memory.stateKey ?? undefined,
      evidence: result.evidence?.content,
      sourceActor: memory.sourceActor,
      truthStatus: memory.truthStatus,
      tier: memory.tier,
      importance: memory.importance,
      scope: options.scope,
      residence: "stg",
      markers: [marker],
      writeReason: "stg_cache_copy",
    });
    written += 1;
  }
  return written;
}

/**
 * Materialize one outcome-qualified, session-local memory into authoritative LTG.
 *
 * This is intentionally a copy across stores rather than `promoteMemory`: STG
 * and LTG are separate SQLite databases.  Cached LTG hints are rejected to
 * prevent a copy loop.  `remember` supplies exact same-scope deduplication, so
 * retrying after a crash is idempotent at the semantic-record boundary.
 */
export function consolidateStgMemoryToLtg(
  stg: NmgStore,
  ltg: NmgStore,
  memoryId: string,
  sessionId?: string,
): ReturnType<NmgStore["remember"]> {
  const context = stg.getContext([memoryId], 0, sessionId);
  const result = context.results.find((candidate) => candidate.memory.id === memoryId);
  if (!result) throw new Error(`STG memory ${memoryId} does not exist`);
  return ltg.remember(stgConsolidationInput(result));
}

/**
 * Withdraw only LTG rows that were automatically materialized from this exact
 * STG source. Pre-existing/manual LTG duplicates carry no source marker and are
 * deliberately left untouched.
 */
export function retractStgConsolidation(ltg: NmgStore, sourceMemoryId: string): string[] {
  const retracted: string[] = [];
  for (const memory of ltg.consolidatedFromStg(sourceMemoryId)) {
    if (ltg.deleteMemory(memory.id)) retracted.push(memory.id);
  }
  return retracted;
}

/**
 * Phase 3 — STG-first dual-store search.
 *
 * Searches the project STG first (local, fast, project-scoped). If the
 * result is sufficient (non-empty and QPP-clear), return it. Otherwise
 * fall back to the shared LTG and merge, deduplicating cached copies by
 * their sourceMemoryId (a cached copy and its LTG original are the same
 * content; the LTG row wins as authoritative).
 */
export function searchStgFirst(
  ltg: NmgStore,
  stg: NmgStore | undefined,
  query: string,
  options: SearchOptions = {},
): MemoryContext {
  const local = stg?.searchContext(query, options);
  if (local && local.results.length > 0 && local.activeGraph?.qpp?.trigger === false) {
    return local;
  }
  const shared = ltg.searchContext(query, options);
  if (!local || local.results.length === 0) return shared;
  return mergeStgLtgContexts(local, shared);
}
