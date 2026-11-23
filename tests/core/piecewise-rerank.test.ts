import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { replaceGraphNode, INPUT_NODE_ID } from "../../src/core/compute-graph.ts";
import { MemoryEngine } from "../../src/core/memory/engine.ts";
import { isUnboundNode } from "../../src/core/memory/model.ts";
import { openMemoryBackend } from "../../src/core/memory/open.ts";
import {
  DEFAULT_PIECEWISE_RERANK_GRAPH,
  createPiecewiseRerankGraph,
  rerankCandidatesWithGraph,
  type RerankCandidate,
} from "../../src/core/memory/piecewise-rerank.ts";
import { eventDateIndexText } from "../../src/core/memory/sqlite-text-index.ts";
import { parseLocalMemoryHttpConfig } from "../../src/cli/local-memory-http-config.ts";
import { renderSearchSurface } from "../../src/integration/agent-surface.ts";
import { fitExplicitSearchPage } from "../../src/integration/explicit-search-page.ts";
import { resolveHttpProfileHead } from "../../src/integration/http-profile-view.ts";
import { sourceHttpMessageId } from "../../src/integration/memory-http-protocol.ts";
import { HttpMemoryService } from "../../src/integration/memory-http-service.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

test("eventDateIndexText expands valid eventTime to English/Chinese search terms and ignores missing dates", () => {
  const expanded = eventDateIndexText("2023-05-08T14:20:00Z");
  assert.match(expanded, /2023-05-08/);
  assert.match(expanded, /\b8 may 2023\b/);
  assert.match(expanded, /\bmay 2023\b/);
  assert.match(expanded, /2023年5月8日/);
  assert.equal(eventDateIndexText(null), "");
  assert.equal(eventDateIndexText("not-a-date"), "");
});

test("DEFAULT_PIECEWISE_RERANK_GRAPH protects head R3, deduplicates mid R1+R5, and boosts tail W_SESS", () => {
  const candidates: RerankCandidate[] = [];
  // Top 5: item-3 has a real date matching the date question, slightly behind item-1.
  candidates.push(
    {
      id: "top-1",
      statement: "General planning note without dates",
      combinedScore: 10.05,
      eventTime: "2023-01-01T00:00:00Z",
      sessionId: "s-other",
      nodeId: "n1",
    },
    {
      id: "top-date",
      statement: "Visited Kyoto on May 8, 2023 for the spring workshop",
      combinedScore: 10.0,
      eventTime: "2023-05-08T00:00:00Z",
      sessionId: "s-focus",
      nodeId: "n1",
    },
  );
  for (let i = 3; i <= 5; i += 1) {
    candidates.push({
      id: `head-${i}`,
      statement: `Unique head topic number ${i} alpha`,
      combinedScore: 10 - i * 0.1,
      eventTime: "2023-02-01T00:00:00Z",
      sessionId: "s-other",
      nodeId: "n2",
    });
  }
  // Mid band [6..20]: rank 6 and rank 7 are near-duplicates; rank 8 brings distinct evidence.
  candidates.push(
    {
      id: "mid-dup-a",
      statement: "hiking mountain trail pine forest sunrise backpack",
      combinedScore: 8.5,
      eventTime: "2023-05-08T00:00:00Z",
      sessionId: "s-mid",
      nodeId: "n3",
    },
    {
      id: "mid-dup-b",
      statement: "hiking mountain trail pine forest sunrise backpacks",
      combinedScore: 8.4,
      eventTime: "2023-05-08T00:00:00Z",
      sessionId: "s-mid",
      nodeId: "n3",
    },
    {
      id: "mid-distinct",
      statement: "ceramic pottery studio glaze kiln exhibition",
      combinedScore: 8.2,
      eventTime: "2023-05-08T00:00:00Z",
      sessionId: "s-focus",
      nodeId: "n4",
    },
  );
  for (let i = 9; i <= 25; i += 1) {
    candidates.push({
      id: `tail-${i}`,
      statement: `Distinct filler statement item_${i} omega_${i}`,
      combinedScore: 8.0 - i * 0.05,
      eventTime: "2023-01-10T00:00:00Z",
      sessionId: i === 25 ? "s-focus" : `s-noise-${i}`,
      nodeId: `n-${i}`,
    });
  }

  const reranked = rerankCandidatesWithGraph(
    candidates,
    "When did I visit Kyoto?",
    DEFAULT_PIECEWISE_RERANK_GRAPH,
  );
  assert.equal(reranked[0]?.id, "top-date");
  assert.ok(reranked[0]!.combinedScore >= reranked[1]!.combinedScore);

  const midWindowIds = reranked.slice(5, 10).map((item) => item.id);
  const distinctPos = reranked.findIndex((item) => item.id === "mid-distinct");
  const dupBPos = reranked.findIndex((item) => item.id === "mid-dup-b");
  assert.ok(midWindowIds.includes("mid-dup-a"));
  assert.ok(distinctPos >= 5 && distinctPos < dupBPos);

  // In the [21..100] tail, s-focus (already strong in head/mid) should lift tail-25 above older noise.
  const tail25Pos = reranked.findIndex((item) => item.id === "tail-25");
  assert.ok(tail25Pos >= 20 && tail25Pos < 24);

  // Swapping head_r3 to identity_rank keeps top-1 first instead of boosting top-date.
  const noHeadR3 = replaceGraphNode(DEFAULT_PIECEWISE_RERANK_GRAPH, "head_r3", {
    op: "identity_rank",
  });
  const withoutR3 = rerankCandidatesWithGraph(candidates, "When did I visit Kyoto?", noHeadR3);
  assert.equal(withoutR3[0]?.id, "top-1");

  // Node-less candidates with null sessionId fall back to shared evidenceId for w_session_pivot.
  const customGraph = createPiecewiseRerankGraph({
    id: "custom-evidence-pivot",
    sessionWeight: 0.4,
  });
  const sharedEvidenceCandidates: RerankCandidate[] = Array.from({ length: 24 }, (_, idx) => ({
    id: `ev-${idx}`,
    statement: `Distinct note ${idx} omega_${idx}`,
    combinedScore: 10 - idx * 0.1,
    eventTime: "2023-01-10T00:00:00Z",
    sessionId: null,
    nodeId: "",
    evidenceId: idx === 0 || idx === 23 ? "hist-shared" : `hist-${idx}`,
  }));
  const pivoted = rerankCandidatesWithGraph(sharedEvidenceCandidates, "omega", customGraph);
  const tailPos = pivoted.findIndex((item) => item.id === "ev-23");
  assert.ok(tailPos >= 20 && tailPos < 23);
});

