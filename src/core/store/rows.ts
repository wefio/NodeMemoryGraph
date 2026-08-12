/**
 * Row mappers and serializers extracted from NmgStore.
 *
 * A pure-function group (no store state) that converts between SQLite
 * rows (snake_case, sometimes prefixed `n_`/`m_`/`h_` for joins) and the
 * in-memory domain types. Moved verbatim from store.ts — this module is
 * the single home for row mapping; the boundary is pinned by
 * tests/core/store/module-boundary.test.ts.
 */
import { createHash } from "node:crypto";

import type {
  ActivationSignal,
  ConsolidationEvent,
  HistoryRecord,
  HistoryRole,
  LeafBlock,
  MemoryMarker,
  MemoryNode,
  MemoryNodeKind,
  MemoryRecord,
  MemoryResidence,
  MemoryScope,
  MemorySearchResult,
  MemoryStatus,
  MemoryTier,
  MemoryWriteEvent,
  NodeRelation,
  NodeRelationType,
  QppTriggerDecision,
  SearchOptions,
  TopologyProposal,
} from "../types.ts";
import { normalize } from "./search-ranking.ts";
import { parseStringArray } from "./row-parse.ts";
import type { StoreRow as Row } from "./search-ranking.ts";

export function mapNode(row: Row, prefix = ""): MemoryNode {
  return {
    id: String(row[`${prefix}id`]),
    canonicalName: String(row[`${prefix}canonical_name`]),
    kind: String(row[`${prefix}kind`]) as MemoryNodeKind,
    summary: String(row[`${prefix}summary`]),
    createdAt: String(row[`${prefix}created_at`]),
    updatedAt: String(row[`${prefix}updated_at`]),
    status: String(row[`${prefix}status`] ?? "active") as MemoryNode["status"],
    residence: String(row[`${prefix}residence`] ?? "ltg") as MemoryResidence,
  };
}

export function canonicalNodeIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

export function mapLeafBlock(row: Row): LeafBlock {
  return {
    id: String(row.id),
    nodeId: String(row.node_id),
    tier: Number(row.tier) as MemoryTier,
    summary: String(row.summary),
    memoryCount: Number(row.memory_count),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function mapTopologyProposal(row: Row): TopologyProposal {
  let partitions: TopologyProposal["partitions"] = [];
  try {
    const parsed = JSON.parse(String(row.partitions_json)) as unknown;
    if (Array.isArray(parsed)) {
      partitions = parsed.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const candidate = item as { label?: unknown; memoryIds?: unknown };
        return typeof candidate.label === "string" && Array.isArray(candidate.memoryIds)
          ? [
              {
                label: candidate.label,
                memoryIds: candidate.memoryIds.filter((id): id is string => typeof id === "string"),
              },
            ]
          : [];
      });
    }
  } catch {
    partitions = [];
  }
  return {
    id: String(row.id),
    proposalKey: String(row.proposal_key),
    type: String(row.proposal_type) as TopologyProposal["type"],
    sourceNodeIds: parseStringArray(row.source_node_ids_json),
    relationType: row.relation_type ? (String(row.relation_type) as NodeRelationType) : null,
    partitions,
    evidenceTraceIds: parseStringArray(row.evidence_trace_ids_json),
    evidenceMemoryIds: parseStringArray(row.evidence_memory_ids_json),
    observations: Number(row.observations),
    estimatedGain: Number(row.estimated_gain),
    status: String(row.status) as TopologyProposal["status"],
    createdAt: String(row.created_at),
  };
}

export function partitionLabel(label: string, index: number): string {
  const [memoryType, scope = ""] = label.split("|", 2);
  try {
    const parsed = JSON.parse(scope) as Record<string, unknown>;
    const scopeLabel = Object.values(parsed)
      .filter((value) => typeof value === "string")
      .join(" ");
    return [memoryType, scopeLabel].filter(Boolean).join(" ") || `partition ${index + 1}`;
  } catch {
    return memoryType || `partition ${index + 1}`;
  }
}

