import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  NodeRouteSignalItem,
  PerfAggregate,
  RetrievalTrace,
  RetrievalTraceInput,
} from "../types.ts";
import { nowMs } from "../perf.ts";
import { activeGraphBudget, stableTaskId } from "./active-graph.ts";
import { parseNumberArray, parseStringArray } from "./row-parse.ts";
import { clamp, parseQppDecision, parseStoredJson } from "./rows.ts";
import type { Constructor } from "./store-ctor.ts";

type Row = Record<string, string | number | Uint8Array | null>;

export interface TraceAttribution {
  method: "answer_overlap" | "verified_evidence";
  attributedMemoryIds: readonly string[];
  contradictedMemoryIds?: readonly string[];
  rejectedMemoryIds?: readonly string[];
}

export interface TraceObservation {
  row: Row;
  resultMemoryIds: Set<string>;
  observedAttributedMemoryIds: string[];
}

export function withRetrievalDiagnostics<TBase extends Constructor>(Base: TBase) {
  return class extends Base {
    declare protected db: DatabaseSync;
    declare protected assertTraceOwner: (row: Row, sessionId?: string) => void;

    protected insertRetrievalTrace(
      input: RetrievalTraceInput,
      id: string,
      recordSignals?: (nodeIds: string[], createdAt: string) => void,
    ): string {
      const createdAt = new Date().toISOString();
      const nodeIds = [...new Set(input.resultNodeIds)].sort();
      const taskId = input.taskId?.trim() || stableTaskId(input.query);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `INSERT INTO retrieval_traces
            (id, session_id, query, result_memory_ids_json, result_node_ids_json,
             expanded_node_ids_json, disclosed_memory_ids_json, attributed_memory_ids_json,
             useful_memory_ids_json,
             contradicted_memory_ids_json, rejected_memory_ids_json,
             relation_ids_json, task_id, active_graph_budget_json,
             active_graph_usage_json, selections_json, expansions_json,
             budget_ledger_json, qpp_json, timings_json, filter_usage_json,
             node_route_signal_json,
             ambiguity, fallback_used, conflict_observed, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.sessionId?.trim() || null,
            input.query,
            traceIds(input.resultMemoryIds),
            JSON.stringify(nodeIds),
            traceIds(input.expandedNodeIds),
            traceIds(input.disclosedMemoryIds),
            traceIds(input.attributedMemoryIds),
            traceIds(input.usefulMemoryIds),
            traceIds(input.contradictedMemoryIds),
            traceIds(input.rejectedMemoryIds),
            traceIds(input.relationIds),
            taskId,
            traceJson(input.activeGraphBudget, {}),
            traceJson(input.activeGraphUsage, {}),
            traceJson(input.selections, []),
            traceJson(input.expansions, []),
            traceJson(input.budgetLedger, []),
            traceJson(input.qpp, null),
            traceJson(input.timings, {}),
            traceJson(input.filterUsage, {}),
            traceJson(input.nodeRouteSignal, []),
            clamp(input.ambiguity ?? 0, 0, 1),
            input.fallbackUsed ? 1 : 0,
            input.conflictObserved ? 1 : 0,
            createdAt,
          );
        if (recordSignals) recordSignals(nodeIds, createdAt);
        else
          this.db
            .prepare("UPDATE retrieval_traces SET signals_drained_at = ? WHERE id = ?")
            .run(createdAt, id);
        this.db.exec("COMMIT");
        return id;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    recordTrace(input: RetrievalTraceInput, id: string = randomUUID()): string {
      return this.insertRetrievalTrace(input, id);
    }

    /** Long-term per-section aggregates (never pruned). */
    perfAggregates(): PerfAggregate[] {
      const rows = this.db
        .prepare(
          `SELECT section, count, sum, sum_sq, buckets_json, updated_at
           FROM perf_aggregates ORDER BY section`,
        )
        .all() as Row[];
      return rows.map((row) => ({
        section: String(row.section),
        count: Number(row.count),
        sum: Number(row.sum),
        sumSq: Number(row.sum_sq),
        buckets: parseNumberArray(row.buckets_json),
        updatedAt: String(row.updated_at),
      }));
    }

    /** Number of raw retrieval traces (for pruning window checks/tests). */
    retrievalTracesCount(): number {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM retrieval_traces`).get() as Row;
      return Number(row.n);
    }

    /**
     * Prune raw retrieval traces beyond the retention window. The window is
     * defined by age (default 30 days) and row count (default 10 000) — the
     * larger of the two bounds wins, whichever is breached first. Aggregates
     * are never touched: perf_aggregates survives pruning by design.
     *
     * Runs as a maintenance action (retention lifecycle), never automatically
     * per-query, matching the repo's "explicit maintenance, no background
     * scheduler" discipline.
     */
    pruneRetrievalTraces(options: { maxDays?: number; maxRows?: number } = {}): number {
      const maxDays = options.maxDays ?? 30;
      const maxRows = options.maxRows ?? 10_000;
      const cutoff = new Date(Date.now() - maxDays * 86_400_000).toISOString();
      // One atomic statement: delete rows older than the window OR beyond the
      // row-count ceiling (keep the newest maxRows). A LIMIT caps a single call
      // so a huge backlog is drained across maintenance runs, not one shot.
      const deleted = this.db
        .prepare(
          `DELETE FROM retrieval_traces
           WHERE id IN (
             SELECT id FROM retrieval_traces
             WHERE created_at < ?
                OR id NOT IN (
                  SELECT id FROM retrieval_traces
                  ORDER BY created_at DESC LIMIT ?
                )
             LIMIT 5000
           )`,
        )
        .run(cutoff, maxRows);
      return Number(deleted.changes);
    }

    // Safe ownership probe for trace lookups that must not throw (e.g. an RPC
    // walking candidate stores to find the one that owns a trace). Unlike
    // retrievalTrace it never throws, so a foreign trace in an early candidate
    // cannot abort the search for the real owner. Returns a tri-state so the
    // caller can keep the diagnostics distinction between "trace is gone" and
    // "trace exists but belongs to another session".
    traceOwnership(id: string, sessionId?: string): "owned" | "foreign" | "absent" {
      const row = this.db
        .prepare("SELECT session_id FROM retrieval_traces WHERE id = ?")
        .get(id) as Row | undefined;
      if (!row) return "absent";
      const owner =
        row.session_id === null || row.session_id === undefined ? null : String(row.session_id);
      if (owner !== null && owner !== sessionId?.trim()) return "foreign";
      return "owned";
    }

    retrievalTrace(id: string, sessionId?: string): RetrievalTrace | null {
      const row = this.db.prepare("SELECT * FROM retrieval_traces WHERE id = ?").get(id) as
        Row | undefined;
      if (!row) return null;
      this.assertTraceOwner(row, sessionId);
      return {
        id: String(row.id),
        sessionId: row.session_id === null ? null : String(row.session_id),
        query: String(row.query),
        taskId: String(row.task_id),
        resultMemoryIds: parseStringArray(row.result_memory_ids_json),
        resultNodeIds: parseStringArray(row.result_node_ids_json),
        expandedNodeIds: parseStringArray(row.expanded_node_ids_json),
        relationIds: parseStringArray(row.relation_ids_json),
        disclosedMemoryIds: parseStringArray(row.disclosed_memory_ids_json),
        attributedMemoryIds: parseStringArray(row.attributed_memory_ids_json),
        usefulMemoryIds: parseStringArray(row.useful_memory_ids_json),
        contradictedMemoryIds: parseStringArray(row.contradicted_memory_ids_json),
        rejectedMemoryIds: parseStringArray(row.rejected_memory_ids_json),
        ambiguity: Number(row.ambiguity),
        fallbackUsed: Boolean(row.fallback_used),
        conflictObserved: Boolean(row.conflict_observed),
        activeGraphBudget: parseStoredJson(row.active_graph_budget_json, activeGraphBudget({})),
        activeGraphUsage: parseStoredJson(row.active_graph_usage_json, {
          nodes: 0,
          edges: 0,
          evidence: 0,
          estimatedTokens: 0,
          graphHops: 0,
          deepestTier: 0,
          tiersOpened: 1,
          deepEvidence: 0,
          latencyMs: 0,
          exhausted: [],
        }),
        selections: parseStoredJson(row.selections_json, []),
        expansions: parseStoredJson(row.expansions_json, []),
        budgetLedger: parseStoredJson(row.budget_ledger_json, []),
        qpp: parseQppDecision(row.qpp_json),
        timings: parseStoredJson(row.timings_json, null) ?? undefined,
        filterUsage: parseStoredJson(row.filter_usage_json, null) ?? undefined,
        nodeRouteSignal: parseStoredJson(row.node_route_signal_json, []) as NodeRouteSignalItem[],
        createdAt: String(row.created_at),
      };
    }

    /**
     * Record exact evidence disclosed to the model. Disclosure is observable,
     * but it is not answer attribution and must not affect topology or controller
     * supervision.
     */
    protected updateTraceDisclosure(
      activeGraphId: string,
      disclosedMemoryIds: readonly string[],
      sessionId?: string,
    ): string[] {
      const row = this.db
        .prepare("SELECT * FROM retrieval_traces WHERE id = ?")
        .get(activeGraphId) as Row | undefined;
      if (!row) throw new Error(`active graph ${activeGraphId} does not exist`);
      this.assertTraceOwner(row, sessionId);
      const resultMemoryIds = new Set(parseStringArray(row.result_memory_ids_json));
      const observed = [...new Set(disclosedMemoryIds)].filter((id) => resultMemoryIds.has(id));
      const disclosed = [
        ...new Set([...parseStringArray(row.disclosed_memory_ids_json), ...observed]),
      ];
      this.db
        .prepare("UPDATE retrieval_traces SET disclosed_memory_ids_json = ? WHERE id = ?")
        .run(JSON.stringify(disclosed), activeGraphId);
      return observed;
    }

    recordActiveGraphDisclosure(
      activeGraphId: string,
      disclosedMemoryIds: readonly string[],
      sessionId?: string,
    ): void {
      this.updateTraceDisclosure(activeGraphId, disclosedMemoryIds, sessionId);
    }

    recordActiveGraphAttribution(
      activeGraphId: string,
      input: TraceAttribution,
      sessionId?: string,
    ): void {
      const startedAt = nowMs();
      this.recordActiveGraphAttributionInner(activeGraphId, input, sessionId);
      // Record the attribution span on the same trace row (best-effort —
      // the span is diagnostic, never a reason to fail the call).
      try {
        this.db
          .prepare(
            `UPDATE retrieval_traces SET timings_json = json_patch(timings_json, ?) WHERE id = ?`,
          )
          .run(JSON.stringify({ attribution: { totalMs: nowMs() - startedAt } }), activeGraphId);
      } catch {
        /* trace timing is diagnostic; ignore write failure */
      }
    }

    protected recordActiveGraphAttributionInner(
      activeGraphId: string,
      input: TraceAttribution,
      sessionId?: string,
    ): void {
      const trace = this.updateTraceAttribution(
        activeGraphId,
        input.attributedMemoryIds,
        sessionId,
      );
      this.afterTraceAttribution(activeGraphId, input, trace);
    }

    protected afterTraceAttribution(
      _activeGraphId: string,
      _input: TraceAttribution,
      _trace: TraceObservation,
    ): void {}

    private updateTraceAttribution(
      activeGraphId: string,
      attributedIds: readonly string[],
      sessionId?: string,
    ): TraceObservation {
      const row = this.db
        .prepare("SELECT * FROM retrieval_traces WHERE id = ?")
        .get(activeGraphId) as Row | undefined;
      if (!row) throw new Error(`active graph ${activeGraphId} does not exist`);
      this.assertTraceOwner(row, sessionId);
      const resultMemoryIds = new Set(parseStringArray(row.result_memory_ids_json));
      const observedAttributedMemoryIds = [...new Set(attributedIds)].filter((id) =>
        resultMemoryIds.has(id),
      );
      const attributedMemoryIds = [
        ...new Set([
          ...parseStringArray(row.attributed_memory_ids_json),
          ...observedAttributedMemoryIds,
        ]),
      ];
      this.db
        .prepare("UPDATE retrieval_traces SET attributed_memory_ids_json = ? WHERE id = ?")
        .run(JSON.stringify(attributedMemoryIds), activeGraphId);
      return { row, resultMemoryIds, observedAttributedMemoryIds };
    }
  };
}

function traceIds(ids: readonly string[] = []): string {
  return JSON.stringify([...new Set(ids)]);
}

function traceJson(value: unknown, fallback: object | null): string {
  return JSON.stringify(value ?? fallback);
}