test("SQLite dates column retrieves undated statements via natural-language dates and migrates 2-column FTS5", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-dates-index-"));
  const path = join(directory, "memory.sqlite");
  const openBackends: Awaited<ReturnType<typeof openMemoryBackend>>[] = [];
  t.after(async () => {
    while (openBackends.length > 0) {
      await openBackends.pop()?.close();
    }
    removeTempDirectory(directory);
  });
  const backend = await openMemoryBackend({ kind: "sqlite", path, namespace: "dates-ns" });
  openBackends.push(backend);
  const engine = new MemoryEngine(backend, () => "2023-06-01T00:00:00.000Z");

  const mayMemory = await engine.remember({
    statement: "Bought a titanium gravel bicycle frame.",
    eventTime: "2023-05-08T10:30:00Z",
  });
  await engine.remember({
    statement: "Booked autumn train tickets to Osaka.",
    eventTime: "2023-10-12T10:30:00Z",
  });

  assert.equal(
    (await engine.search("May 2023 bicycle")).results[0]?.memory.id,
    mayMemory.memory.id,
  );
  assert.equal((await engine.search("8 May 2023")).results[0]?.memory.id, mayMemory.memory.id);
  assert.equal((await engine.search("2023年5月8日")).results[0]?.memory.id, mayMemory.memory.id);
  await backend.close();
  openBackends.length = 0;

  // Simulate an older 2-column (text, triggers) contentless FTS5 DB and reopen to verify auto-upgrade.
  const raw = new DatabaseSync(path);
  try {
    raw.exec(`
      DROP TABLE nmg_memory_fts;
      CREATE VIRTUAL TABLE nmg_memory_fts
        USING fts5(text, triggers, content='', contentless_delete=1, tokenize='porter unicode61');
      INSERT INTO nmg_memory_fts(nmg_memory_fts, rank) VALUES('rank', 'bm25(1.0, 1.5)');
    `);
  } finally {
    raw.close();
  }

  const reopened = await openMemoryBackend({ kind: "sqlite", path, namespace: "dates-ns" });
  openBackends.push(reopened);
  const upgradedEngine = new MemoryEngine(reopened, () => "2023-06-01T00:00:00.000Z");
  assert.equal(
    (await upgradedEngine.search("May 2023 bicycle")).results[0]?.memory.id,
    mayMemory.memory.id,
  );
});