export function leafBlockSummary(rows: Row[]): string {
  const first = rows[0]!;
  const scope = parseScope(first.scope_json);
  const scopeText = Object.entries(scope)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  const times = rows
    .flatMap((row) => [row.event_time, row.valid_from, row.valid_until])
    .filter((value): value is string | number => value !== null)
    .map(String)
    .sort();
  const sample = rows
    .slice(0, 8)
    .map((row) => String(row.statement).trim())
    .filter(Boolean)
    .join("; ")
    .slice(0, 1_500);
  return [
    `node=${first.canonical_name}`,
    `type=${first.memory_type}`,
    `tier=${first.tier}`,
    scopeText ? `scope=${scopeText}` : "",
    times.length > 0 ? `time=${times[0]}..${times[times.length - 1]}` : "",
    `count=${rows.length}`,
    `examples=${sample}`,
  ]
    .filter(Boolean)
    .join(" | ");
}

export function stableLeafBlockId(rows: Row[]): string {
  const identity = rows
    .map((row) => [
      row.id,
      row.statement,
      row.memory_type,
      row.scope_json,
      row.tier,
      row.event_time,
      row.valid_from,
      row.valid_until,
    ])
    .join("\0");
  return `leaf_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

export function mapSearchResult(row: Row, score: number): MemorySearchResult {
  return {
    memory: {
      id: String(row.m_id),
      nodeId: String(row.m_node_id),
      evidenceId: String(row.m_evidence_id),
      evidenceIds: [String(row.m_evidence_id)],
      statement: String(row.m_statement),
      memoryType: String(row.m_memory_type) as MemoryRecord["memoryType"],
      stateKey: row.m_state_key ? String(row.m_state_key) : null,
      eventTime: row.m_event_time ? String(row.m_event_time) : null,
      sourceActor: String(row.m_source_actor) as MemoryRecord["sourceActor"],
      truthStatus: String(row.m_truth_status) as MemoryRecord["truthStatus"],
      confidence:
        row.m_confidence === null || row.m_confidence === undefined
          ? null
          : Number(row.m_confidence),
      polarity: row.m_polarity ? (String(row.m_polarity) as MemoryRecord["polarity"]) : null,
      predicateKey: row.m_predicate_key ? String(row.m_predicate_key) : null,
      extractMethod: row.m_extract_method
        ? (String(row.m_extract_method) as MemoryRecord["extractMethod"])
        : null,
      claims: parseClaims(row.m_claims_json),
      markers: parseMarkers(row.m_markers_json),
      scope: parseScope(row.m_scope_json),
      validFrom: row.m_valid_from ? String(row.m_valid_from) : null,
      validUntil: row.m_valid_until ? String(row.m_valid_until) : null,
      status: String(row.m_status) as MemoryStatus,
      resolution: String(row.m_resolution ?? "resolved") as MemoryRecord["resolution"],
      openedAt: row.m_opened_at ? String(row.m_opened_at) : null,
      relatedMemoryIds: parseStringArray(row.m_related_memory_ids_json),
      residence: String(row.m_residence ?? "ltg") as MemoryResidence,
      sessionId: row.m_session_id ? String(row.m_session_id) : null,
      promotedAt: row.m_promoted_at ? String(row.m_promoted_at) : null,
      expiresAt: row.m_expires_at ? String(row.m_expires_at) : null,
      evidenceRole: String(row.m_evidence_role) as MemoryRecord["evidenceRole"],
      supersedesId: row.m_supersedes_id ? String(row.m_supersedes_id) : null,
      tier: Number(row.m_tier) as MemoryTier,
      importance: Number(row.m_importance),
      accessCount: Number(row.m_access_count),
      lastAccessedAt: row.m_last_accessed_at ? String(row.m_last_accessed_at) : null,
      writeReason: String(row.m_write_reason ?? "legacy_write"),
      writeSource: String(row.m_write_source ?? "core") as MemoryRecord["writeSource"],
      createdAt: String(row.m_created_at),
    },
    node: mapNode(row, "n_"),
    evidence: {
      id: String(row.h_id),
      sessionId: row.h_session_id ? String(row.h_session_id) : null,
      sourceMessageId: row.h_source_message_id ? String(row.h_source_message_id) : null,
      role: String(row.h_role) as HistoryRole,
      content: String(row.h_content),
      sourceRef: row.h_source_ref ? String(row.h_source_ref) : null,
      createdAt: String(row.h_created_at),
    },
    evidenceRecords: [],
    lexicalScore: score,
    vectorScore: 0,
    routeScore: 0,
    combinedScore: score,
  };
}

export function mapHistory(row: Row): HistoryRecord {
  return {
    id: String(row.id),
    sessionId: row.session_id ? String(row.session_id) : null,
    sourceMessageId: row.source_message_id ? String(row.source_message_id) : null,
    role: String(row.role) as HistoryRole,
    content: String(row.content),
    sourceRef: row.source_ref ? String(row.source_ref) : null,
    createdAt: String(row.created_at),
  };
}

export function mapRelation(row: Row): NodeRelation {
  return {
    id: String(row.id),
    sourceNodeId: String(row.source_node_id),
    targetNodeId: String(row.target_node_id),
    type: String(row.relation_type) as NodeRelationType,
    evidenceIds: parseStringArray(row.evidence_ids_json),
    residence: "ltg",
    status: String(row.status ?? "consolidated") as NodeRelation["status"],
    stability: Number(row.stability ?? 1),
    strength: Number(row.strength ?? 0.5),
    direction: String(row.direction ?? "both") as NodeRelation["direction"],
    fanBudget: Number(row.fan_budget ?? 1) !== 0,
    activationRule: String(row.activation_rule ?? "conductive") as NodeRelation["activationRule"],
    consolidationSource: String(
      row.consolidation_source ?? "explicit",
    ) as NodeRelation["consolidationSource"],
    consolidatedAt: String(row.consolidated_at ?? row.created_at),
    createdAt: String(row.created_at),
  };
}

export function mapConsolidationEvent(row: Row): ConsolidationEvent {
  return {
    id: String(row.id),
    action: String(row.action) as ConsolidationEvent["action"],
    targetId: String(row.target_id),
    previousState: String(row.previous_state),
    nextState: String(row.next_state),
    reason: String(row.reason),
    evidenceTraceIds: parseStringArray(row.evidence_trace_ids_json),
    createdAt: String(row.created_at),
  };
}

export function mapMemoryWriteEvent(row: Row): MemoryWriteEvent {
  return {
    id: String(row.id),
    memoryId: row.memory_id ? String(row.memory_id) : null,
    historyId: row.history_id ? String(row.history_id) : null,
    sessionId: row.session_id ? String(row.session_id) : null,
    decision: String(row.decision) as MemoryWriteEvent["decision"],
    policyReason: String(row.policy_reason),
    writeReason: String(row.write_reason),
    writeSource: String(row.write_source) as MemoryWriteEvent["writeSource"],
    memoryType: String(row.memory_type) as MemoryWriteEvent["memoryType"],
    requestedResidence: String(row.requested_residence) as MemoryWriteEvent["requestedResidence"],
    createdAt: String(row.created_at),
  };
}

export function mapActivation(row: Row | undefined, hasExpanded: boolean): ActivationSignal {
  const selectedCount = Number(row?.selected_count ?? 0);
  const expandedCount = hasExpanded ? Number(row?.expanded_count ?? 0) : 0;
  const usedCount = Number(row?.used_count ?? 0);
  const contradictedCount = Number(row?.contradicted_count ?? 0);
  const rejectedCount = Number(row?.rejected_count ?? 0);
  const updatedAt = row?.updated_at ? String(row.updated_at) : new Date(0).toISOString();
  const positive = selectedCount * 0.1 + expandedCount * 0.15 + usedCount;
  const negative = contradictedCount * 0.8 + rejectedCount * 0.4;
  const normalized = clamp((positive - negative) / (1 + positive + negative), 0, 1);
  const ageDays = Math.max(0, (Date.now() - Date.parse(updatedAt)) / 86_400_000);
  const score = normalized * 0.5 ** (ageDays / 30);
  return {
    selectedCount,
    expandedCount,
    usedCount,
    contradictedCount,
    rejectedCount,
    score,
    updatedAt,
  };
}

export function identityTokens(value: string): Set<string> {
  return new Set(
    normalize(value)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 2 && token !== "time"),
  );
}

export function requireText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} must not be empty`);
  return text;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

