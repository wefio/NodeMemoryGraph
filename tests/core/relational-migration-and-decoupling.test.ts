import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openLocalMemory } from "../../src/cli/local-memory-migration.ts";
import {
  ComputeMemoCache,
  ComputeRegistry,
  INPUT_NODE_ID,
  evaluateSyncComputeGraph,
  executeComputeGraph,
  replaceGraphNode,
  type ComputeGraphSpec,
} from "../../src/core/compute-graph.ts";
import type { MemoryEntity } from "../../src/core/memory/backend.ts";
import { MemoryEngine } from "../../src/core/memory/engine.ts";
import { ENTITY_COLUMNS, entityRow, receiptRow } from "../../src/core/memory/entity-rows.ts";
import { openMemoryBackend } from "../../src/core/memory/open.ts";
import {
  createRetrievalAndProjectionGraph,
  runDecoupledRetrievalGraph,
} from "../../src/core/memory/retrieval-graph.ts";
import { SqliteMemoryBackend } from "../../src/core/memory/sqlite-backend.ts";
import type { MemoryRecord } from "../../src/core/types.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

function sampleFullMemory(id: string, evA: string, evB: string, relatedId: string): MemoryRecord {
  return {
    id,
    nodeId: "node-full",
    evidenceId: evA,
    evidenceIds: [evA, evB],
    statement: "Authoritative relational memory supports full round-trip.",
    memoryType: "constraint",
    stateKey: "deploy.policy",
    eventTime: "2026-08-15T12:30:00.000Z",
    sourceActor: "user",
    truthStatus: "verified",
    confidence: 0.92,
    polarity: "affirmative",
    predicateKey: "deploy_policy",
    extractMethod: "llm",
    claims: [
      {
        text: "Deployment stays immutable",
        polarity: "affirmative",
        predicateKey: "deploy_policy",
        confidence: 0.92,
        extractMethod: "llm",
      },
    ],
    markers: [
      { kind: "z_custom", attributes: { tag: "last-alpha-first-order" } },
      { kind: "recall_trigger", attributes: { trigger: "immutable rollout" } },
      { kind: "pinned" },
    ],
    scope: { service: "checkout", env: "prod" },
    validFrom: "2026-08-15T12:30:00.000Z",
    validUntil: "2027-08-15T12:30:00.000Z",
    status: "active",
    storageState: "quarantine",
    retentionChangedAt: "2026-09-01T00:00:00.000Z",
    quarantineUntil: "2026-10-01T00:00:00.000Z",
    resolution: "open",
    openedAt: "2026-08-16T08:00:00.000Z",
    relatedMemoryIds: [relatedId],
    residence: "stg",
    promotedAt: null,
    expiresAt: "2028-01-01T00:00:00.000Z",
    evidenceRole: "contradict",
    supersedesId: null,
    sessionId: "sess-alpha",
    sourceSessionId: "origin-sess-9",
    tier: 0,
    importance: 0.88,
    accessCount: 7,
    lastAccessedAt: "2026-09-02T10:00:00.000Z",
    writeReason: "explicit_operator_rule",
    writeSource: "user",
    createdAt: "2026-08-15T12:35:00.000Z",
  };
}

function seedEntityRowsInLegacyTable(
  db: DatabaseSync,
  namespace: string,
  entities: readonly MemoryEntity[],
): void {
  const tuple = `(${Array(ENTITY_COLUMNS.length + 1)
    .fill("?")
    .join(",")})`;
  const stmt = db.prepare(`INSERT INTO nmg_memory_entities VALUES ${tuple}`);
  for (const entity of entities) {
    const row = entityRow(entity);
    stmt.run(namespace, ...ENTITY_COLUMNS.map((col) => row[col]));
  }
  const receipt = receiptRow({
    operationId: "legacy-op-1",
    requestHash: "legacy-hash-1",
    revision: 1,
    resultIds: ["mem-leg-1"],
  });
  stmt.run(namespace, ...ENTITY_COLUMNS.map((col) => receipt[col]));
}