test("memories written without nodeName require zero graph nodes and attach progressively later", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-progressive-graph-"));
  const path = join(directory, "memory.sqlite");
  const backend = await openMemoryBackend({ kind: "sqlite", path, namespace: "prog-ns" });
  t.after(async () => {
    await backend.close();
    removeTempDirectory(directory);
  });
  const engine = new MemoryEngine(backend, () => "2026-11-23T00:00:00.000Z");

  const first = await engine.remember({ statement: "Atlas gateway listens on port 8080" });
  const second = await engine.remember({ statement: "Vector worker pools flush every 5 minutes" });
  assert.equal(first.memory.nodeId, "");
  assert.equal(first.node.id, "");
  assert.equal(isUnboundNode(first.node), true);

  const readBefore = await backend.openRead();
  try {
    const counts = await backend.counts!(readBefore);
    assert.deepEqual(counts, { memories: 2, nodes: 0 });
  } finally {
    await backend.closeRead(readBefore);
  }

  // Search and exportMemories work seamlessly on node-less memories.
  const searchBefore = await engine.search("Atlas gateway", { graphHops: 1 });
  assert.equal(searchBefore.results[0]?.memory.id, first.memory.id);
  assert.deepEqual(searchBefore.relations, []);
  assert.equal((await engine.exportMemories()).items.length, 2);

  // Progressively materialize graph nodes and explicit relation later.
  const boundA = await engine.attachNode(first.memory.id, { nodeName: "Gateway" });
  const boundB = await engine.attachNode(second.memory.id, { nodeName: "WorkerPool" });
  await engine.linkNodes({
    sourceNodeId: boundA.node.id,
    targetNodeId: boundB.node.id,
    type: "depends_on",
  });

  const searchAfter = await engine.search("Atlas gateway", { graphHops: 1, limit: 10 });
  assert.equal(searchAfter.relations.length, 1);
  assert.ok(searchAfter.results.some((item) => item.memory.id === second.memory.id));
  assert.ok(searchAfter.results.some((item) => (item.path?.length ?? 0) === 1));
  assert.ok(INPUT_NODE_ID);
});

test("engine.projectGraph creates on-demand multi-dimensional pivot graphs without mutating records", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-pivot-projection-"));
  const backend = await openMemoryBackend({
    kind: "sqlite",
    path: join(directory, "memory.sqlite"),
    namespace: "pivot-ns",
  });
  t.after(async () => {
    await backend.close();
    removeTempDirectory(directory);
  });
  const engine = new MemoryEngine(backend, () => "2026-11-23T00:00:00.000Z");

  const a = await engine.remember({
    statement: "Staging deploy uses blue-green routing",
    nodeName: "DeployPipeline",
    memoryType: "state",
    stateKey: "deploy.strategy",
    scope: { service: "api" },
    sessionId: null,
  });
  const b = await engine.remember({
    statement: "Database migrations run before readiness probe",
    nodeName: "DbMigration",
    memoryType: "fact",
    scope: { service: "api" },
    sessionId: null,
  });
  await engine.linkNodes({
    sourceNodeId: a.node.id,
    targetNodeId: b.node.id,
    type: "depends_on",
  });
  await engine.remember({
    statement: "Session note: latency spiked during warmup",
    memoryType: "event",
    residence: "stg",
    sessionId: "sess-warm",
    scope: { service: "api" },
  });

  const multi = await engine.projectGraph({
    dimensions: ["node", "stateKey", "session", "scope"],
    sessionId: "sess-warm",
  });
  assert.equal(multi.memoryCount, 3);
  assert.ok(multi.nodes.some((n) => n.dimension === "node" && n.label === "DeployPipeline"));
  assert.ok(multi.nodes.some((n) => n.dimension === "stateKey" && n.key === "deploy.strategy"));
  assert.ok(multi.nodes.some((n) => n.dimension === "session" && n.key === "sess-warm"));
  assert.ok(multi.edges.some((e) => e.kind === "co_occurrence"));
  assert.ok(multi.edges.some((e) => e.kind === "explicit" && e.relationType === "depends_on"));

  // Re-pivot strictly on session dimension: unbound STG note surfaces cleanly.
  const bySession = await engine.projectGraph({
    dimensions: ["session"],
    sessionId: "sess-warm",
  });
  assert.deepEqual(
    bySession.nodes.map((n) => n.key),
    ["sess-warm"],
  );
});

