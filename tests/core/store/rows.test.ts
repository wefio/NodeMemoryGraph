import assert from "node:assert/strict";
import test from "node:test";

import type { MemoryMarker, MemoryScope, SearchOptions } from "../../../src/core/types.ts";
import type { StoreRow } from "../../../src/core/store/search-ranking.ts";
import {
  canonicalNodeIdentity,
  clamp,
  defaultResidence,
  defaultWriteReason,
  effectiveFilterDimensions,
  identityTokens,
  leafBlockSummary,
  mapActivation,
  mapConsolidationEvent,
  mapHistory,
  mapLeafBlock,
  mapMemoryWriteEvent,
  mapNode,
  mapRelation,
  mapSearchResult,
  mapTopologyProposal,
  matchesScope,
  normalizeMarkers,
  parseClaims,
  parseMarkers,
  parseQppDecision,
  parseScope,
  parseStoredJson,
  partitionLabel,
  requireText,
  serializeClaims,
  serializeMarkers,
  serializeScope,
  stableLeafBlockId,
} from "../../../src/core/store/rows.ts";

/**
 * Behavior pins for the row-mapper module (src/core/store/rows.ts).
 *
 * These functions moved out of NmgStore (store.ts) verbatim — a pure
 * extraction, no behavior change. This file is the contract that makes the
 * move safe: it imports from the NEW module path (pinning the seam) and
 * pins each mapper's defaults, null-coalescing and tolerant-parsing
 * branches so a future edit cannot silently change what a stored row
 * deserializes to.
 */

// ── node mappers ──

test("mapNode: maps all fields and defaults missing status/residence", () => {
  const node = mapNode({
    id: "node-1",
    canonical_name: "Atlas storage",
    kind: "project",
    summary: "The Atlas project",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-02-01T00:00:00.000Z",
  });
  assert.equal(node.id, "node-1");
  assert.equal(node.canonicalName, "Atlas storage");
  assert.equal(node.kind, "project");
  assert.equal(node.status, "active");
  assert.equal(node.residence, "ltg");
  assert.equal(node.createdAt, "2026-01-01T00:00:00.000Z");
});

test("mapNode: prefixed rows (n_) are used by search joins", () => {
  const node = mapNode({ n_id: "node-2", n_canonical_name: "Prefixed", n_kind: "feature" }, "n_");
  assert.equal(node.id, "node-2");
  assert.equal(node.canonicalName, "Prefixed");
  assert.equal(node.kind, "feature");
});

test("canonicalNodeIdentity: strips case, punctuation and whitespace", () => {
  assert.equal(canonicalNodeIdentity("Atlas Storage!"), canonicalNodeIdentity("atlasstorage"));
  assert.equal(canonicalNodeIdentity("NMG 🧠 v2"), canonicalNodeIdentity("nmgv2"));
  assert.notEqual(canonicalNodeIdentity("alpha"), canonicalNodeIdentity("beta"));
});

test("mapSearchResult: maps memory/node/evidence with tolerant nulls", () => {
  const result = mapSearchResult(
    {
      m_id: "mem-1",
      m_node_id: "node-1",
      m_evidence_id: "hist-1",
      m_statement: "Atlas uses SQLite",
      m_memory_type: "constraint",
      m_source_actor: "user",
      m_truth_status: "asserted",
      m_scope_json: '{"project":"atlas"}',
      m_markers_json: '[{"kind":"cached_from_ltg","attributes":{"sourceMemoryId":"ltg-1"}}]',
      m_claims_json:
        '[{"text":"x","polarity":"positive","predicate_key":null,"confidence":0.9,"extract_method":"regex"}]',
      m_status: "active",
      m_tier: 2,
      m_importance: 0.7,
      m_access_count: 3,
      m_evidence_role: "support",
      m_created_at: "2026-01-01T00:00:00.000Z",
      n_id: "node-1",
      n_canonical_name: "Atlas storage",
      n_kind: "project",
      h_id: "hist-1",
      h_role: "explicit",
      h_content: "raw evidence",
      h_created_at: "2026-01-01T00:00:00.000Z",
    },
    0.42,
  );
  assert.equal(result.memory.id, "mem-1");
  assert.equal(result.memory.nodeId, "node-1");
  assert.equal(result.memory.statement, "Atlas uses SQLite");
  assert.deepEqual(result.memory.scope, { project: "atlas" });
  assert.equal(result.memory.markers[0]?.kind, "cached_from_ltg");
  assert.equal(result.node.id, "node-1");
  assert.equal(result.node.canonicalName, "Atlas storage");
  assert.equal(result.evidence.content, "raw evidence");
  assert.equal(result.lexicalScore, 0.42);
  assert.equal(result.combinedScore, 0.42);
});