test("authoritative SQLite round-trips all fields losslessly without creating or querying nmg_memory_entities", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-v2-roundtrip-"));
  const dbPath = join(dir, "memory.sqlite");
  const backend = await openMemoryBackend({ kind: "sqlite", path: dbPath, namespace: "v2-rt" });
  t.after(async () => {
    await backend.close();
    removeTempDirectory(dir);
  });

  const evA: MemoryEntity = {
    kind: "history",
    value: {
      id: "hist-raw",
      sessionId: "origin-sess-9",
      sourceMessageId: "42",
      role: "user",
      content: "Raw user turn 42",
      sourceRef: "msg://42",
      createdAt: "2026-08-15T12:30:00.000Z",
    },
  };
  const evB: MemoryEntity = {
    kind: "history",
    value: {
      id: "hist-explicit",
      sessionId: null,
      sourceMessageId: null,
      role: "explicit",
      content: "Explicit note without transcript message ID",
      sourceRef: null,
      createdAt: "2026-08-15T12:31:00.000Z",
    },
  };
  const node: MemoryEntity = {
    kind: "node",
    value: {
      id: "node-full",
      canonicalName: "Deployment Policy",
      kind: "constraint",
      summary: "Production deployment constraints",
      createdAt: "2026-08-15T12:30:00.000Z",
      updatedAt: "2026-08-15T12:30:00.000Z",
      status: "active",
      residence: "ltg",
      unbound: false,
    },
  };
  const fullMemory = sampleFullMemory("mem-full", "hist-raw", "hist-explicit", "mem-rel-target");
  const peerMemory: MemoryEntity = {
    kind: "memory",
    value: {
      ...fullMemory,
      id: "mem-rel-target",
      statement: "Peer memory with null sourceSessionId",
      sourceSessionId: null,
      claims: null,
      markers: [],
      evidenceIds: ["hist-explicit"],
      evidenceId: "hist-explicit",
      relatedMemoryIds: [],
    },
  };
  delete peerMemory.value.storageState;
  delete peerMemory.value.retentionChangedAt;
  delete peerMemory.value.quarantineUntil;
  const tessera: MemoryEntity = {
    kind: "tessera",
    value: {
      id: "tes-1",
      path: "src/deploy.ts",
      snippet: "export const immutable = true;",
      label: "deploy flag",
      kind: "code",
      memoryId: "mem-full",
      createdAt: "2026-08-15T12:35:00.000Z",
      fileSimhash: "0123456789abcdef",
    },
  };

  const prepare = DatabaseSync.prototype.prepare;
  let touchedLegacyTable = false;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.includes("nmg_memory_entities")) touchedLegacyTable = true;
    return prepare.call(this, sql);
  });

  const outcome = await backend.commit({
    operationId: "rt-op-1",
    requestHash: "rt-hash-1",
    expectedRevision: 0,
    changes: {
      upsert: [evA, evB, node, { kind: "memory", value: fullMemory }, peerMemory, tessera],
    },
    audit: [
      {
        id: "we-1",
        memoryId: "mem-full",
        historyId: "hist-raw",
        sessionId: "sess-alpha",
        decision: "accepted",
        policyReason: "allowed",
        writeReason: "explicit_operator_rule",
        writeSource: "user",
        memoryType: "constraint",
        requestedResidence: "stg",
        createdAt: "2026-08-15T12:35:00.000Z",
      },
    ],
    resultIds: ["mem-full"],
    result: { ok: true },
  });
  assert.equal(outcome.status, "committed");

  const view = await backend.openRead();
  try {
    const [gotFull] = await backend.scan(view, {
      kind: "memory",
      ids: ["mem-full"],
      sessionId: "sess-alpha",
    });
    assert.deepEqual(gotFull, { kind: "memory", value: fullMemory });

    const [gotPeer] = await backend.scan(view, {
      kind: "memory",
      ids: ["mem-rel-target"],
      sessionId: "sess-alpha",
    });
    assert.deepEqual(gotPeer, peerMemory);
    assert.equal("storageState" in gotPeer!.value, false);
    assert.equal(gotPeer!.value.sourceSessionId, null);

    const [gotHistA, gotHistB] = [
      ...(await backend.scan(view, { kind: "history", ids: ["hist-raw"] })),
      ...(await backend.scan(view, { kind: "history", ids: ["hist-explicit"] })),
    ];
    assert.deepEqual(gotHistA, evA);
    assert.deepEqual(gotHistB, evB);

    const [gotNode] = await backend.scan(view, { kind: "node", ids: ["node-full"] });
    assert.deepEqual(gotNode, node);
    const [gotTes] = await backend.scan(view, { kind: "tessera", ids: ["tes-1"] });
    assert.deepEqual(gotTes, tessera);
    assert.deepEqual(await backend.receipt(view, "rt-op-1"), outcome.receipt);
  } finally {
    await backend.closeRead(view);
  }

  assert.equal(touchedLegacyTable, false);
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(
      raw.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='nmg_memory_entities'").get()
        ?.n,
      0,
    );
    assert.equal(
      raw.prepare("SELECT source_kind FROM nmg_sources WHERE id='hist-raw'").get()?.source_kind,
      "raw",
    );
    assert.equal(
      raw.prepare("SELECT source_kind FROM nmg_sources WHERE id='hist-explicit'").get()
        ?.source_kind,
      "explicit",
    );
  } finally {
    raw.close();
  }
});