test("HttpMemoryService.rememberBatch creates zero fake session nodes and meets throughput budget", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-http-fast-ingest-"));
  const backend = await openMemoryBackend({
    kind: "sqlite",
    path: join(directory, "memory.sqlite"),
    namespace: "http-fast",
  });
  t.after(async () => {
    await backend.close();
    removeTempDirectory(directory);
  });

  const engine = new MemoryEngine(backend, () => "2026-11-23T00:00:00.000Z");
  const service = new HttpMemoryService(engine);

  const startedAt = performance.now();
  for (let batch = 0; batch < 10; batch += 1) {
    const messages = Array.from({ length: 50 }, (_, index) => ({
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `Batch ${batch} message ${index} covering query routing and relational storage`,
      chat_time: "2026-11-23T08:00:00.000Z",
      source_message_id: sourceHttpMessageId(`fast-${batch}`, index),
    }));
    await service.rememberBatch("u-fast", `sess-${batch % 3}`, `req-${batch}`, messages);
  }
  const elapsedMs = performance.now() - startedAt;

  const view = await backend.openRead();
  try {
    const counts = await backend.counts!(view);
    assert.deepEqual(counts, { memories: 500, nodes: 0 });
  } finally {
    await backend.closeRead(view);
  }

  const exported = await engine.exportMemories();
  assert.equal(exported.items.length, 500);
  assert.equal(exported.items[0]?.memory.nodeId, "");
  assert.ok(exported.items[0]?.memory.sourceSessionId?.startsWith("sess-"));
  assert.ok(elapsedMs < 5000, `500 HTTP batch inserts took too long: ${elapsedMs.toFixed(1)}ms`);
});

test("bm25f_field_score, w_temporal_pivot, w_concept_pivot, and w_lineage_pivot compose cleanly in ComputeGraphSpec", () => {
  const candidates: RerankCandidate[] = [
    {
      id: "long-weak",
      statement:
        "This long note repeats generic project checklist status details many times without the concise trigger",
      combinedScore: 1.0,
      eventTime: "2026-04-01T08:00:00Z",
      sessionId: "s-other",
      nodeId: "",
      markers: [],
    },
    {
      id: "trigger-concise",
      statement: "Approved cache failover rollout",
      combinedScore: 0.99,
      eventTime: "2026-04-12T09:00:00Z",
      sessionId: "s-anchor",
      nodeId: "",
      stateKey: "cache.failover",
      markers: [{ kind: "recall_trigger", attributes: { trigger: "failover sentinel" } }],
    },
    {
      id: "same-day-peer",
      statement: "Verified backup replica health check passed cleanly",
      combinedScore: 0.4,
      eventTime: "2026-04-12T17:30:00Z",
      sessionId: "s-other-day",
      nodeId: "",
      supersedesId: "trigger-concise",
      markers: [{ kind: "recall_trigger", attributes: { trigger: "sentinel" } }],
    },
    {
      id: "unrelated-mid",
      statement: "Unrelated cafeteria lunch menu memo",
      combinedScore: 0.65,
      eventTime: "2026-01-05T12:00:00Z",
      sessionId: "s-misc",
      nodeId: "",
    },
  ];

  const graph = createPiecewiseRerankGraph({
    id: "bm25f-plus-neighborhoods",
    bands: [
      { port: "head", endRank: 1 },
      { port: "tail", endRank: 4 },
    ],
  });
  const withBm25fHead = replaceGraphNode(graph, "head_r3", {
    op: "bm25f_field_score",
    params: { weight: 0.35 },
  });
  const withNeighborhoodTail = replaceGraphNode(withBm25fHead, "tail_wsess", {
    op: "subgraph",
    subgraph: {
      id: "tail-neighborhoods",
      nodes: [
        { id: "wt", op: "w_temporal_pivot", params: { weight: 0.2, anchorTopK: 2 } },
        { id: "wc", op: "w_concept_pivot", params: { weight: 0.2, anchorTopK: 2 } },
        { id: "wl", op: "w_lineage_pivot", params: { weight: 0.2, anchorTopK: 2 } },
      ],
      edges: [
        { from: INPUT_NODE_ID, to: "wt" },
        { from: "wt", to: "wc" },
        { from: "wc", to: "wl" },
      ],
      output: "wl",
    },
  });

  const ranked = rerankCandidatesWithGraph(
    candidates,
    "failover sentinel april 2026",
    withNeighborhoodTail,
  );
  assert.equal(ranked[0]?.id, "trigger-concise");
  const peerIdx = ranked.findIndex((c) => c.id === "same-day-peer");
  const miscIdx = ranked.findIndex((c) => c.id === "unrelated-mid");
  assert.ok(peerIdx >= 0 && peerIdx < miscIdx);
});

