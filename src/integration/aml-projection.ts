import type { MemoryRecord } from "../core/types.ts";
import { searchPreview } from "./search-projection.ts";
import { renderTemporalEvidence } from "./temporal-evidence.ts";

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
