import { createHash } from "node:crypto";

import type { FileHit, MemoryContext, MemorySearchResult } from "../core/types.ts";
import type { SessionDisclosureLevel } from "../core/session-active-graph.ts";
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
  /** File-content source hits (bounded passive-scope FTS), separate from
   *  memory candidates. Present when the file source is enabled. */
  files?: FileHit[];
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
    ...(context.files && context.files.length > 0 ? { files: context.files } : {}),
  };
}

/** Stable hash of the content that a particular disclosure depth will expose.
 * It lets the daemon own duplicate folding without owning host rendering. */
export function memoryDisclosureEntries(
  context: MemoryContext,
  disclosure: SessionDisclosureLevel,
): Array<{ memoryId: string; contentHash: string }> {
  return context.results.map((result) => {
    const visible =
      disclosure === "header"
        ? `${result.node.canonicalName}\n${result.memory.memoryType}\n${searchPreview(result.memory)}`
        : disclosure === "exact"
          ? result.memory.statement
          : `${result.memory.statement}\n${result.evidence.content}`;
    return {
      memoryId: result.memory.id,
      contentHash: createHash("sha256").update(visible).digest("base64url"),
    };
  });
}

export function compactDisclosureEntries(
  context: CompactSearchContext,
): Array<{ memoryId: string; contentHash: string }> {
  return context.candidates.map((candidate) => ({
    memoryId: candidate.id,
    contentHash: createHash("sha256")
      .update(`${candidate.node}\n${candidate.type}\n${candidate.preview}`)
      .digest("base64url"),
  }));
}
