import { createHash } from "node:crypto";
import { NmgStore } from "../../src/core/store.ts";
import { syncRecordEmbeddings } from "../../src/core/embedding-sync.ts";
import { searchMemoryContext } from "../../src/integration/search.ts";
import {
  projectAmlMemory,
  projectAmlMultimodalMemory,
} from "../../src/integration/aml-projection.ts";
import { normalizeContent, type AmlContent } from "../../src/integration/multimodal-content.ts";
import { extractiveNodeSummary, runExtractiveLeafSummaries } from "./extractive-summaries.mjs";
import type { EmbeddingClient } from "../../src/core/embedding-provider.ts";
import type { RememberInput, MemorySearchResult } from "../../src/core/types.ts";

type ClauseContribution = {
  /** Position of the clause in the request's clause list. */
  index: number;
  /** Returned memories this clause surfaced (it may have surfaced more). */
  contributed: number;
  /** Returned memories that no other clause surfaced. */
  exclusive: number;
};

type FusedCandidate = { result: MemorySearchResult; sources: Set<number> };

/** Keep the highest-scoring occurrence of a memory, remembering every clause
 * that surfaced it. */
function trackCandidate(
  byId: Map<string, FusedCandidate>,
  index: number,
  result: MemorySearchResult,
): void {
  const prior = byId.get(result.memory.id);
  if (!prior) {
    byId.set(result.memory.id, { result, sources: new Set([index]) });
    return;
  }
  prior.sources.add(index);
  if (result.combinedScore > prior.result.combinedScore) prior.result = result;
}

/** Per-clause attribution over the returned page. */
function summariseClauses(
  selected: readonly FusedCandidate[],
  clauseCount: number,
): ClauseContribution[] {
  const clauses: ClauseContribution[] = Array.from({ length: clauseCount }, (_unused, index) => ({
    index,
    contributed: 0,
    exclusive: 0,
  }));
  for (const entry of selected) {
    for (const source of entry.sources) {
      const clause = clauses[source];
      if (clause) clause.contributed += 1;
    }
    if (entry.sources.size !== 1) continue;
    const [only] = [...entry.sources];
    const clause = only === undefined ? undefined : clauses[only];
    if (clause) clause.exclusive += 1;
  }
  return clauses;
}

export const CORE_SOURCE = "workspace:src";
// Fixed service profile, independent of agent sessions, online feedback and AG
// disclosure. These are the same store/search primitives used by NmgService.
export const AML_SEARCH_PROFILE = Object.freeze({
  maxTier: 3 as const,
  graphHops: 1,
  expandChains: true,
  secondPass: true,
  vectorGranularity: "records" as const,
  leafBlockRouting: true,
  progressiveWarmDisclosure: false,
  tieredDisclosure: false,
  persistTrace: false,
  perf: false,
});

type Message = {
  role: "user" | "assistant";
  content: AmlContent;
  chat_time?: string;
  source_message_id: string;
  /** Prepared outside the SQLite request context; never accepted from HTTP input. */
  indexText?: string;
};

function projectResult(result: MemorySearchResult, query: string) {
  const markers = result.memory.markers ?? [];
  if (
    !markers.some((marker) => marker.kind === "aml_content") ||
    markers.some((marker) => marker.kind === "forget")
  ) {
    return projectAmlMemory(result.memory, query, result.combinedScore);
  }
  const parts = normalizeContent(JSON.parse(result.evidence.content));
  if (!Array.isArray(parts)) throw new Error("Stored structured evidence is not a parts array");
  return projectAmlMultimodalMemory(result.memory, query, result.combinedScore, parts);
}

/** Request-scoped daemon core for AML. R2 transaction/receipt ownership stays
 * with the HTTP adapter; there is no background runner or harness state. */
export class AmlMemoryService {
  private store: NmgStore;
  constructor(
    key: string,
    private client?: EmbeddingClient,
  ) {
    this.store = new NmgStore(`/tmp/nmg/${key}.sqlite`, undefined, { scopeWriteIndex: true });
  }