test("v1 nmg_memory_entities migration rolls back on failure, recovers missing evidence conservatively, backs up via openLocalMemory, and retires legacy table idempotently", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-entity-migrate-"));
  const dbPath = join(dir, "legacy-v1.sqlite");
  t.after(() => removeTempDirectory(dir));

  const legacyEntities: MemoryEntity[] = [
    {
      kind: "history",
      value: {
        id: "hist-1",
        sessionId: "s-1",
        sourceMessageId: "1",
        role: "user",
        content: "Original verified transcript line",
        sourceRef: "s-1:1",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    },
    {
      kind: "node",
      value: {
        id: "node-1",
        canonicalName: "Service Mesh",
        kind: "topic",
        summary: "Mesh config",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        status: "active",
        residence: "ltg",
      },
    },
    {
      kind: "memory",
      value: {
        ...sampleFullMemory("mem-leg-1", "hist-1", "hist-missing-orphan", "mem-leg-1"),
        nodeId: "node-1",
        sessionId: null,
        storageState: undefined,
        relatedMemoryIds: [],
        markers: [{ kind: "recall_trigger", attributes: { trigger: "mesh timeout" } }],
      },
    },
  ];
  delete (legacyEntities[2]!.value as MemoryRecord).retentionChangedAt;
  delete (legacyEntities[2]!.value as MemoryRecord).quarantineUntil;

  const setup = new DatabaseSync(dbPath);
  try {
    setup.exec(`
      CREATE TABLE nmg_memory_head (namespace TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      INSERT INTO nmg_memory_head VALUES ('ns-v1', 1);
      CREATE TABLE nmg_local_memory (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        namespace TEXT NOT NULL
      );
      INSERT INTO nmg_local_memory VALUES (1, 'ns-v1');
      CREATE TABLE nmg_memory_entities (
        namespace TEXT NOT NULL, ${ENTITY_COLUMNS.map((c) => `${c} TEXT NOT NULL`).join(",")},
        PRIMARY KEY(namespace, key)
      );
      CREATE TABLE nmg_memories (namespace TEXT NOT NULL, id TEXT NOT NULL, statement TEXT NOT NULL, PRIMARY KEY(namespace, id));
      CREATE TABLE nmg_schema_migrations (
        namespace TEXT NOT NULL, version INTEGER NOT NULL, migrated_at TEXT NOT NULL, summary_json TEXT NOT NULL,
        PRIMARY KEY(namespace, version)
      );
      CREATE TRIGGER fail_v2_mig BEFORE INSERT ON nmg_schema_migrations
      BEGIN SELECT RAISE(ABORT, 'simulated_migration_crash'); END;
    `);
    seedEntityRowsInLegacyTable(setup, "ns-v1", legacyEntities);
  } finally {
    setup.close();
  }

  await assert.rejects(
    openMemoryBackend({ kind: "sqlite", path: dbPath, namespace: "ns-v1" }),
    /simulated_migration_crash/,
  );

  const afterFail = new DatabaseSync(dbPath);
  try {
    assert.equal(
      afterFail
        .prepare("SELECT count(*) AS n FROM nmg_memory_entities WHERE namespace='ns-v1'")
        .get()?.n,
      4,
    );
    afterFail.exec("DROP TRIGGER fail_v2_mig");
  } finally {
    afterFail.close();
  }

  const firstOpen = await openLocalMemory(dbPath, "ns-v1");
  try {
    assert.ok(firstOpen.backupPath && existsSync(firstOpen.backupPath));
    const engine = new MemoryEngine(firstOpen.backend);
    const got = await engine.get(["mem-leg-1"]);
    assert.equal(got.results.length, 1);
    assert.equal(got.results[0]!.memory.truthStatus, "verified");
    assert.equal(got.results[0]!.memory.extractMethod, "llm");
    assert.equal(got.results[0]!.evidenceRecords.length, 2);
  } finally {
    await firstOpen.backend.close();
  }

  const checkDb = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(
      checkDb
        .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='nmg_memory_entities'")
        .get()?.n,
      0,
    );
    assert.equal(
      checkDb.prepare("SELECT source_kind FROM nmg_sources WHERE id='hist-1'").get()?.source_kind,
      "raw",
    );
    const recovered = checkDb
      .prepare("SELECT source_kind, content FROM nmg_sources WHERE id='hist-missing-orphan'")
      .get();
    assert.equal(recovered?.source_kind, "missing_recovered");
    assert.equal(recovered?.content, "");
  } finally {
    checkDb.close();
  }

  // Reopening an already-migrated DB is a no-op with zero duplicate rows and no new backup.
  const secondOpen = new SqliteMemoryBackend(dbPath, "ns-v1");
  try {
    const view = await secondOpen.openRead();
    assert.deepEqual(await secondOpen.counts(view), { memories: 1, nodes: 1 });
    assert.ok(await secondOpen.receipt(view, "legacy-op-1"));
    await secondOpen.closeRead(view);
  } finally {
    await secondOpen.close();
  }
});