test("5-layer relational tables support backfill, zero-JSON paginated pivot views, and node-free memory links", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-relational-pivot-"));
  const path = join(directory, "memory.sqlite");
  const backend = await openMemoryBackend({ kind: "sqlite", path, namespace: "rel-ns" });
  const closeables: Array<Awaited<ReturnType<typeof openMemoryBackend>>> = [backend];
  t.after(async () => {
    for (const item of closeables) await item.close();
    removeTempDirectory(directory);
  });

  const engine = new MemoryEngine(backend, () => "2026-11-23T10:00:00.000Z");
  const m1 = await engine.remember({
    statement: "Feature flag rollout enabled in eu-west",
    eventTime: "2026-10-01T08:00:00Z",
    memoryType: "state",
    stateKey: "flag.rollout",
    predicateKey: "flag_status",
    polarity: "affirmative",
    recallTriggers: ["canary_gate"],
    sessionId: null,
    importedEvidence: {
      role: "user",
      sessionId: "sess-1",
      sourceMessageId: "1",
      sourceRef: "1",
      content: "Turned on feature flag in eu-west",
    },
  });
  await engine.remember({
    statement: "Feature flag rollout paused after latency spike",
    eventTime: "2026-10-01T14:00:00Z",
    memoryType: "event",
    predicateKey: "flag_status",
    polarity: "negative",
    sourceActor: "assistant",
    recallTriggers: ["canary_gate"],
    sessionId: null,
    importedEvidence: {
      role: "assistant",
      sessionId: "sess-1",
      sourceMessageId: "2",
      sourceRef: "2",
      content: "Pausing feature flag",
    },
  });
  const m3 = await engine.remember({
    statement: "Latency root cause isolated to connection pool exhaustion",
    eventTime: "2026-10-02T09:00:00Z",
    memoryType: "fact",
    sessionId: null,
    importedEvidence: {
      role: "user",
      sessionId: "sess-2",
      sourceMessageId: "s2-1",
      sourceRef: "s2-1",
      content: "Root cause was pool exhaustion",
    },
  });
  const m4 = await engine.remember({
    statement: "Independent eu-west CDN purge occurred the same evening",
    eventTime: "2026-10-01T19:00:00Z",
    memoryType: "event",
    sessionId: null,
    importedEvidence: {
      role: "user",
      sessionId: "sess-3",
      sourceMessageId: "s3-1",
      sourceRef: "s3-1",
      content: "CDN purge in eu-west",
    },
  });

  // Node-free explicit MemoryRelation
  const link = await engine.linkMemories({
    sourceMemoryId: m1.memory.id,
    targetMemoryId: m3.memory.id,
    type: "causes",
  });
  assert.equal(link.sourceKind, "memory");
  assert.equal(link.targetKind, "memory");
  assert.equal(link.relationType, "causes");

  // Node-less neighborhood discovery finds memory_relation and cross-session same_event_day neighbors
  const hood = await engine.searchNeighborhood(m1.memory.id, { limit: 6 });
  assert.ok(hood);
  assert.ok(
    hood.results.some((r) => r.memory.id === m3.memory.id && r.neighborhood === "memory_relation"),
  );
  assert.ok(
    hood.results.some((r) => r.memory.id === m4.memory.id && r.neighborhood === "same_event_day"),
  );

  // Guard: projectGraph must NOT query nmg_memory_entities (uses 5-layer relational SQL directly)
  const prepare = DatabaseSync.prototype.prepare;
  let legacyEntityScans = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.includes("FROM nmg_memory_entities") && sql.includes("kind = 'memory'")) {
      legacyEntityScans += 1;
    }
    return prepare.call(this, sql);
  });

  const page1 = await engine.projectGraph({
    dimensions: ["time", "evidence", "actor", "session", "memoryType"],
    timeGranularity: "day",
    limit: 2,
    offset: 0,
  });
  assert.equal(legacyEntityScans, 0);
  assert.equal(page1.memoryCount, 2);
  assert.equal(page1.page?.hasMore, true);
  assert.equal(page1.page?.nextOffset, 2);
  assert.ok(page1.nodes.some((n) => n.dimension === "time" && n.key === "2026-10-01"));
  assert.ok(page1.nodes.some((n) => n.dimension === "evidence"));
  assert.ok(page1.nodes.some((n) => n.dimension === "actor" && n.key === "user"));

  const allProj = await engine.projectGraph({
    dimensions: ["time", "evidence", "actor", "session"],
    eventTimeFrom: "2026-10-01",
    eventTimeTo: "2026-10-02",
    limit: 10,
  });
  assert.equal(allProj.memoryCount, 4);
  assert.equal(allProj.page?.hasMore, false);
  assert.ok(allProj.edges.some((e) => e.kind === "semantic" && e.relationType === "causes"));
  assert.ok(allProj.edges.some((e) => e.kind === "semantic" && e.relationType === "contradicts"));
  assert.ok(
    allProj.edges.some((e) => e.kind === "semantic" && e.relationType === "shared_concept"),
  );

  await backend.close();

  // Backfill check: clearing relational tables + backfill flag repopulates from existing nmg_memory_entities on reopen
  const raw = new DatabaseSync(path);
  try {
    raw.exec(`
      DELETE FROM nmg_memories;
      DELETE FROM nmg_sources;
      DELETE FROM nmg_memory_evidence;
      DELETE FROM nmg_memory_relations;
      DELETE FROM nmg_memory_markers;
      DELETE FROM nmg_relational_backfill;
    `);
  } finally {
    raw.close();
  }

  const reopened = await openMemoryBackend({ kind: "sqlite", path, namespace: "rel-ns" });
  closeables.push(reopened);
  const reopenedEngine = new MemoryEngine(reopened, () => "2026-11-23T10:00:00.000Z");
  const afterReopen = await reopenedEngine.projectGraph({
    dimensions: ["time", "evidence", "actor"],
    limit: 10,
  });
  assert.equal(afterReopen.memoryCount, 4);
  assert.ok(afterReopen.edges.some((e) => e.kind === "semantic" && e.relationType === "causes"));
});