export function defaultResidence(input: {
  memoryType?: MemoryRecord["memoryType"];
  sourceActor?: MemoryRecord["sourceActor"];
  truthStatus?: MemoryRecord["truthStatus"];
}): MemoryResidence {
  const type = input.memoryType ?? "fact";
  if (type === "derived" || input.truthStatus === "inferred") return "stg";
  if (input.sourceActor === "assistant" && input.truthStatus === "unverified") return "stg";
  return "ltg";
}

export function defaultWriteReason(
  input: { memoryType?: MemoryRecord["memoryType"]; truthStatus?: MemoryRecord["truthStatus"] },
  residence: MemoryResidence,
): string {
  const type = input.memoryType ?? "fact";
  if (residence === "stg") return `provisional_${type}:${input.truthStatus ?? "asserted"}`;
  return `governed_durable_${type}`;
}

export function parseScope(value: string | number | Uint8Array | null): MemoryScope {
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value) as MemoryScope;
  } catch {
    return {};
  }
}

export function parseStoredJson<T>(value: string | number | Uint8Array | null, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Read the shadow QPP decision; undefined for pre-QPP or empty rows. */
export function parseQppDecision(
  value: string | number | Uint8Array | null,
): QppTriggerDecision | undefined {
  const parsed = parseStoredJson<QppTriggerDecision | null>(value, null);
  return parsed && typeof (parsed as { qpp?: unknown }).qpp === "number" ? parsed : undefined;
}

export type StoredClaim = {
  text: string;
  polarity: MemoryRecord["polarity"];
  predicate_key: string | null;
  confidence: number | null;
  extract_method: NonNullable<MemoryRecord["extractMethod"]>;
};

/** On-disk claims format is snake_case (shared with the Python extraction
 *  worker); the in-memory MemoryClaim shape is camelCase. */
export function serializeClaims(claims: MemoryRecord["claims"]): string | null {
  if (!claims) return null;
  const stored: StoredClaim[] = claims.map((claim) => ({
    text: claim.text,
    polarity: claim.polarity,
    predicate_key: claim.predicateKey,
    confidence: claim.confidence,
    extract_method: claim.extractMethod,
  }));
  return JSON.stringify(stored);
}

export function parseClaims(value: string | number | Uint8Array | null): MemoryRecord["claims"] {
  const stored = parseStoredJson<StoredClaim[] | null>(value, null);
  if (!stored) return null;
  return stored.map((claim) => ({
    text: claim.text,
    polarity: claim.polarity ?? null,
    predicateKey: claim.predicate_key ?? null,
    confidence: claim.confidence ?? null,
    extractMethod: claim.extract_method,
  }));
}

export function normalizeMarkers(markers: readonly MemoryMarker[] | undefined): MemoryMarker[] {
  if (!markers) return [];
  const normalized = markers.flatMap((marker) => {
    const kind = marker.kind?.trim();
    if (!kind) return [];
    const attributes = marker.attributes
      ? Object.fromEntries(
          Object.entries(marker.attributes)
            .filter(
              ([, value]) =>
                value === null ||
                typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "boolean",
            )
            .sort(([left], [right]) => left.localeCompare(right)),
        )
      : undefined;
    return [{ kind, ...(attributes && Object.keys(attributes).length > 0 ? { attributes } : {}) }];
  });
  return [...new Map(normalized.map((marker) => [JSON.stringify(marker), marker])).values()];
}

export function serializeMarkers(markers: readonly MemoryMarker[]): string {
  return JSON.stringify(normalizeMarkers(markers));
}

export function parseMarkers(value: string | number | Uint8Array | null): MemoryMarker[] {
  const stored = parseStoredJson<unknown>(value, []);
  if (!Array.isArray(stored)) return [];
  return normalizeMarkers(
    stored.filter(
      (marker): marker is MemoryMarker =>
        Boolean(marker) &&
        typeof marker === "object" &&
        typeof (marker as { kind?: unknown }).kind === "string",
    ),
  );
}

export function matchesScope(memory: MemoryScope, requested?: MemoryScope): boolean {
  if (!requested) return true;
  return Object.entries(requested).every(([key, value]) => memory[key] === value);
}

/** Which filter dimensions a query actually applies (for trace capture). */
export function effectiveFilterDimensions(options: SearchOptions): string[] {
  const dimensions: string[] = [];
  if (options.scope) {
    for (const key of Object.keys(options.scope)) dimensions.push(`scope.${key}`);
  }
  if (options.nodeName) dimensions.push("node");
  if (options.sourceActor) dimensions.push("sourceActor");
  if (options.includeHistorical) dimensions.push("includeHistorical");
  if (options.maxTier !== undefined && options.maxTier < 3)
    dimensions.push(`maxTier:${options.maxTier}`);
  if (options.graphHops !== undefined && options.graphHops > 0) dimensions.push("graphHops");
  return dimensions;
}

export function serializeScope(scope: MemoryScope): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(scope).sort(([left], [right]) => left.localeCompare(right))),
  );
}
