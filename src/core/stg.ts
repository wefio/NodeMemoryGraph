/**
 * STG isolated store (docs/stg-isolated-store.md).
 *
 * Three-storage model support without touching NmgStore internals:
 *   - createStgStore: open/create the session-private project STG SQLite (Phase 1)
 *   - copyLtgSubsetToStg: usage-driven copy of LTG content into the STG,
 *     each copy carrying a cached_from_ltg marker (Phase 2)
 *   - searchStgFirst: STG-first dual-store search with LTG fallback and
 *     dedupe by sourceMemoryId (Phase 3)
 *
 * STG stores are plain NmgStore instances on separate files: deletable,
 * session-private and project-local, never authoritative. LTG remains the sole authority;
 * cached copies are search hints (marker, no re-verification) and are
 * refused by the promotion pipeline (loop guard in promoteMemory).
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { MemoryContext, MemoryMarker, MemoryScope, SearchOptions } from "./types.ts";
import { NmgStore } from "./store.ts";
import type { VectorEmbedder } from "./types.ts";

/** Marker attached to every LTG copy cached in an STG store. */
export function cachedFromLtgMarker(sourceMemoryId: string, cachedAt: string): MemoryMarker {
  return { kind: "cached_from_ltg", attributes: { sourceMemoryId, cachedAt } };
}

/** Session-private STG path. The hash prevents session IDs from becoming paths. */
export function stgStorePath(projectDir: string, sessionId = "default"): string {
  const sessionKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return join(projectDir, ".nmg", "sessions", sessionKey, "stg.sqlite");
}

