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
