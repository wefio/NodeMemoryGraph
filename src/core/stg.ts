/**
 * STG isolated store (docs/stg-isolated-store.md).
 *
 * Three-storage model support without touching NmgStore internals:
 *   - createStgStore: open/create the project-local STG SQLite (Phase 1)
 *   - copyLtgSubsetToStg: usage-driven copy of LTG content into the STG,
 *     each copy carrying a cached_from_ltg marker (Phase 2)
 *   - searchStgFirst: STG-first dual-store search with LTG fallback and
 *     dedupe by sourceMemoryId (Phase 3)
 *
 * STG stores are plain NmgStore instances on separate files: deletable,
 * project-local, never authoritative. LTG remains the sole authority;
 * cached copies are search hints (marker, no re-verification) and are
 * refused by the promotion pipeline (loop guard in promoteMemory).
 */
import { join } from "node:path";

import type { MemoryContext, MemoryMarker, MemoryScope, SearchOptions } from "./types.ts";
import { NmgStore } from "./store.ts";
import type { VectorEmbedder } from "./types.ts";

/** Marker attached to every LTG copy cached in an STG store. */
export function cachedFromLtgMarker(sourceMemoryId: string, cachedAt: string): MemoryMarker {
  return { kind: "cached_from_ltg", attributes: { sourceMemoryId, cachedAt } };
}

/** Project-local STG database path (Phase 1): `<project>/.nmg/stg.sqlite`. */
export function stgStorePath(projectDir: string): string {
  return join(projectDir, ".nmg", "stg.sqlite");
}

/** Open (or create) the project STG store. Deletable — recreating it is free. */
export function createStgStore(
  projectDir: string,
  embedder?: VectorEmbedder,
): NmgStore {
  return new NmgStore(stgStorePath(projectDir), embedder);
}

/**
 * Phase 2 — usage-driven copy of LTG content into the STG store.
 *
 * Selects LTG memories that match the project scope, ranked by actual use
 * (access_count, tie-broken by recency), and copies the top `limit` into
 * `stg` with a cached_from_ltg marker. Not a blind L1/L2 copy: only
 * project-scoped content is eligible, and the rank is usage, so a
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
        Date.parse(right.memory.lastAccessedAt ?? "") - Date.parse(left.memory.lastAccessedAt ?? ""),
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
  if (
    local &&
    local.results.length > 0 &&
    local.activeGraph?.qpp?.trigger === false
  ) {
    return local;
  }
  const shared = ltg.searchContext(query, options);
  if (!local || local.results.length === 0) return shared;
  return mergeStgLtgContexts(local, shared);
}

/** Merge a project STG result with authoritative LTG results. */
export function mergeStgLtgContexts(
  local: MemoryContext,
  shared: MemoryContext,
): MemoryContext {
  // Merge: dedupe by cached sourceMemoryId; keep LTG rows (authoritative).
  const seenLtg = new Set(shared.results.map((result) => result.memory.id));
  const dedupedLocal = local.results.filter(
    (result) =>
      !result.memory.markers.some(
        (marker) =>
          marker.kind === "cached_from_ltg" &&
          seenLtg.has(String(marker.attributes?.sourceMemoryId ?? "")),
      ),
  );
  return {
    results: [...dedupedLocal, ...shared.results],
    relations: [
      ...new Map(
        [...(local.relations ?? []), ...shared.relations].map((relation) => [relation.id, relation]),
      ).values(),
    ],
    activeGraph: shared.activeGraph,
    retrieval: shared.retrieval,
    timings: shared.timings,
    filterUsage: shared.filterUsage,
  };
}