test("w_turn_pivot in DEFAULT_PIECEWISE_RERANK_GRAPH lifts adjacent dialogue turns within +-1 ordinal", () => {
  const candidates: RerankCandidate[] = [
    {
      id: "head-anchor",
      statement: "User asked about low-latency rhythm mechanics in fighting games",
      combinedScore: 2.4,
      eventTime: null,
      sessionId: "sess-dialog",
      nodeId: "n1",
      turnOrdinal: 10,
    },
  ];
  for (let i = 1; i <= 5; i += 1) {
    if (i === 1) continue;
    candidates.push({
      id: `head-filler-${i}`,
      statement: `Unrelated head topic ${i}`,
      combinedScore: 2.3 - i * 0.05,
      eventTime: null,
      sessionId: `sess-other-${i}`,
      nodeId: `n-${i}`,
      turnOrdinal: 50 + i,
    });
  }
  for (let i = 6; i <= 24; i += 1) {
    const isAdj = i === 23;
    candidates.push({
      id: isAdj ? "adj-partner-turn" : `mid-noise-${i}`,
      statement: isAdj
        ? "Short response agreeing about the 5ms frame window"
        : `Distinct unrelated noise item ${i} topic_${i}`,
      combinedScore: 1.6 - i * 0.02,
      eventTime: null,
      sessionId: isAdj ? "sess-dialog" : `sess-noise-${i}`,
      nodeId: `n-${i}`,
      turnOrdinal: isAdj ? 11 : 80 + i,
    });
  }
  candidates.push({
    id: "distant-same-session",
    statement: "Distant turn in the same session outside turn radius",
    combinedScore: 1.15,
    eventTime: null,
    sessionId: "sess-dialog",
    nodeId: "n-distant",
    turnOrdinal: 45,
  });

  const reranked = rerankCandidatesWithGraph(
    candidates,
    "low-latency fighting game rhythm",
    DEFAULT_PIECEWISE_RERANK_GRAPH,
  );
  assert.equal(reranked[0]?.id, "head-anchor");
  const adjRank = reranked.findIndex((c) => c.id === "adj-partner-turn");
  const distantRank = reranked.findIndex((c) => c.id === "distant-same-session");
  assert.ok(adjRank >= 5 && adjRank < 20, `expected adj-partner-turn in [5..19], got ${adjRank}`);
  assert.ok(adjRank < distantRank);
});