test("deletion, forget markers, and quarantine immediately purge FTS5/vectors, demote relations, and rebuild cleanly after index corruption", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-purge-rebuild-"));
  const dbPath = join(dir, "memory.sqlite");
  const backend = new SqliteMemoryBackend(dbPath, "purge-ns");
  t.after(async () => {
    await backend.close();
    removeTempDirectory(dir);
  });
  const engine = new MemoryEngine(backend, () => "2026-11-24T00:00:00.000Z");

  const longKeep =
    "Zirconium orchestrator stays active. " +
    "Detailed stable baseline configuration sentence. ".repeat(60);
  const longWithdraw =
    "Beryllium deprecated diagnostic string xyzzy-withdraw. " +
    "Withdrawn calibration phrase repeats in tail window. ".repeat(60);

  const [kept, withdrawn, quarantined, forgotten] = await engine.rememberMany([
    { statement: longKeep, tesserae: [{ path: "src/keep.ts", snippet: "zirconium config" }] },
    { statement: longWithdraw },
    { statement: "Osmium diagnostic record will enter quarantine." },
    { statement: "Ruthenium preference will receive forget marker." },
  ]);
  await engine.linkMemories({
    sourceMemoryId: kept!.memory.id,
    targetMemoryId: withdrawn!.memory.id,
    type: "related_to",
  });

  const pending = backend.vectorIndex.pending("vec-model", 32);
  assert.ok(pending.some((doc) => doc.chunkIndex !== undefined));
  backend.vectorIndex.save(
    "vec-model",
    pending,
    pending.map(() => [1, 0]),
  );

  await engine.withdraw(withdrawn!.memory.id);
  await engine.setStorageState(quarantined!.memory.id, "quarantine");
  const forgetView = await backend.openRead();
  const rev = forgetView.revision;
  await backend.closeRead(forgetView);
  await backend.commit({
    operationId: "mark-forget",
    requestHash: "mark-forget",
    expectedRevision: rev,
    changes: {
      upsert: [
        {
          kind: "memory",
          value: { ...forgotten!.memory, markers: [{ kind: "forget" }] },
        },
      ],
    },
    resultIds: [forgotten!.memory.id],
  });

  assert.equal((await engine.search("xyzzy-withdraw")).results.length, 0);
  assert.equal((await engine.search("Osmium diagnostic")).results.length, 0);
  assert.equal((await engine.search("Ruthenium preference")).results.length, 0);
  assert.equal((await engine.search("zirconium")).results.length, 1);

  const rawCheck = new DatabaseSync(dbPath, { readOnly: true });
  try {
    for (const removed of [withdrawn!.memory.id, quarantined!.memory.id, forgotten!.memory.id]) {
      assert.equal(
        rawCheck.prepare("SELECT count(*) AS n FROM nmg_memory_vectors WHERE id=?").get(removed)?.n,
        0,
      );
      assert.equal(
        rawCheck
          .prepare("SELECT count(*) AS n FROM nmg_memory_vector_chunks WHERE id=?")
          .get(removed)?.n,
        0,
      );
    }
    assert.equal(
      rawCheck
        .prepare("SELECT status FROM nmg_memory_relations WHERE source_id=? AND target_id=?")
        .get(kept!.memory.id, withdrawn!.memory.id)?.status,
      "demoted",
    );
  } finally {
    rawCheck.close();
  }

  // Corrupt derived FTS5 + insert stale orphan vector -> rebuildDerivedIndexes recovers completely.
  const corrupt = new DatabaseSync(dbPath);
  try {
    corrupt.exec(`
      DELETE FROM nmg_memory_fts_rows;
      DROP TABLE nmg_memory_fts;
      CREATE VIRTUAL TABLE nmg_memory_fts USING fts5(text, triggers, dates, content='', contentless_delete=1, tokenize='porter unicode61');
      INSERT INTO nmg_memory_vectors VALUES ('purge-ns', 'vec-model', '${withdrawn!.memory.id}', 2, zeroblob(8));
    `);
  } finally {
    corrupt.close();
  }
  assert.equal((await engine.search("zirconium")).results.length, 0);

  backend.rebuildDerivedIndexes();
  const recovered = await engine.search("zirconium", { findTesserae: true });
  assert.equal(recovered.results.length, 1);
  assert.equal(recovered.results[0]!.memory.id, kept!.memory.id);
  assert.equal(recovered.tesserae?.[0]?.path, "src/keep.ts");

  const afterRebuild = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(
      afterRebuild
        .prepare("SELECT count(*) AS n FROM nmg_memory_vectors WHERE id=?")
        .get(withdrawn!.memory.id)?.n,
      0,
    );
  } finally {
    afterRebuild.close();
  }
});