  async rememberBatch(userId: string, sessionId: string, requestId: string, messages: Message[]) {
    // Node-summary compensation without an LLM writer. The identity name below
    // stays the stable session key; entity terms land on the non-identity
    // summary face so later batches can never split the node.
    const sessionDate = messages.find((message) => message.chat_time)?.chat_time?.slice(0, 10);
    const nodeSummary = extractiveNodeSummary(
      messages.map(
        (message) =>
          message.indexText ?? (typeof message.content === "string" ? message.content : ""),
      ),
      sessionDate,
    );
    const inputs: RememberInput[] = messages.map((message): RememberInput => {
      const sourceRef = `aml:${createHash("sha256")
        .update(JSON.stringify([userId, sessionId, requestId, message.source_message_id]))
        .digest("hex")}`;
      const structured = typeof message.content !== "string";
      const source = structured ? JSON.stringify(message.content) : message.content;
      const view = structured ? message.indexText : message.content;
      if (typeof source !== "string" || typeof view !== "string" || !view.trim()) {
        throw new Error("Structured source requires a prepared nonempty retrieval view");
      }
      // Preserve original parts in native history, never in the embedding text.
      // Per-image hashes inside the view keep different structured evidence from
      // collapsing into one plain-text memory; the content hash below stays in
      // marker attributes instead of polluting the retrieval statement.
      const statement = view;
      const history = this.store.appendHistory({
        content: source,
        role: message.role,
        sessionId,
        sourceMessageId: message.source_message_id,
        sourceRef,
      });
      return {
        statement,
        nodeName: `AML session ${sessionId}`,
        nodeSummary,
        memoryType: "event",
        // Attribution follows the supplied message role. A derived retrieval
        // view changes indexing text, never who asserted the evidence.
        sourceActor: message.role,
        truthStatus: "asserted",
        evidenceHistoryId: history.id,
        eventTime: message.chat_time,
        scope: { aml_user: userId },
        tier: 2,
        residence: "ltg",
        sessionId: null,
        writeSource: "import",
        writeReason: "aml_history_import",
        sourceRef,
        markers: [
          { kind: "aml_session", attributes: { session_id: sessionId } },
          { kind: "aml_request_id", attributes: { value: requestId } },
          ...(structured
            ? [
                {
                  kind: "aml_content",
                  attributes: {
                    format: "ordered-parts-v1",
                    source_role: message.role,
                    source_sha: createHash("sha256").update(source).digest("hex"),
                  },
                },
              ]
            : []),
        ],
      };
    });
    // Same ordered, transactional primitive as daemon rememberBatch. The
    // outer manifest commit also makes multiple internal batches atomic.
    this.store.rememberMany(inputs);
    if (this.client) await syncRecordEmbeddings(this.store, this.client, 32);
    // After embeddings: leaf-summary staleness must not trigger extra
    // embedding batches in records-granularity mode.
    runExtractiveLeafSummaries(this.store);
    return { added: messages.length };
  }

  close() {
    this.store.close();
  }

  /** Search the ranked clauses into one page and the append-only clauses into a
   * separate supplement. Append-only results never compete for the page slots:
   * they are returned as `appended`, deduplicated against the page, so a
   * retrieval dimension that is broad but imprecise cannot crowd out evidence. */
  async search(queries: string[], limit: number, appendOnly: readonly boolean[] = []) {
    if (this.client) {
      const health = this.store.embeddingIndexHealth(this.client.indexId);
      if (!health || health.pending.records || !health.targets.includes("records")) {
        // New writes are fully indexed before their Add succeeds. Bound the
        // compatibility backfill for pre-upgrade or changed-model snapshots.
        await syncRecordEmbeddings(this.store, this.client, 32, { maxBatches: 1 });
      }
    }
    // Track which clauses surfaced each memory, so a caller can see whether the
    // retrieval dimension it added actually contributed to the page.
    const byId = new Map<string, FusedCandidate>();
    const appendedById = new Map<string, MemorySearchResult>();
    let records = false;
    for (const [index, query] of queries.entries()) {
      // User isolation is the physical manifest/partition boundary, including
      // legacy rows whose pre-upgrade scope differs. No session filter.
      const context = await searchMemoryContext(this.store, this.client, query, {
        ...AML_SEARCH_PROFILE,
        limit,
        activeGraphBudget: {
          maxNodes: limit,
          maxEvidence: limit,
          maxTierBudget: limit,
          maxTokens: Math.max(1000, limit * 300),
        },
      });
      records ||= context.retrieval?.mode === "hybrid";
      if (appendOnly[index]) {
        for (const result of context.results) {
          const prior = appendedById.get(result.memory.id);
          if (!prior || result.combinedScore > prior.combinedScore) {
            appendedById.set(result.memory.id, result);
          }
        }
        continue;
      }
      for (const result of context.results) trackCandidate(byId, index, result);
    }
    // Fuse clauses by identity, keep native scores, apply the AML hard cap.
    const selected = [...byId.values()]
      .sort(
        (a, b) =>
          b.result.combinedScore - a.result.combinedScore ||
          a.result.memory.id.localeCompare(b.result.memory.id),
      )
      .slice(0, limit);
    const page = new Set(selected.map((entry) => entry.result.memory.id));
    const appended = [...appendedById.values()]
      .filter((result) => !page.has(result.memory.id))
      .sort((a, b) => b.combinedScore - a.combinedScore || a.memory.id.localeCompare(b.memory.id))
      .slice(0, limit);
    return {
      retrievalMode: records ? "records" : "lexical",
      memories: selected.map((entry) => projectResult(entry.result, queries[0] ?? "")),
      clauses: summariseClauses(selected, queries.length),
      appended: appended.map((result) => projectResult(result, queries[0] ?? "")),
    };
  }
}