test("mapSearchResult: defaults for sparse rows (no write reason, null scope)", () => {
  const result = mapSearchResult(
    {
      m_id: "mem-2",
      m_node_id: "node-2",
      m_evidence_id: "hist-2",
      m_statement: "Sparse row",
      m_status: "active",
      m_tier: 1,
      m_importance: 0.5,
      m_access_count: 0,
      m_evidence_role: "support",
      m_created_at: "2026-01-01T00:00:00.000Z",
      n_id: "node-2",
      n_canonical_name: "Sparse node",
      n_kind: "fact",
      h_id: "hist-2",
      h_role: "explicit",
      h_content: "e",
      h_created_at: "2026-01-01T00:00:00.000Z",
    },
    0,
  );
  assert.equal(result.memory.writeReason, "legacy_write");
  assert.equal(result.memory.writeSource, "core");
  assert.equal(result.memory.residence, "ltg");
  assert.equal(result.memory.stateKey, null);
  assert.equal(result.memory.promotedAt, null);
  assert.equal(result.memory.expiresAt, null);
  assert.deepEqual(result.memory.scope, {});
  assert.equal(result.memory.claims, null);
  assert.deepEqual(result.memory.markers, []);
});

test("mapSearchResult: malformed JSON columns degrade to empty, not throw", () => {
  const result = mapSearchResult(
    {
      m_id: "mem-3",
      m_node_id: "node-3",
      m_evidence_id: "hist-3",
      m_statement: "Bad JSON row",
      m_status: "active",
      m_tier: 1,
      m_importance: 0.5,
      m_access_count: 0,
      m_evidence_role: "support",
      m_created_at: "2026-01-01T00:00:00.000Z",
      m_scope_json: "{not json",
      m_markers_json: "not json either",
      m_claims_json: "[oops",
      n_id: "node-3",
      n_canonical_name: "Bad node",
      n_kind: "fact",
      h_id: "hist-3",
      h_role: "explicit",
      h_content: "e",
      h_created_at: "2026-01-01T00:00:00.000Z",
    },
    0,
  );
  assert.deepEqual(result.memory.scope, {});
  assert.deepEqual(result.memory.markers, []);
  assert.equal(result.memory.claims, null);
});