test("interleaved HttpMemoryService ADD and Search ranks newer updates first in lexical and hybrid modes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-interleaved-http-"));
  const lexicalBackend = await openMemoryBackend({
    kind: "sqlite",
    path: join(dir, "lexical.sqlite"),
    namespace: "interleaved-lex",
  });
  const hybridBackend = await openMemoryBackend({
    kind: "sqlite",
    path: join(dir, "hybrid.sqlite"),
    namespace: "interleaved-hyb",
  });
  t.after(async () => {
    await lexicalBackend.close();
    await hybridBackend.close();
    removeTempDirectory(dir);
  });

  const embedText = (text: string): number[] => {
    const lower = text.toLowerCase();
    return [
      lower.includes("alpha") || lower.includes("value") || lower.includes("what") ? 1 : 0.1,
      lower.includes("2") ? 0.52 : lower.includes("1") ? 0.5 : 0.51,
      0.5,
      0.2,
    ];
  };
  const fakeEmbedder = {
    indexId: "fake-4d@v1",
    model: "fake-4d",
    profile: "bge-en",
    embed: async (inputs: string[]) => inputs.map(embedText),
    embedDocuments: async (inputs: string[]) => inputs.map(embedText),
    embedQueries: async (inputs: string[]) => inputs.map(embedText),
  };

  for (const [label, backend, embedder] of [
    ["lexical", lexicalBackend, undefined],
    ["hybrid", hybridBackend, fakeEmbedder],
  ] as const) {
    const ticks = [
      "2026-11-23T15:00:00.000Z",
      "2026-11-23T15:00:00.000Z",
      "2026-11-23T15:00:05.000Z",
    ];
    let idx = 0;
    const service = new HttpMemoryService(
      new MemoryEngine(backend, () => ticks[Math.min(idx++, ticks.length - 1)]!),
      embedder,
    );
    await service.rememberBatch("u1", "s1", "req-1", [
      { role: "user", content: "Project config value A is 1.", source_message_id: "0" },
    ]);
    const first = await service.searchFeature("What is value A?", 5);
    assert.match(first.results[0]!.memory.statement, /value A is 1/, `${label} step 1`);

    await service.rememberBatch("u1", "s1", "req-2", [
      { role: "user", content: "Project config value A is 2.", source_message_id: "1" },
    ]);
    const second = await service.searchFeature("What is value A?", 5);
    assert.match(second.results[0]!.memory.statement, /value A is 2/, `${label} step 2`);
    assert.match(second.results[1]!.memory.statement, /value A is 1/, `${label} keeps prior`);

    // Future eventTime / chat_time (e.g. client clock ahead or synthetic benchmark dates) must remain visible.
    await service.rememberBatch("u1", "s1", "req-future", [
      {
        role: "user",
        content: "Planned future event scheduled on Mars.",
        chat_time: "2035-06-15T12:00:00.000Z",
        source_message_id: "2",
      },
    ]);
    const futureRes = await service.searchFeature("scheduled on Mars", 5);
    assert.match(futureRes.results[0]!.memory.statement, /scheduled on Mars/, `${label} future`);
  }
});

test("HTTP config overrides explicit preview budget and preprocesses forget_directive / recall_trigger", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-http-preprocess-"));
  const cfg = parseLocalMemoryHttpConfig(
    {
      databasePath: "./http.sqlite",
      searchPreviewCodePoints: 0,
      searchMaxCharacters: 32000,
      preprocessMessages: true,
    },
    join(dir, "nmg-http.json"),
  );
  assert.equal(cfg.searchPreviewCodePoints, 0);
  assert.equal(cfg.searchMaxCharacters, 32000);
  assert.equal(cfg.preprocessMessages, true);

  const backend = await openMemoryBackend({
    kind: "sqlite",
    path: join(dir, "http.sqlite"),
    namespace: "preprocess-test",
  });
  t.after(async () => {
    await backend.close();
    removeTempDirectory(dir);
  });

  const service = new HttpMemoryService(
    new MemoryEngine(backend, () => "2026-11-23T16:00:00.000Z"),
    undefined,
    { preprocessMessages: true },
  );
  const longPref =
    "Congratulations on your promotion! " +
    "You have been working toward this leadership role for months. ".repeat(5) +
    "By the way, I love dark roast espresso and I prefer morning standups with monthly income now at 23000 yuan.";

  await service.rememberBatch("u1", "s1", "req-prep", [
    { role: "user", content: longPref, source_message_id: "0" },
    {
      role: "user",
      content: "Please forget about my preference for spicy ramen.",
      source_message_id: "1",
    },
  ]);

  const prefSearch = await service.searchFeature("monthly income 23000", 5);
  assert.equal(prefSearch.results[0]!.memory.memoryType, "preference");
  assert.ok(
    prefSearch.results[0]!.memory.markers.some(
      (m) => m.kind === "recall_trigger" && m.attributes?.value === "dark roast espresso",
    ),
  );
  const defaultRendered = renderSearchSurface(
    fitExplicitSearchPage(prefSearch, {
      query: "monthly income 23000",
      limit: 5,
      persistTrace: false,
    }),
  );
  assert.equal(defaultRendered.includes("23000 yuan"), false);
  const unclippedRendered = renderSearchSurface(
    fitExplicitSearchPage(
      prefSearch,
      { query: "monthly income 23000", limit: 5, persistTrace: false },
      { maxCharacters: cfg.searchMaxCharacters, previewCodePoints: cfg.searchPreviewCodePoints },
    ),
  );
  assert.equal(unclippedRendered.includes("23000 yuan"), true);

  const forgetSearch = await service.searchFeature("spicy ramen", 5);
  assert.equal(forgetSearch.results[0]!.memory.memoryType, "constraint");
  assert.ok(
    forgetSearch.results[0]!.memory.markers.some(
      (m) =>
        m.kind === "forget_directive" &&
        m.attributes?.topic === "preference for spicy ramen" &&
        m.attributes?.raw_topic === "my preference for spicy ramen",
    ),
  );
});