/** Open (or create) one session's project STG. Deletable; recreating it is free. */
export function createStgStore(
  projectDir: string,
  embedder?: VectorEmbedder,
  sessionId = "default",
): NmgStore {
  return new NmgStore(stgStorePath(projectDir, sessionId), embedder);
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
): ReturnType<NmgStore["remember"]> {
  const context = stg.getContext([memoryId], 0);
  const result = context.results.find((candidate) => candidate.memory.id === memoryId);
  if (!result) throw new Error(`STG memory ${memoryId} does not exist`);
  const { memory, node, evidence } = result;
  if (memory.residence !== "stg") throw new Error(`memory ${memoryId} is not resident in STG`);
  if (memory.markers.some((marker) => marker.kind === "cached_from_ltg")) {
    throw new Error(`memory ${memoryId} is a cached_from_ltg copy and cannot be consolidated`);
  }
  return ltg.remember({
    statement: memory.statement,
    nodeName: node.canonicalName,
    nodeSummary: node.summary,
    nodeKind: node.kind,
    memoryType: memory.memoryType,
    stateKey: memory.stateKey ?? undefined,
    eventTime: memory.eventTime ?? undefined,
    sourceActor: memory.sourceActor,
    truthStatus: memory.truthStatus,
    confidence: memory.confidence ?? undefined,
    polarity: memory.polarity ?? undefined,
    predicateKey: memory.predicateKey ?? undefined,
    extractMethod: memory.extractMethod ?? undefined,
    claims: memory.claims ?? undefined,
    markers: [
      ...memory.markers,
      {
        kind: "consolidated_from_stg",
        attributes: { sourceMemoryId: memory.id },
      },
    ],
    evidence: evidence?.content ?? memory.statement,
    sourceRef: evidence?.sourceRef ?? undefined,
    tier: memory.tier,
    importance: memory.importance,
    scope: memory.scope,
    validFrom: memory.validFrom ?? undefined,
    validUntil: memory.validUntil ?? undefined,
    evidenceRole: memory.evidenceRole,
    residence: "ltg",
    writeReason: "stg_outcome_consolidation",
    writeSource: "automatic",
  });
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

/** Merge a project STG result with authoritative LTG results. */
export function mergeStgLtgContexts(local: MemoryContext, shared: MemoryContext): MemoryContext {
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
  const results = reconcileStateVersions([...dedupedLocal, ...shared.results]);
  const activeGraph = mergeActiveGraphs(local.activeGraph, shared.activeGraph, results);
  return {
    results,
    relations: [
      ...new Map(
        [...(local.relations ?? []), ...shared.relations].map((relation) => [
          relation.id,
          relation,
        ]),
      ).values(),
    ],
    activeGraph,
    retrieval: shared.retrieval,
    timings: shared.timings,
    filterUsage: shared.filterUsage,
  };
}

/**
 * STG and LTG are separate physical stores, so a new session-local state cannot
 * update the status column of an older consolidated LTG row transactionally.
 * Their runtime projection still must expose one current value per canonical
 * state key and scope. Time decides; LTG wins an exact tie because it is the
 * authoritative store. Historical filters have already been applied to each
 * input context before this reconciliation.
 */
function reconcileStateVersions(results: MemoryContext["results"]): MemoryContext["results"] {
  const winnerByState = new Map<string, MemoryContext["results"][number]>();
  for (const result of results) {
    if (result.memory.memoryType !== "state" || !result.memory.stateKey) continue;
    const key = `${result.memory.stateKey}\0${canonicalScope(result.memory.scope)}`;
    const current = winnerByState.get(key);
    if (!current || compareStateRecency(result, current) > 0) winnerByState.set(key, result);
  }
  if (winnerByState.size === 0) return results;
  const winners = new Set([...winnerByState.values()].map((result) => result.memory.id));
  return results.filter(
    (result) =>
      result.memory.memoryType !== "state" ||
      !result.memory.stateKey ||
      winners.has(result.memory.id),
  );
}

function compareStateRecency(
  left: MemoryContext["results"][number],
  right: MemoryContext["results"][number],
): number {
  const timestamp = (result: MemoryContext["results"][number]) =>
    Date.parse(result.memory.validFrom ?? result.memory.eventTime ?? result.memory.createdAt);
  const timeDifference = timestamp(left) - timestamp(right);
  if (timeDifference !== 0) return timeDifference;
  return Number(left.memory.residence === "ltg") - Number(right.memory.residence === "ltg");
}

function canonicalScope(scope: MemoryScope): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(scope).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function mergeActiveGraphs(
  local: MemoryContext["activeGraph"],
  shared: MemoryContext["activeGraph"],
  results: MemoryContext["results"],
): MemoryContext["activeGraph"] {
  if (!local) return shared;
  if (!shared) return local;

  const memoryIds = results.map((result) => result.memory.id);
  const memorySet = new Set(memoryIds);
  const selections = [...local.selections, ...shared.selections]
    .filter((selection) => memorySet.has(selection.memoryId))
    .filter(
      (selection, index, all) =>
        all.findIndex((candidate) => candidate.memoryId === selection.memoryId) === index,
    )
    .sort((left, right) => memoryIds.indexOf(left.memoryId) - memoryIds.indexOf(right.memoryId))
    .map((selection, rank) => ({ ...selection, rank: rank + 1 }));
  const edges = [
    ...new Map([...local.edges, ...shared.edges].map((edge) => [edge.id, edge])).values(),
  ];
  const expansions = [
    ...new Map(
      [...local.expansions, ...shared.expansions].map((expansion) => [
        `${expansion.relationId}:${expansion.sourceNodeId}:${expansion.targetNodeId}:${expansion.hop}`,
        expansion,
      ]),
    ).values(),
  ];
  const nodeIds = [...new Set(selections.map((selection) => selection.nodeId))];
  const exhausted = [...new Set([...local.usage.exhausted, ...shared.usage.exhausted])];
  const budgetLedger = [
    ...new Map(
      [...local.budgetLedger, ...shared.budgetLedger].map((entry) => [entry.dimension, entry]),
    ).keys(),
  ].map((dimension) => {
    const entries = [...local.budgetLedger, ...shared.budgetLedger].filter(
      (entry) => entry.dimension === dimension,
    );
    const takeMaximum = dimension === "graphHops" || dimension === "localTier";
    return {
      dimension,
      limit: takeMaximum
        ? Math.max(...entries.map((entry) => entry.limit))
        : entries.reduce((sum, entry) => sum + entry.limit, 0),
      used: takeMaximum
        ? Math.max(...entries.map((entry) => entry.used))
        : entries.reduce((sum, entry) => sum + entry.used, 0),
      exhausted: entries.some((entry) => entry.exhausted),
    };
  });

  return {
    ...shared,
    nodeIds,
    memoryIds,
    edges,
    selections,
    expansions,
    budgetLedger,
    budget: {
      maxNodes: local.budget.maxNodes + shared.budget.maxNodes,
      maxEdges: local.budget.maxEdges + shared.budget.maxEdges,
      maxEvidence: local.budget.maxEvidence + shared.budget.maxEvidence,
      maxTokens: local.budget.maxTokens + shared.budget.maxTokens,
      maxGraphHops: Math.max(local.budget.maxGraphHops, shared.budget.maxGraphHops),
      maxLocalTier: Math.max(local.budget.maxLocalTier, shared.budget.maxLocalTier) as
        0 | 1 | 2 | 3,
      maxTierBudget: local.budget.maxTierBudget + shared.budget.maxTierBudget,
      maxLatencyMs: local.budget.maxLatencyMs + shared.budget.maxLatencyMs,
    },
    usage: {
      nodes: nodeIds.length,
      edges: edges.length,
      evidence: memoryIds.length,
      estimatedTokens: local.usage.estimatedTokens + shared.usage.estimatedTokens,
      graphHops: Math.max(local.usage.graphHops, shared.usage.graphHops),
      deepestTier: Math.max(local.usage.deepestTier, shared.usage.deepestTier) as 0 | 1 | 2 | 3,
      tiersOpened: local.usage.tiersOpened + shared.usage.tiersOpened,
      deepEvidence: local.usage.deepEvidence + shared.usage.deepEvidence,
      latencyMs: local.usage.latencyMs + shared.usage.latencyMs,
      exhausted,
    },
  };
}