test("mapHistory: maps row, tolerates null session/sourceRef", () => {
  const history = mapHistory({
    id: "hist-1",
    role: "explicit",
    content: "evidence",
    created_at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(history.id, "hist-1");
  assert.equal(history.sessionId, null);
  assert.equal(history.sourceMessageId, null);
  assert.equal(history.sourceRef, null);
});

test("mapRelation: defaults residence/status/stability/source and consolidatedAt fallback", () => {
  const relation = mapRelation({
    id: "rel-1",
    source_node_id: "node-a",
    target_node_id: "node-b",
    relation_type: "depends_on",
    created_at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(relation.residence, "ltg");
  assert.equal(relation.status, "consolidated");
  assert.equal(relation.stability, 1);
  assert.equal(relation.strength, 0.5);
  assert.equal(relation.direction, "both");
  assert.equal(relation.fanBudget, true);
  assert.equal(relation.activationRule, "conductive");
  assert.equal(relation.consolidationSource, "explicit");
  assert.equal(relation.consolidatedAt, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(relation.evidenceIds, []);
});

test("mapConsolidationEvent: maps action fields and evidence trace ids", () => {
  const event = mapConsolidationEvent({
    id: "ev-1",
    action: "promote_memory",
    target_id: "mem-1",
    previous_state: "stg",
    next_state: "ltg",
    reason: "governed",
    evidence_trace_ids_json: '["t1","t2"]',
    created_at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(event.action, "promote_memory");
  assert.deepEqual(event.evidenceTraceIds, ["t1", "t2"]);
});

test("mapMemoryWriteEvent: tolerates null memory/history ids", () => {
  const event = mapMemoryWriteEvent({
    id: "w-1",
    decision: "approved",
    policy_reason: "policy",
    write_reason: "write",
    write_source: "core",
    memory_type: "fact",
    requested_residence: "ltg",
    created_at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(event.memoryId, null);
  assert.equal(event.historyId, null);
  assert.equal(event.sessionId, null);
  assert.equal(event.decision, "approved");
});

test("mapActivation: computes normalized score with decay by age", () => {
  const fresh = mapActivation(
    {
      selected_count: 10,
      expanded_count: 5,
      used_count: 3,
      contradicted_count: 1,
      rejected_count: 2,
      updated_at: new Date().toISOString(),
    },
    true,
  );
  // positive = 10*0.1 + 5*0.15 + 3 = 4.75; negative = 1*0.8 + 2*0.4 = 1.6
  // normalized = (4.75 - 1.6) / (1 + 4.75 + 1.6) = 0.42857…
  assert.equal(fresh.selectedCount, 10);
  assert.equal(fresh.expandedCount, 5);
  assert.ok(Math.abs(fresh.score - 0.42857) < 0.02, `fresh score ${fresh.score}`);
});

test("mapActivation: age halves the score every 30 days; empty row scores zero", () => {
  const old = mapActivation(
    { selected_count: 1, used_count: 1, updated_at: new Date(0).toISOString() },
    false,
  );
  assert.ok(old.score < 0.01, `old score decays to ~0 (${old.score})`);
  const empty = mapActivation(undefined, true);
  assert.equal(empty.selectedCount, 0);
  assert.equal(empty.expandedCount, 0);
  assert.equal(empty.score, 0);
  assert.equal(empty.updatedAt, new Date(0).toISOString());
});

test("mapLeafBlock and mapTopologyProposal: map rows, tolerant of bad partitions", () => {
  const block = mapLeafBlock({
    id: "leaf-1",
    node_id: "node-1",
    tier: 2,
    summary: "leaf summary",
    memory_count: 4,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(block.nodeId, "node-1");
  assert.equal(block.tier, 2);
  assert.equal(block.memoryCount, 4);

  const proposal = mapTopologyProposal({
    id: "prop-1",
    proposal_key: "key",
    proposal_type: "merge",
    source_node_ids_json: '["n1"]',
    evidence_trace_ids_json: "[]",
    observations: 3,
    estimated_gain: 0.5,
    status: "pending",
    created_at: "2026-01-01T00:00:00.000Z",
    partitions_json: '[{"label":"fact","memoryIds":["m1"]}]',
  });
  assert.equal(proposal.type, "merge");
  assert.deepEqual(proposal.sourceNodeIds, ["n1"]);
  assert.deepEqual(proposal.partitions, [{ label: "fact", memoryIds: ["m1"] }]);

  const broken = mapTopologyProposal({
    id: "prop-2",
    proposal_key: "key2",
    proposal_type: "merge",
    source_node_ids_json: "[oops",
    evidence_trace_ids_json: "[]",
    observations: 1,
    estimated_gain: 0.1,
    status: "pending",
    created_at: "2026-01-01T00:00:00.000Z",
    partitions_json: "{not json",
  });
  assert.deepEqual(broken.partitions, []);
  assert.deepEqual(broken.sourceNodeIds, []);
});

test("partitionLabel: renders type + scope, degrades to partition index", () => {
  assert.equal(partitionLabel('fact|{"project":"atlas"}', 0), "fact atlas");
  assert.equal(partitionLabel("event|not json", 2), "event");
  assert.equal(partitionLabel("", 3), "partition 4");
});

// ── leaf block helpers ──

test("stableLeafBlockId: stable for same content, changes with content", () => {
  const rows: StoreRow[] = [
    {
      id: "m1",
      statement: "Atlas uses SQLite",
      memory_type: "constraint",
      scope_json: '{"project":"atlas"}',
      tier: 1,
      event_time: "2026-01-01T00:00:00.000Z",
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_until: null,
    },
  ];
  assert.equal(stableLeafBlockId(rows), stableLeafBlockId(rows));
  assert.notEqual(
    stableLeafBlockId(rows),
    stableLeafBlockId([{ ...rows[0]!, statement: "changed" }]),
  );
});

test("leafBlockSummary: composes node/type/tier/scope/time/count/examples", () => {
  const rows: StoreRow[] = [
    {
      canonical_name: "Atlas storage",
      memory_type: "constraint",
      tier: 1,
      scope_json: '{"project":"atlas"}',
      event_time: "2026-01-01T00:00:00.000Z",
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_until: null,
      statement: "Atlas must use SQLite",
    },
    {
      canonical_name: "Atlas storage",
      memory_type: "constraint",
      tier: 1,
      scope_json: '{"project":"atlas"}',
      event_time: "2026-02-01T00:00:00.000Z",
      valid_from: "2026-02-01T00:00:00.000Z",
      valid_until: null,
      statement: "Atlas uses WAL mode",
    },
  ];
  const summary = leafBlockSummary(rows);
  assert.match(summary, /node=Atlas storage/);
  assert.match(summary, /type=constraint/);
  assert.match(summary, /tier=1/);
  assert.match(summary, /scope=project=atlas/);
  assert.match(summary, /count=2/);
  assert.match(summary, /examples=Atlas must use SQLite; Atlas uses WAL mode/);
});

// ── tolerant JSON parsing ──

test("parseScope: valid JSON object, invalid and non-string degrade to {}", () => {
  assert.deepEqual(parseScope('{"project":"atlas"}'), { project: "atlas" });
  assert.deepEqual(parseScope("not json"), {});
  assert.deepEqual(parseScope(null), {});
  assert.deepEqual(parseScope(42), {});
});

test("parseStoredJson: typed passthrough, invalid and non-string use fallback", () => {
  assert.deepEqual(parseStoredJson<number[]>("[1,2]", []), [1, 2]);
  assert.deepEqual(parseStoredJson<number[]>("broken", []), []);
  assert.deepEqual(parseStoredJson<number[]>(null, []), []);
});

test("parseQppDecision: only rows with a qpp number count as a decision", () => {
  const decision = parseQppDecision(
    '{"qpp":0.9,"trigger":true,"reason":"uncertain","expansion":null}',
  );
  assert.ok(decision);
  assert.equal(decision.qpp, 0.9);
  assert.equal(parseQppDecision('{"foo":1}'), undefined);
  assert.equal(parseQppDecision("broken"), undefined);
  assert.equal(parseQppDecision(null), undefined);
});

// ── claims / markers (snake_case on disk, camelCase in memory) ──

test("claims: serialize/parse round-trip through the snake_case disk format", () => {
  const claims = [
    {
      text: "Atlas uses SQLite",
      polarity: "positive" as const,
      predicateKey: "uses",
      confidence: 0.9,
      extractMethod: "regex" as const,
    },
  ];
  const serialized = serializeClaims(claims);
  assert.match(serialized!, /predicate_key/);
  assert.deepEqual(parseClaims(serialized), claims);
  assert.equal(serializeClaims(null), null);
  assert.equal(parseClaims(null), null);
});

test("markers: normalize dedupes, strips empty kinds, sorts attributes", () => {
  const markers: MemoryMarker[] = [
    { kind: "cached_from_ltg", attributes: { b: "2", a: "1", sourceMemoryId: "ltg-1" } },
    { kind: "cached_from_ltg", attributes: { sourceMemoryId: "ltg-1", a: "1", b: "2" } },
    { kind: "  " },
  ];
  const normalized = normalizeMarkers(markers);
  assert.equal(normalized.length, 1);
  assert.deepEqual(normalized[0]?.attributes, { a: "1", b: "2", sourceMemoryId: "ltg-1" });
  assert.deepEqual(normalizeMarkers(undefined), []);
});

test("markers: serialize/parse round-trip; parse tolerates junk entries", () => {
  const serialized = serializeMarkers([{ kind: "sticky", attributes: { note: "keep" } }]);
  assert.deepEqual(parseMarkers(serialized), [{ kind: "sticky", attributes: { note: "keep" } }]);
  assert.deepEqual(parseMarkers("junk"), []);
  assert.deepEqual(parseMarkers('[{"kind":"ok"},{"kind":123},{"notkind":"x"}]'), [{ kind: "ok" }]);
});

// ── scope matching / serialization ──

test("matchesScope: requested undefined matches everything, else all keys equal", () => {
  const scope: MemoryScope = { project: "atlas", area: "core" };
  assert.equal(matchesScope(scope), true);
  assert.equal(matchesScope(scope, { project: "atlas" }), true);
  assert.equal(matchesScope(scope, { project: "nmg" }), false);
  assert.equal(matchesScope(scope, { area: "core" }), true);
  assert.equal(matchesScope(scope, { project: "atlas", area: "other" }), false);
});

test("serializeScope: keys sorted for deterministic on-disk form", () => {
  assert.equal(serializeScope({ project: "nmg", area: "core" }), '{"area":"core","project":"nmg"}');
  assert.equal(serializeScope({}), "{}");
});

test("effectiveFilterDimensions: reports every applied filter dimension", () => {
  const options: SearchOptions = {
    scope: { project: "atlas" },
    nodeName: "storage",
    sourceActor: "user",
    includeHistorical: true,
    maxTier: 2,
    graphHops: 1,
  };
  assert.deepEqual(effectiveFilterDimensions(options), [
    "scope.project",
    "node",
    "sourceActor",
    "includeHistorical",
    "maxTier:2",
    "graphHops",
  ]);
  assert.deepEqual(effectiveFilterDimensions({}), []);
  assert.deepEqual(effectiveFilterDimensions({ maxTier: 3 }), []);
  assert.deepEqual(effectiveFilterDimensions({ graphHops: 0 }), []);
});

// ── validation / numeric helpers ──

test("clamp: bounds values and treats non-finite as minimum", () => {
  assert.equal(clamp(0.5, 0, 1), 0.5);
  assert.equal(clamp(2, 0, 1), 1);
  assert.equal(clamp(-1, 0, 1), 0);
  assert.equal(clamp(Number.NaN, 0, 1), 0);
});

test("requireText: trims and rejects empty", () => {
  assert.equal(requireText("  hello  ", "label"), "hello");
  assert.throws(() => requireText("   ", "memory statement"), /memory statement must not be empty/);
});

test("defaultResidence: derived/inferred/assistant-unverified are provisional", () => {
  assert.equal(defaultResidence({ memoryType: "derived" }), "stg");
  assert.equal(defaultResidence({ truthStatus: "inferred" }), "stg");
  assert.equal(defaultResidence({ sourceActor: "assistant", truthStatus: "unverified" }), "stg");
  assert.equal(defaultResidence({}), "ltg");
  assert.equal(defaultResidence({ sourceActor: "assistant", truthStatus: "asserted" }), "ltg");
});

test("defaultWriteReason: provisional vs governed wording", () => {
  assert.equal(
    defaultWriteReason({ memoryType: "fact", truthStatus: "inferred" }, "stg"),
    "provisional_fact:inferred",
  );
  assert.equal(
    defaultWriteReason({ memoryType: "constraint" }, "ltg"),
    "governed_durable_constraint",
  );
});

test("identityTokens: splits on non-alphanumeric, drops short tokens and 'time'", () => {
  const tokens = identityTokens("SQLite query plan time!");
  assert.deepEqual([...tokens].sort(), ["plan", "query", "sqlite"]);
});
