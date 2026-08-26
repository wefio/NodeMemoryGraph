import type { MemoryContext, MemorySearchResult } from "../core/types.ts";
import { logicalChainCount, logicalChainNames } from "./chain-projection.ts";

export const SEARCH_PREVIEW_CHARS = 320;

export function searchPreview(memory: MemorySearchResult["memory"]): string {
  if ((memory.markers ?? []).some((marker) => marker.kind === "forget")) {
    return "[forget] (content withdrawn)";
  }
  const normalized = memory.statement.replace(/\s+/gu, " ").trim();
  return normalized.length <= SEARCH_PREVIEW_CHARS
    ? normalized
    : `${normalized.slice(0, SEARCH_PREVIEW_CHARS - 1)}…`;
}

/** Agent-facing search projection. Exact records and evidence remain behind `nmg get`. */
export function compactSearchContext(context: MemoryContext) {
  return {
    candidates: context.results.map((result) => ({
      id: result.memory.id,
      node: result.node.canonicalName,
      type: result.memory.memoryType,
      resolution: result.memory.resolution,
      tier: result.memory.tier,
      preview: searchPreview(result.memory),
      matches:
        result.hitTerms && result.hitTerms.length > 0
          ? result.hitTerms
          : [result.recallReason ?? "hybrid"],
      eventTime: result.memory.eventTime,
      expiresAt: result.memory.expiresAt ?? result.memory.validUntil,
      score: result.combinedScore,
      chains: logicalChainNames(result),
    })),
    logicalChainCount: logicalChainCount(context),
    activeGraphId: context.activeGraph?.id ?? null,
    deferredMemoryIds: context.progressiveDisclosure?.deferredMemoryIds ?? [],
    qpp: context.activeGraph?.qpp
      ? {
          trigger: context.activeGraph.qpp.trigger,
          reason: context.activeGraph.qpp.reason,
          score: context.activeGraph.qpp.qpp,
          threshold: context.activeGraph.qpp.threshold,
        }
      : null,
    retrieval: context.retrieval,
    totalMs: context.timings?.totalMs,
  };
}