test("projectGraph tracks explicit vs inferred provenance and cross-page boundary relations", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nmg-graph-boundary-"));
  const backend = await openMemoryBackend({
    kind: "sqlite",
    path: join(dir, "memory.sqlite"),
    namespace: "boundary-ns",
  });
  t.after(async () => {
    await backend.close();
    removeTempDirectory(dir);
  });
  const engine = new MemoryEngine(backend, () => "2026-11-24T01:00:00.000Z");

  const first = await engine.remember({
    statement: "Day 1 API latency spiked",
    eventTime: "2026-10-01T10:00:00.000Z",
    predicateKey: "api_health",
    polarity: "negative",
    sessionId: null,
  });
  const second = await engine.remember({
    statement: "Day 2 API latency normalized",
    eventTime: "2026-10-02T10:00:00.000Z",
    predicateKey: "api_health",
    polarity: "affirmative",
    sessionId: null,
  });
  await engine.linkMemories({
    sourceMemoryId: first.memory.id,
    targetMemoryId: second.memory.id,
    type: "causes",
  });

  const page1 = await engine.projectGraph({
    dimensions: ["time", "memoryType"],
    limit: 1,
    offset: 0,
  });
  assert.equal(page1.memoryCount, 1);
  assert.equal(page1.page?.hasMore, true);
  assert.equal(page1.boundaryRelations.length, 1);
  assert.equal(page1.page?.truncatedRelationCount, 1);
  assert.equal(page1.boundaryRelations[0]!.externalId, first.memory.id);
  assert.equal(page1.boundaryRelations[0]!.relationType, "causes");

  const full = await engine.projectGraph({
    dimensions: ["time", "memoryType"],
    evidenceId: first.history.id,
    relationTypes: ["causes"],
    limit: 10,
  });
  assert.equal(full.memoryCount, 1);
  assert.equal(full.bindings[0]!.memoryId, first.memory.id);

  const both = await engine.projectGraph({
    dimensions: ["time"],
    limit: 10,
  });
  const explicit = both.edges.find((e) => e.relationType === "causes");
  const inferred = both.edges.find((e) => e.relationType === "contradicts");
  assert.equal(explicit?.authority, "explicit");
  assert.equal(inferred?.authority, "inferred");
  assert.equal(inferred?.provenance?.algorithm, "predicate_polarity_mismatch");
  assert.deepEqual(
    new Set(inferred?.provenance?.evidenceMemoryIds),
    new Set([first.memory.id, second.memory.id]),
  );
});

