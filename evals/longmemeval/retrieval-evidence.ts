import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

import { formatSearchHeaders } from "../../.pi/extensions/nmg/index.ts";
import { NmgStore } from "../../src/core/store.ts";
import { scoreLongMemRetrieval } from "./official.ts";
import type { OfficialRetrievalMetrics } from "./official.ts";

export interface AutomaticRecallEvidence {
  text: string;
  source: "automatic_headers";
  toolCalls: 0;
  traceId: string;
  rankedSessionIds: string[];
  officialMetrics: OfficialRetrievalMetrics | null;
}

export function officialRetrievalForMemoryIds(
  nmgDirectory: string,
  memoryIds: readonly string[],
  questionId: string,
  answerSessionIds: readonly string[],
): OfficialRetrievalMetrics | null {
  const store = new NmgStore(resolve(nmgDirectory, "nmg.sqlite"));
  try {
    return officialMetricsForContext(
      store.getContext(memoryIds, 0),
      questionId,
      answerSessionIds,
    ).officialMetrics;
  } finally {
    store.close();
  }
}

/** Reconstruct the compact headers that Pi injected for the latest search. */
export function latestAutomaticRecallEvidence(
  nmgDirectory: string,
  questionId: string,
  answerSessionIds: readonly string[],
): AutomaticRecallEvidence | null {
  const databasePath = resolve(nmgDirectory, "nmg.sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let traceId: string | null = null;
  let sessionId: string | undefined;
  try {
    const row = database
      .prepare(
        "SELECT id, session_id FROM retrieval_traces ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get() as { id?: unknown; session_id?: unknown } | undefined;
    traceId = row?.id === undefined ? null : String(row.id);
    sessionId = row?.session_id === null || row?.session_id === undefined
      ? undefined
      : String(row.session_id);
  } finally {
    database.close();
  }
  if (!traceId) return null;

  const store = new NmgStore(databasePath);
  try {
    const trace = store.retrievalTrace(traceId, sessionId);
    if (!trace) return null;
    const context = store.getContext(trace.resultMemoryIds, 0);
    const { rankedSessionIds, officialMetrics } = officialMetricsForContext(
      context,
      questionId,
      answerSessionIds,
    );
    return {
      text: formatSearchHeaders(context),
      source: "automatic_headers",
      toolCalls: 0,
      traceId,
      rankedSessionIds,
      officialMetrics,
    };
  } finally {
    store.close();
  }
}

function officialMetricsForContext(
  context: ReturnType<NmgStore["getContext"]>,
  questionId: string,
  answerSessionIds: readonly string[],
): { rankedSessionIds: string[]; officialMetrics: OfficialRetrievalMetrics | null } {
  const rankedSessionIds = unique(
    context.results.flatMap(({ evidence }) => {
      const sessionId = longMemSessionId(evidence.sourceRef, questionId);
      return sessionId ? [sessionId] : [];
    }),
  );
  return {
    rankedSessionIds,
    officialMetrics: scoreLongMemRetrieval(rankedSessionIds, [...answerSessionIds]),
  };
}

function longMemSessionId(sourceRef: string | null, questionId: string): string | null {
  if (!sourceRef) return null;
  const prefix = `longmemeval:${questionId}:`;
  if (!sourceRef.startsWith(prefix)) return null;
  const remainder = sourceRef.slice(prefix.length);
  const turnSeparator = remainder.lastIndexOf(":");
  return turnSeparator > 0 ? remainder.slice(0, turnSeparator) : null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
