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

export interface CompactSearchCandidate {
  id: string;
  node: string;
  type: string;
  open: boolean;
  external: boolean;
  forgotten: boolean;
  preview: string;
  eventTime: string | null;
  expiresAt: string | null;
  chains: string[];
}

export interface CompactSearchContext {
  candidates: CompactSearchCandidate[];
  logicalChainCount: number;
  activeGraphId: string | null;
  deferredMemoryIds: string[];
}

/** Agent-facing search projection. Exact records and evidence remain behind `nmg get`. */
export function compactSearchContext(context: MemoryContext): CompactSearchContext {
  return {
    candidates: context.results.map((result) => ({
      id: result.memory.id,
      node: result.node.canonicalName,
      type: result.memory.memoryType,
      open: result.memory.resolution === "open" || result.memory.resolution === "reopened",
      external: (result.memory.markers ?? []).some((marker) => marker.kind === "external_source"),
      forgotten: (result.memory.markers ?? []).some((marker) => marker.kind === "forget"),
      preview: searchPreview(result.memory),
      eventTime: result.memory.eventTime,
      expiresAt: result.memory.expiresAt ?? result.memory.validUntil,
      chains: logicalChainNames(result),
    })),
    logicalChainCount: logicalChainCount(context),
    activeGraphId: context.activeGraph?.id ?? null,
    deferredMemoryIds: context.progressiveDisclosure?.deferredMemoryIds ?? [],
  };
}