test("ComputeGraph prevents mutable memo corruption, isolates sideEffect nodes, runs async waves in parallel, and decouples retrieval from storage", async () => {
  // 1. Mutable array & object must NOT reuse stale ComputeMemoCache entries
  const reg = new ComputeRegistry<{ tag: string }>();
  let evals = 0;
  reg.register("sum", (inputs) => {
    evals += 1;
    const nums = inputs.default as number[];
    return nums.reduce((a, b) => a + b, 0);
  });
  const spec: ComputeGraphSpec = {
    id: "sum-graph",
    nodes: [{ id: "s", op: "sum" }],
    edges: [{ from: INPUT_NODE_ID, to: "s" }],
    output: "s",
  };
  const memo = new ComputeMemoCache();
  const mutableArr = [1, 2];
  assert.equal(evaluateSyncComputeGraph(spec, reg, mutableArr, { tag: "t" }, memo), 3);
  mutableArr.push(10);
  assert.equal(evaluateSyncComputeGraph(spec, reg, mutableArr, { tag: "t" }, memo), 13);
  assert.equal(evals, 2);

  // Frozen nested tuple hits memo cleanly
  const frozenArr = Object.freeze([5, 6]);
  assert.equal(evaluateSyncComputeGraph(spec, reg, frozenArr, { tag: "t" }, memo), 11);
  assert.equal(evaluateSyncComputeGraph(spec, reg, frozenArr, { tag: "t" }, memo), 11);
  assert.equal(evals, 3);

  // 2. sideEffect operator + downstream nodes never read/write stale cache
  let writes = 0;
  let downstreamRuns = 0;
  reg.register(
    "write_effect",
    () => {
      writes += 1;
      return `write-${writes}`;
    },
    { sideEffect: true },
  );
  reg.register("format_after_fx", (inputs) => {
    downstreamRuns += 1;
    return `after:${String(inputs.default)}`;
  });
  const fxSpec: ComputeGraphSpec = {
    id: "fx-chain",
    nodes: [
      { id: "w", op: "write_effect" },
      { id: "d", op: "format_after_fx" },
    ],
    edges: [
      { from: INPUT_NODE_ID, to: "w" },
      { from: "w", to: "d" },
    ],
    output: "d",
  };
  assert.equal(evaluateSyncComputeGraph(fxSpec, reg, "x", { tag: "t" }, memo), "after:write-1");
  assert.equal(evaluateSyncComputeGraph(fxSpec, reg, "x", { tag: "t" }, memo), "after:write-2");
  assert.equal(writes, 2);
  assert.equal(downstreamRuns, 2);

  // 3. Wave-parallel async decoupled retrieval + replaceable subgraph without any DB dependency
  const mem1 = sampleFullMemory("m1", "e1", "e1", "m2");
  const mem2 = {
    ...sampleFullMemory("m2", "e2", "e2", "m1"),
    statement: "Secondary turn on same topic",
  };
  let active = 0;
  let maxConcurrent = 0;
  const asyncWait = async () => {
    active += 1;
    maxConcurrent = Math.max(maxConcurrent, active);
    await new Promise((r) => setTimeout(r, 15));
    active -= 1;
  };
  const retrievalSpec = createRetrievalAndProjectionGraph({
    dimensions: ["memoryType", "stateKey"],
  });
  const out = await runDecoupledRetrievalGraph(
    { queryText: "immutable rollout", limit: 5 },
    {
      lexicalRecall: async () => {
        await asyncWait();
        return [{ memory: mem1, bm25: 5.0 }];
      },
      vectorRecall: async () => {
        await asyncWait();
        return [{ memory: mem2, vectorScore: 0.9 }];
      },
    },
    retrievalSpec,
  );
  assert.equal(maxConcurrent, 2);
  assert.equal(out.ranked.length, 2);
  assert.equal(out.projection.memoryCount, 2);

  const withoutRerank = replaceGraphNode(retrievalSpec, "rerank", {
    op: "piecewise_rerank",
    params: { enabled: false },
  });
  const outNoRerank = await runDecoupledRetrievalGraph(
    { queryText: "immutable rollout", limit: 5 },
    {
      lexicalRecall: async () => [{ memory: mem1, bm25: 5.0 }],
      vectorRecall: async () => [{ memory: mem2, vectorScore: 0.9 }],
    },
    withoutRerank,
  );
  assert.equal(outNoRerank.ranked.length, 2);
  assert.ok(typeof executeComputeGraph === "function");
});