test("HTTP profile HEAD resolves git-diff tombstones, overwrites, and uncertain cross-session dates", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-http-profile-"));
  const backend = await openMemoryBackend({
    kind: "sqlite",
    path: join(dir, "profile.sqlite"),
    namespace: "profile-test",
  });
  t.after(async () => {
    await backend.close();
    removeTempDirectory(dir);
  });

  const service = new HttpMemoryService(
    new MemoryEngine(backend, () => "2026-11-23T17:00:00.000Z"),
    undefined,
    { preprocessMessages: true },
  );

  // 1. Preference A -> forget(A) with no replacement: A suppressed, tombstone shown with date.
  // 2. forget(chess) -> later preference B on chess: tombstone suppressed, only B shown.
  // 3. Explicit replacement: Italian food suppressed, Japanese ramen shown.
  // 4. Uncertain cross-session preferences: both kept with dates.
  await service.rememberBatch("u1", "s1", "req-p1", [
    {
      role: "user",
      content: "I enjoy modern electronic music festivals.",
      chat_time: "2025-01-10T10:00:00.000Z",
      source_message_id: "0",
    },
    {
      role: "user",
      content: "Please forget that I play chess with friends.",
      chat_time: "2025-01-12T10:00:00.000Z",
      source_message_id: "1",
    },
    {
      role: "user",
      content: "I really love Italian food and pasta.",
      chat_time: "2025-02-01T10:00:00.000Z",
      source_message_id: "2",
    },
    {
      role: "user",
      content: "I love spicy Sichuan hotpot on cold evenings.",
      chat_time: "2025-02-10T10:00:00.000Z",
      source_message_id: "3",
    },
    {
      role: "user",
      content: "I love Caesar salads for weekday lunches.",
      chat_time: "2025-02-12T10:00:00.000Z",
      source_message_id: "4",
    },
  ]);

  await service.rememberBatch("u1", "s2", "req-p2", [
    {
      role: "user",
      content: "Please forget that I enjoy modern electronic music festivals.",
      chat_time: "2025-03-01T10:00:00.000Z",
      source_message_id: "0",
    },
    {
      role: "user",
      content: "I started again and I enjoy playing chess with friends on Sundays.",
      chat_time: "2025-04-01T10:00:00.000Z",
      source_message_id: "1",
    },
    {
      role: "user",
      content: "Instead of Italian food, I now prefer Japanese ramen.",
      chat_time: "2025-05-01T10:00:00.000Z",
      source_message_id: "2",
    },
    {
      role: "user",
      content: "I enjoy light salads for quick lunches.",
      chat_time: "2025-06-15T10:00:00.000Z",
      source_message_id: "3",
    },
  ]);

  const summary = await service.profileSummary(
    "Recommend electronic music festivals, chess, Japanese ramen, Sichuan hotpot, or salads",
    "2026-11-23T17:00:00.000Z",
  );
  assert.equal(
    summary.includes("[forget_directive] modern electronic music festivals (2025-03-01)"),
    true,
  );
  assert.equal(summary.includes("I enjoy modern electronic music festivals."), false);
  assert.equal(summary.includes("play chess with friends (2025-01-12)"), false);
  assert.equal(
    summary.includes(
      "[preference][new] I started again and I enjoy playing chess with friends on Sundays. (2025-04-01)",
    ),
    true,
  );
  assert.equal(summary.includes("I really love Italian food and pasta."), false);
  assert.equal(
    summary.includes(
      "[preference][new] Instead of Italian food, I now prefer Japanese ramen. (2025-05-01)",
    ),
    true,
  );
  assert.equal(
    summary.includes("[preference] I love spicy Sichuan hotpot on cold evenings. (2025-02-10)"),
    true,
  );
  assert.equal(
    summary.includes("[preference] I love Caesar salads for weekday lunches. (2025-02-12)"),
    true,
  );
  assert.equal(
    summary.includes("[preference][new] I enjoy light salads for quick lunches. (2025-06-15)"),
    true,
  );
  assert.equal(
    await service.profileSummary("quantum computing hardware", "2026-11-23T17:00:00.000Z"),
    "",
  );

  const view = await backend.openRead();
  try {
    const page = backend.projectMemories!(view, {
      now: "2026-11-23T17:00:00.000Z",
      limit: 50,
      offset: 0,
    });
    const head = resolveHttpProfileHead(page.memories);
    assert.equal(head.length, 6);
  } finally {
    await backend.closeRead(view);
  }
});
