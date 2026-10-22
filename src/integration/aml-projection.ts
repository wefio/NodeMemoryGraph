import type { MemoryRecord } from "../core/types.ts";
import { searchPreview } from "./search-projection.ts";
import { renderTemporalEvidence } from "./temporal-evidence.ts";
import { contentText, type ContentPart } from "./multimodal-content.ts";

export interface AmlMemoryRow {
  id: string;
  content: string;
  score: number;
  event_time: string | null;
  /** Historical-time alias used by the existing NMG AML service, NOT write time. */
  created_at?: string;
  /** Actual storage creation; never used to invent historical context. */
  stored_at: string;
  raw_content: string;
}

export type AmlMultimodalMemoryRow = Omit<AmlMemoryRow, "content"> & {
  content: string | ContentPart[];
};

/** Map a retrieved record only: no ranking, embedding or persistence changes. */
export function projectAmlMemory(memory: MemoryRecord, query: string, score: number): AmlMemoryRow {
  const withdrawn = (memory.markers ?? []).some((marker) => marker.kind === "forget");
  const content = withdrawn ? searchPreview(memory) : memory.statement;
  return {
    id: memory.id,
    content: renderTemporalEvidence(content, memory.eventTime, query),
    score,
    event_time: memory.eventTime,
    ...(memory.eventTime ? { created_at: memory.eventTime } : {}),
    stored_at: memory.createdAt,
    raw_content: content,
  };
}

/** Return original media evidence, not the model-derived text used for retrieval. */
export function projectAmlMultimodalMemory(
  memory: MemoryRecord,
  query: string,
  score: number,
  parts: ContentPart[],
): AmlMultimodalMemoryRow {
  const base = projectAmlMemory(memory, query, score);
  if ((memory.markers ?? []).some((marker) => marker.kind === "forget")) return base;
  const text = contentText(parts);
  const rendered = renderTemporalEvidence(text, memory.eventTime, query);
  const prefix = rendered.slice(0, rendered.length - text.length).trimEnd();
  const content = structuredClone(parts);
  if (prefix) content.unshift({ type: "text", text: prefix });
  // raw_content stays the audit-original evidence; content carries the
  // presentation-time temporal prefix only.
  return { ...base, content, raw_content: JSON.stringify(parts) };
}