test("storage SQLite modules and compute-graph/retrieval modules have zero cross-layer imports", async (t) => {
  const root = fileURLToPath(new URL("../../src/core/", import.meta.url));
  const memoryDir = join(root, "memory");
  const files = readdirSync(memoryDir);

  for (const file of files) {
    if (!file.startsWith("sqlite-") || !file.endsWith(".ts")) continue;
    const text = readFileSync(join(memoryDir, file), "utf8");
    for (const forbidden of [
      "compute-graph",
      "piecewise-rerank",
      "bm25f-neighborhoods",
      "graph-projection",
      "retrieval-graph",
    ]) {
      assert.equal(
        text.includes(forbidden),
        false,
        `${file} must not import compute/algorithm module '${forbidden}'`,
      );
    }
  }

  const algoFiles = [
    join(root, "compute-graph.ts"),
    join(memoryDir, "piecewise-rerank.ts"),
    join(memoryDir, "bm25f-neighborhoods.ts"),
    join(memoryDir, "graph-projection.ts"),
    join(memoryDir, "retrieval-graph.ts"),
  ];
  for (const filePath of algoFiles) {
    const text = readFileSync(filePath, "utf8");
    for (const forbidden of ["node:sqlite", "sqlite-", "entity-rows"]) {
      assert.equal(
        text.includes(forbidden),
        false,
        `${filePath} must not depend on storage module '${forbidden}'`,
      );
    }
  }

  // Delete/bypass graph reranking completely and confirm full lifecycle persistence works.
  const dir = mkdtempSync(join(tmpdir(), "nmg-no-graph-"));
  const dbPath = join(dir, "memory.sqlite");
  t.after(() => removeTempDirectory(dir));
  const first = await openMemoryBackend({ kind: "sqlite", path: dbPath, namespace: "solo" });
  const engine = new MemoryEngine(first);
  const saved = await engine.remember({ statement: "Pure storage survives without compute graph" });
  const searched = await engine.search("Pure storage", { rerankGraph: false });
  assert.equal(searched.results[0]?.memory.id, saved.memory.id);
  const exported = await engine.exportMemories();
  assert.equal(exported.items.length, 1);
  await first.close();

  const reopened = await openMemoryBackend({ kind: "sqlite", path: dbPath, namespace: "solo" });
  try {
    const got = await new MemoryEngine(reopened).get([saved.memory.id]);
    assert.equal(got.results[0]?.memory.statement, "Pure storage survives without compute graph");
  } finally {
    await reopened.close();
  }
});
