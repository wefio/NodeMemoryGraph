import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { FunctionOptions, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { openMemoryBackend } from "../../src/core/memory/open.ts";
import type { MemoryCommitRequest, MemoryEntity } from "../../src/core/memory/backend.ts";
import { MemoryEngine } from "../../src/core/memory/engine.ts";
import { buildMemoryQueryFilter } from "../../src/core/memory/sqlite-relational.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

const node = (id: string, name: string): MemoryEntity => ({
  kind: "node",
  value: {
    id,
    canonicalName: name,
    summary: name,
    kind: "topic",
    createdAt: "2026-11-05T00:00:00Z",
    updatedAt: "2026-11-05T00:00:00Z",
    status: "active",
    residence: "ltg",
  },
});

for (const kind of ["sqlite", "lancedb"] as const) {
  test(`${kind}: atomic revisions, replay, concurrency, namespaces and read lifetimes`, async () => {
    const directory = mkdtempSync(join(tmpdir(), `nmg-${kind}-`));
    const options =
      kind === "sqlite"
        ? ({ kind, path: join(directory, "memory.sqlite"), namespace: "tenant-a" } as const)
        : ({ kind, uri: join(directory, "objects"), namespace: "tenant-a" } as const);
    const backend = await openMemoryBackend(options);
    const rival = await openMemoryBackend(options);
    const isolated = await openMemoryBackend({ ...options, namespace: "tenant-b" });
    const initial = await backend.openRead();
    try {
      const request: MemoryCommitRequest = {
        operationId: "first",
        requestHash: "content-one",
        expectedRevision: 0,
        changes: { upsert: [node("a", "Atlas")] },
        resultIds: ["a"],
      };
      assert.equal((await backend.commit(request)).status, "committed");
      assert.equal((await backend.commit(request)).status, "replayed");
      await assert.rejects(
        backend.commit({ ...request, requestHash: "different" }),
        /different content/,
      );
      assert.deepEqual(await backend.scan(initial, { kind: "node" }), []);
      const concurrent = await Promise.all([
        backend.commit({
          ...request,
          operationId: "left",
          expectedRevision: 1,
          changes: { upsert: [node("b", "Left")] },
        }),
        rival.commit({
          ...request,
          operationId: "right",
          expectedRevision: 1,
          changes: { upsert: [node("c", "Right")] },
        }),
      ]);
      assert.deepEqual(concurrent.map((outcome) => outcome.status).sort(), [
        "committed",
        "conflict",
      ]);
      const current = await backend.openRead();
      try {
        assert.equal(current.revision, 2);
        assert.equal((await backend.scan(current, { kind: "node" })).length, 2);
        await assert.rejects(isolated.scan(current, { kind: "node" }), /another backend/);
        await assert.rejects(backend.scan(current, { kind: "node", limit: 0 }), /Read limit/);
      } finally {
        await backend.closeRead(current);
      }
      const other = await isolated.openRead();
      try {
        assert.deepEqual(await isolated.scan(other, { kind: "node" }), []);
      } finally {
        await isolated.closeRead(other);
      }
      await backend.closeRead(initial);
      await assert.rejects(backend.scan(initial, { kind: "node" }), /closed/);
    } finally {
      await backend.close();
      await rival.close();
      await isolated.close();
    }
    const reopened = await openMemoryBackend(options);
    try {
      const view = await reopened.openRead();
      assert.equal(view.revision, 2);
      assert.equal((await reopened.scan(view, { kind: "node", nodeName: "ATLAS" })).length, 1);
      assert.equal((await reopened.receipt(view, "first"))?.resultIds[0], "a");
      await reopened.closeRead(view);
    } finally {
      await reopened.close();
      removeTempDirectory(directory);
    }
  });
}

test("SQLite write lookups constrain the indexed name or node and exact scope before sorting", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-sqlite-write-lookups-"));
  t.after(() => removeTempDirectory(directory));
  const path = join(directory, "memory.sqlite");
  const backend = await openMemoryBackend({ kind: "sqlite", path, namespace: "tenant" });
  await backend.close();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const scope = { project: "atlas" };
    for (const [filter, constrained, indexName] of [
      [{ exactText: "a new statement" }, "normalized_name", "nmg_memories_by_scope_name"],
      [{ nodeId: "node-1" }, "node_id", "nmg_memories_by_scope_node"],
    ] as const) {
      const where = buildMemoryQueryFilter("tenant", { scope, ...filter }, "m");
      const details = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT m.id FROM nmg_memories m
          WHERE ${where.sql} ORDER BY m.id LIMIT ? OFFSET ?`,
        )
        .all(...where.bind, 80, 0)
        .map(({ detail }) => detail)
        .join("\n");
      assert.match(
        details,
        new RegExp(`${indexName} \\(namespace=\\? AND scope=\\? AND ${constrained}=\\?\\)`),
      );
    }
  } finally {
    db.close();
  }
});

test("SQLite reads existing graph edges from both indexed endpoints in ID order", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-sqlite-edge-indexes-"));
  const path = join(directory, "memory.sqlite");
  const options = { kind: "sqlite", path, namespace: "tenant" } as const;
  const original = await openMemoryBackend(options);
  const engine = new MemoryEngine(original);
  const [hub, incoming, outgoing] = await engine.rememberMany([
    { statement: "Coriander identifies the hub", nodeName: "Hub" },
    { statement: "Velvet identifies the incoming node", nodeName: "Incoming" },
    { statement: "Turquoise identifies the outgoing node", nodeName: "Outgoing" },
  ]);
  const inbound = await engine.linkNodes({
    sourceNodeId: incoming!.node.id,
    targetNodeId: hub!.node.id,
    type: "related_to",
  });
  const outbound = await engine.linkNodes({
    sourceNodeId: hub!.node.id,
    targetNodeId: outgoing!.node.id,
    type: "related_to",
  });
  const view = await original.openRead();
  const revision = view.revision;
  await original.closeRead(view);
  const loop = { ...inbound, id: "imported-loop", sourceNodeId: hub!.node.id };
  assert.equal(
    (
      await original.commit({
        expectedRevision: revision,
        operationId: "import-directed-edges",
        requestHash: "test-edges",
        resultIds: [],
        changes: {
          upsert: [
            { kind: "edge", value: { ...inbound, direction: "source->target" } },
            { kind: "edge", value: loop },
          ],
        },
      })
    ).status,
    "committed",
  );
  await original.close();

  const raw = new DatabaseSync(path);
  try {
    raw.exec(
      "DROP INDEX IF EXISTS nmg_memory_relations_edge_source; DROP INDEX IF EXISTS nmg_memory_relations_edge_target",
    );
  } finally {
    raw.close();
  }
  const backend = await openMemoryBackend(options);
  t.after(async () => {
    await backend.close();
    removeTempDirectory(directory);
  });
  const prepare = DatabaseSync.prototype.prepare;
  let neighborSql = "";
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.includes("origin = 'node_edge'") && sql.includes("UNION ALL")) neighborSql = sql;
    return prepare.call(this, sql);
  });
  const query = { kind: "edge", connectedTo: hub!.node.id } as const;
  const snapshot = await backend.openRead();
  try {
    const ids = [inbound.id, outbound.id, loop.id].sort();
    assert.deepEqual(
      (await backend.scan(snapshot, query)).map(({ value }) => value.id),
      ids,
    );
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${neighborSql}`)
        .all("tenant", hub!.node.id, "tenant", hub!.node.id, hub!.node.id, 128, 0)
        .map(({ detail }) => detail)
        .join("\n");
      assert.match(plan, /nmg_memory_relations_edge_source \(namespace=\? AND source_id=\?\)/);
      assert.match(plan, /nmg_memory_relations_edge_target \(namespace=\? AND target_id=\?\)/);
    } finally {
      db.close();
    }
    const [edges, nodes] = await backend.scanBatch!(snapshot, [
      { ...query, limit: 1, offset: 1 },
      { kind: "node", ids: [hub!.node.id] },
    ]);
    assert.deepEqual(
      edges?.map(({ value }) => value.id),
      ids.slice(1, 2),
    );
    assert.equal(nodes?.[0]?.value.id, hub!.node.id);
  } finally {
    await backend.closeRead(snapshot);
  }
  const found = await new MemoryEngine(backend).search("coriander", { graphHops: 1, limit: 3 });
  assert.deepEqual(
    found.results.map(({ node }) => node.id),
    [hub!.node.id, outgoing!.node.id],
  );
});

test("SQLite makes both text indexes contentless and updates them at their original rowids", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-sqlite-fts-keys-"));
  const path = join(directory, "memory.sqlite");
  const options = { kind: "sqlite", path, namespace: "tenant" } as const;
  const first = await openMemoryBackend(options);
  const { memory } = await new MemoryEngine(first).remember({
    statement: "obsolete statement",
    nodeName: "Atlas",
    tesserae: [{ path: "atlas.md", snippet: "obsolete citation" }],
  });
  await first.close();

  const raw = new DatabaseSync(path);
  t.after(() => {
    raw.close();
    removeTempDirectory(directory);
  });
  const projections = ["nmg_memory_fts", "nmg_memory_tessera_fts"];
  for (const [index, table] of projections.entries()) {
    const kind = index === 0 ? "memory" : "tessera";
    const sourceTable = kind === "memory" ? "nmg_memories" : "nmg_tesserae";
    raw.exec(`DROP TABLE ${table};
      CREATE VIRTUAL TABLE ${table} USING fts5(namespace UNINDEXED, key UNINDEXED, text);
      INSERT INTO ${table}(rowid, namespace, key, text)
        SELECT 91, namespace, '${kind}:' || id, 'obsolete test projection'
        FROM ${sourceTable};`);
  }
  const before = raw
    .prepare("SELECT namespace, key, fts_rowid FROM nmg_memory_fts_rows ORDER BY key")
    .all()
    .map((row) => ({ ...row, fts_rowid: 91 }));
  raw.exec("DROP TABLE nmg_memory_fts_rows");

  // A duplicate legacy key fails partway through the second projection.
  raw.exec(`INSERT INTO nmg_memory_tessera_fts(rowid, namespace, key, text)
    SELECT 92, namespace, key, text FROM nmg_memory_tessera_fts WHERE rowid=91`);
  await assert.rejects(openMemoryBackend(options), /UNIQUE constraint failed/);
  for (const table of projections) {
    assert.equal(
      raw.prepare(`SELECT text FROM ${table} WHERE rowid=91`).get()?.text,
      "obsolete test projection",
    );
  }
  assert.equal(
    raw.prepare("SELECT 1 FROM sqlite_schema WHERE name='nmg_memory_fts_rows'").get(),
    undefined,
  );
  raw.exec("DELETE FROM nmg_memory_tessera_fts WHERE rowid=92");

  const reopened = await openMemoryBackend(options);
  try {
    const mapping = raw.prepare(
      "SELECT namespace, key, fts_rowid FROM nmg_memory_fts_rows ORDER BY key",
    );
    assert.deepEqual(
      mapping.all().map((row) => ({ ...row })),
      before,
    );
    for (const table of projections) {
      assert.deepEqual(
        raw
          .prepare(`SELECT rowid, text FROM ${table} WHERE text MATCH 'obsolete'`)
          .all()
          .map((row) => ({ ...row })),
        [{ rowid: 91, text: null }],
      );
      assert.equal(
        raw.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(`${table}_content`),
        undefined,
      );
    }
    const prepare = DatabaseSync.prototype.prepare;
    let searchPlan: unknown;
    t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (
        searchPlan === undefined &&
        sql.includes("nmg_memory_fts MATCH") &&
        sql.includes("CROSS JOIN nmg_memories")
      )
        searchPlan = prepare
          .call(this, `EXPLAIN QUERY PLAN ${sql}`)
          .get("tenant", '"obsolete"*', "tenant", "tenant", "", 100, 0)?.detail;
      return prepare.call(this, sql);
    });
    const view = await reopened.openRead();
    assert.equal(
      (await reopened.scan(view, { kind: "memory", text: "obsolete" }))[0]?.value.id,
      memory.id,
    );
    assert.match(String(searchPlan), /^SCAN f VIRTUAL TABLE INDEX/);
    const [[matched], [tessera]] = await reopened.scanBatch!(view, [
      { kind: "memory", text: "obsolete" },
      { kind: "tessera", text: "obsolete" },
    ]);
    await reopened.closeRead(view);
    assert.equal(matched?.value.id, memory.id);
    assert.ok(tessera?.kind === "tessera");
    const committed = await reopened.commit({
      expectedRevision: view.revision,
      operationId: "update",
      requestHash: "update",
      resultIds: [],
      changes: {
        upsert: [
          { kind: "memory", value: { ...memory, statement: "replacement statement" } },
          { kind: "tessera", value: { ...tessera.value, snippet: "replacement citation" } },
        ],
      },
    });
    assert.equal(committed.status, "committed");
    assert.deepEqual(
      mapping.all().map((row) => ({ ...row })),
      before,
    );
    for (const table of projections) {
      assert.deepEqual(
        raw
          .prepare(`SELECT rowid FROM ${table}`)
          .all()
          .map((row) => row.rowid),
        [91],
      );
      assert.equal(
        raw.prepare(`SELECT count(*) AS count FROM ${table} WHERE text MATCH 'obsolete'`).get()
          ?.count,
        0,
      );
      assert.equal(
        raw.prepare(`SELECT count(*) AS count FROM ${table} WHERE text MATCH 'replacement'`).get()
          ?.count,
        1,
      );
    }
  } finally {
    await reopened.close();
  }
});

test("SQLite batches write lookups and keeps earlier items visible inside the batch", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-sqlite-batched-writes-"));
  const path = join(directory, "memory.sqlite");
  const backend = await openMemoryBackend({
    kind: "sqlite",
    path,
    namespace: "tenant",
  });
  t.after(async () => {
    await backend.close();
    removeTempDirectory(directory);
  });
  const engine = new MemoryEngine(backend);
  const prepare = DatabaseSync.prototype.prepare;
  let selects = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (
      sql.includes("FROM nmg_memories") ||
      sql.includes("FROM nmg_nodes") ||
      sql.includes("FROM nmg_sources")
    )
      selects++;
    return prepare.call(this, sql);
  });
  const inputs = Array.from({ length: 32 }, (_, i) => ({
    statement: `Independent Atlas update ${i}`,
    nodeName: "Atlas",
    scope: { project: "atlas" },
  }));
  const results = await engine.rememberMany([...inputs, inputs[0]!], "import");
  assert.equal(new Set(results.map(({ node }) => node.id)).size, 1);
  assert.equal(new Set(results.map(({ memory }) => memory.id)).size, 32);
  assert.equal(results.at(-1)?.history.id, results[0]?.history.id);
  assert.ok(selects <= 4, `executed ${selects} planning queries`);

  const evidenceSource = {
    actor: "user",
    sourceMessageId: "legacy-source",
    content: "Old transcript",
  } as const;
  const original = await engine.remember({
    ...inputs[0]!,
    statement: "Use the original evidence",
    evidenceSource,
  });
  const raw = new DatabaseSync(path);
  try {
    raw.prepare("UPDATE nmg_sources SET ordinal=NULL WHERE id=?").run(original.history.id);
  } finally {
    raw.close();
  }
  const reused = await engine.remember({
    ...inputs[0]!,
    statement: "Reuse the original evidence",
    evidenceSource,
  });
  assert.equal(reused.history.id, original.history.id);
});

test("SQLite hybrid search restricts vector scoring to the named node and reads selected evidence", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-sqlite-rank-before-evidence-"));
  const path = join(directory, "memory.sqlite");
  const backend = await openMemoryBackend({ kind: "sqlite", path, namespace: "tenant" });
  t.after(async () => {
    await backend.close();
    removeTempDirectory(directory);
  });
  const engine = new MemoryEngine(backend);
  const records = await engine.rememberMany([
    { statement: "Atlas search first decision", nodeName: "Atlas" },
    { statement: "Atlas search second decision", nodeName: "Atlas" },
    { statement: "Atlas search unrelated node", nodeName: "Other" },
  ]);
  const [first, second] = records;
  assert.ok(first && second);
  assert.equal(first.node.id, second.node.id);
  backend.vectorIndex!.save(
    "model",
    records.map(({ memory }) => ({
      id: memory.id,
      statement: memory.statement,
      text: memory.statement,
    })),
    [
      [1, 0],
      [0, 1],
      [1, 0],
    ],
  );
  const load = backend.scan.bind(backend);
  const loaded: string[] = [];
  t.mock.method(backend, "scan", async (...args: Parameters<typeof load>) => {
    if (args[1].kind === "history") loaded.push(...(args[1].ids ?? []));
    return load(...args);
  });
  let evaluations = 0;
  const register: (
    this: DatabaseSync,
    name: string,
    options: FunctionOptions,
    callback: (value: SQLOutputValue) => SQLInputValue,
  ) => void = DatabaseSync.prototype.function;
  t.mock.method(
    DatabaseSync.prototype,
    "function",
    function (
      this: DatabaseSync,
      name: string,
      options: Parameters<typeof register>[1],
      callback: Parameters<typeof register>[2],
    ) {
      return register.call(this, name, options, (value) => {
        evaluations++;
        return callback(value);
      });
    },
  );
  const result = await engine.search(
    "Atlas search",
    { limit: 1, nodeName: "Atlas" },
    {
      indexId: "model",
      vector: [1, 0],
      mode: "hybrid",
    },
  );
  assert.deepEqual(
    result.results.map(({ memory }) => memory.id),
    [first.memory.id],
  );
  assert.equal(result.results[0]?.vectorScore, 1);
  assert.equal(result.results[0]?.routeScore, 0);
  assert.deepEqual(loaded, [first.history.id]);
  assert.equal(evaluations, 2);
});

test("SQLite neighborhood uses adjacent source ordinals and indexed graph edges", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-neighborhood-"));
  const path = join(directory, "memory.sqlite");
  const backend = await openMemoryBackend({
    kind: "sqlite",
    path,
    namespace: "tenant",
  });
  t.after(async () => {
    await backend.close();
    removeTempDirectory(directory);
  });
  const engine = new MemoryEngine(backend);
  const records = await engine.rememberMany([
    ...[
      ["1", "earlier"],
      ["2", "anchor"],
      ["3", "later"],
      ["5", "outside the adjacent window"],
    ].map(([sourceMessageId, statement]) => ({
      nodeName: statement!,
      statement: statement!,
      residence: "stg" as const,
      sessionId: "owner",
      evidenceSource: {
        sourceMessageId: sourceMessageId!,
        content: statement!,
        actor: "user" as const,
      },
    })),
    { nodeName: "Linked origin", statement: "Completed earlier change" },
    { nodeName: "Related", statement: "Linked verification result" },
  ]);
  const [previous, anchor, next, , graphAnchor, linked] = records;
  await engine.linkNodes({
    sourceNodeId: graphAnchor!.node.id,
    targetNodeId: linked!.node.id,
    type: "related_to",
  });
  assert.equal(
    await engine.searchNeighborhood(anchor!.memory.id, { sessionId: "foreign" }),
    undefined,
  );
  const prepare = DatabaseSync.prototype.prepare;
  let sourceSql = "";
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.startsWith("WITH wanted(ordinal, relation)")) sourceSql = sql;
    return prepare.call(this, sql);
  });
  const context = await engine.searchNeighborhood(anchor!.memory.id, {
    sessionId: "owner",
    limit: 3,
  });
  assert.deepEqual(
    context?.results.map(({ memory, neighborhood }) => [memory.id, neighborhood]),
    [
      [previous!.memory.id, "previous_turn"],
      [next!.memory.id, "next_turn"],
    ],
  );
  const inspector = new DatabaseSync(path, { readOnly: true });
  try {
    const plan = inspector
      .prepare(`EXPLAIN QUERY PLAN ${sourceSql}`)
      .all("1", "3", "tenant", "owner", "tenant", "{}", "owner", 6)
      .map(({ detail }) => detail)
      .join("\n");
    assert.match(
      plan,
      /nmg_sources_by_session_msg \(namespace=\? AND session_id=\? AND source_message_id=\?\)/u,
    );
    assert.match(
      plan,
      /nmg_memories_by_primary_evidence \(namespace=\? AND primary_evidence_id=\?\)/u,
    );
  } finally {
    inspector.close();
  }
  const graph = await engine.searchNeighborhood(graphAnchor!.memory.id, {});
  assert.equal(graph?.results[0]?.memory.id, linked!.memory.id);
  assert.equal(graph?.results[0]?.neighborhood, "graph");
  assert.equal(graph?.results[0]?.path?.[0]?.relationType, "related_to");
  const bounded = await engine.searchNeighborhood(anchor!.memory.id, {
    sessionId: "owner",
    limit: 1,
  });
  assert.deepEqual(
    bounded?.results.map(({ memory }) => memory.id),
    [previous!.memory.id],
  );
});

test("ordinary hybrid search can spend two tail slots on relevant adjacent source records", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-ranked-source-neighbors-"));
  const backend = await openMemoryBackend({
    kind: "sqlite",
    path: join(directory, "memory.sqlite"),
    namespace: "tenant",
  });
  t.after(async () => {
    await backend.close();
    removeTempDirectory(directory);
  });
  const engine = new MemoryEngine(backend);
  const turns = [
    "Quartz earlier " + "filler ".repeat(70),
    "Quartz",
    "Quartz later " + "filler ".repeat(70),
  ];
  const records = await engine.rememberMany([
    ...turns.map((statement, index) => ({
      statement,
      nodeName: `Source ${index}`,
      sessionId: "owner",
      residence: "stg" as const,
      evidenceSource: {
        actor: "user" as const,
        sourceMessageId: String(index + 1),
        content: statement,
      },
    })),
    ...Array.from({ length: 21 }, (_, index) => ({
      statement: `Quartz detail number ${index}`,
      nodeName: `Detail ${index}`,
    })),
  ]);
  backend.vectorIndex!.save(
    "test",
    records.map(({ memory }) => ({
      id: memory.id,
      statement: memory.statement,
      text: memory.statement,
    })),
    records.map((_, index) => (index === 1 ? [1, 0] : index < 3 ? [0, 1] : [0.8, 0.6])),
  );
  const options = { sessionId: "owner", limit: 20 };
  const semantic = { indexId: "test", vector: [1, 0], mode: "hybrid" as const };
  const baseline = await engine.search("quartz", options, semantic);
  assert.equal(baseline.results[0]?.memory.id, records[1]?.memory.id);
  const expanded = await engine.search(
    "quartz",
    { ...options, expandSourceContext: true },
    semantic,
  );
  assert.deepEqual(expanded.results.slice(0, 18), baseline.results.slice(0, 18));
  assert.deepEqual(
    expanded.results.slice(18).map(({ memory, neighborhood }) => [memory.id, neighborhood]),
    [
      [records[0]!.memory.id, "previous_turn"],
      [records[2]!.memory.id, "next_turn"],
    ],
  );
});

test("SQLite adjacent source neighbors fall back to session insertion order for non-numeric IDs", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-session-rowid-neighbors-"));
  const path = join(directory, "memory.sqlite");
  const backend = await openMemoryBackend({ kind: "sqlite", path, namespace: "tenant" });
  t.after(async () => {
    await backend.close();
    removeTempDirectory(directory);
  });
  const engine = new MemoryEngine(backend);
  const scope = { aml_user: "u1" };
  const addImported = (sessionId: string, sourceMessageId: string, statement: string) =>
    engine.remember({
      statement,
      nodeName: `AML session ${sessionId}`,
      memoryType: "event",
      scope,
      residence: "ltg",
      sessionId: null,
      importedEvidence: {
        role: "user",
        sessionId,
        sourceMessageId,
        sourceRef: sourceMessageId,
        content: statement,
      },
    });
  const chunk0 = await addImported("sample:0", "aml:hash0:0", "Earlier chunk zero turn");
  await addImported("sample:other", "aml:other:0", "Unrelated session turn between chunks");
  const chunk1 = await addImported("sample:0", "aml:hash1:0", "Anchor chunk one turn");
  const chunk2 = await addImported("sample:0", "aml:hash2:0", "Later chunk two turn");

  const prepare = DatabaseSync.prototype.prepare;
  let sessionSql = "";
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.startsWith("WITH anchor(rowid)")) sessionSql = sql;
    return prepare.call(this, sql);
  });

  const context = await engine.searchNeighborhood(chunk1.memory.id, { limit: 4 });
  assert.deepEqual(
    context?.results.map(({ memory, neighborhood }) => [memory.id, neighborhood]),
    [
      [chunk0.memory.id, "previous_turn"],
      [chunk2.memory.id, "next_turn"],
    ],
  );

  const inspector = new DatabaseSync(path, { readOnly: true });
  try {
    const plan = inspector
      .prepare(`EXPLAIN QUERY PLAN ${sessionSql}`)
      .all(
        "tenant",
        chunk1.history.id,
        "tenant",
        "sample:0",
        "tenant",
        "sample:0",
        "tenant",
        "tenant",
        '{"aml_user":"u1"}',
        "",
        8,
      )
      .map(({ detail }) => detail)
      .join("\n");
    assert.match(plan, /nmg_sources_by_session/u);
    assert.match(plan, /nmg_memories_by_primary_evidence/u);
  } finally {
    inspector.close();
  }
});

test("SQLite retains leaf memberships and expands same-source evidence without route vectors", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-structural-leaves-"));
  const path = join(directory, "memory.sqlite");
  const options = { kind: "sqlite", path, namespace: "tenant" } as const;
  const backend = await openMemoryBackend(options);
  const source = {
    actor: "user",
    sourceMessageId: "turn-42",
    content: "Original context",
  } as const;
  const scope = { project: "atlas" };
  const [seed, related, imported, outside] = await new MemoryEngine(backend).rememberMany([
    { statement: "Coriander decision", nodeName: "Atlas", scope, evidenceSource: source },
    { statement: "Serving temperatures", nodeName: "Atlas", scope, evidenceSource: source },
    { statement: "Storage instructions", nodeName: "Atlas", scope },
    { statement: "Other project details", nodeName: "Boreal", scope: { project: "boreal" } },
    { statement: "Coriander packaging", nodeName: "Atlas", scope },
  ]);
  assert.ok(seed && related && imported && outside);
  assert.equal(seed.history.id, related.history.id);
  await backend.close();

  const raw = new DatabaseSync(path);
  try {
    raw.exec(`CREATE TABLE nmg_memory_route_vectors (vector BLOB);
      INSERT INTO nmg_memory_route_vectors VALUES (zeroblob(12288));
      CREATE TABLE nmg_memory_route_members (namespace TEXT, memory_id TEXT, leaf_id TEXT);`);
    const insert = raw.prepare(
      "INSERT INTO nmg_memory_route_members VALUES ('tenant',?,'old-leaf')",
    );
    for (const row of [seed, imported, outside]) insert.run(row.memory.id);
  } finally {
    raw.close();
  }

  const reopened = await openMemoryBackend(options);
  t.after(async () => {
    await reopened.close();
    removeTempDirectory(directory);
  });
  const inspector = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(
      inspector.prepare("SELECT count(*) AS n FROM nmg_memory_leaf_members").get()?.n,
      3,
    );
    assert.deepEqual(
      inspector
        .prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'nmg_memory_route_%'")
        .all(),
      [],
    );
  } finally {
    inspector.close();
  }
  const engine = new MemoryEngine(reopened);
  const plain = await engine.search("coriander decision", { limit: 2 });
  assert.equal(plain.results.length, 2);
  assert.equal(plain.results[0]?.memory.id, seed.memory.id);
  assert.deepEqual(
    await engine.search("coriander decision", { expandLeafContext: true, limit: 2 }),
    plain,
  );
  const enriched = await engine.search("coriander decision", { expandLeafContext: true, limit: 8 });
  assert.deepEqual(enriched.results.slice(0, 2), plain.results);
  assert.deepEqual(
    new Set(enriched.results.slice(2).map(({ memory }) => memory.id)),
    new Set([related.memory.id, imported.memory.id]),
  );
  assert.ok(
    enriched.results
      .slice(2)
      .every((hit) => hit.recallReason === "leaf_context" && hit.vectorScore === 0),
  );
});

test("SQLite pages missing vectors in order, scopes previous turns, and saves only current rows", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-sqlite-vector-page-"));
  const path = join(directory, "memory.sqlite");
  const backend = await openMemoryBackend({ kind: "sqlite", path, namespace: "tenant" });
  t.after(async () => {
    await backend.close();
    removeTempDirectory(directory);
  });
  const engine = new MemoryEngine(backend, () => "2026-11-17T00:00:00.000Z");
  const inputs = [
    ["session-one", "1", "same-session previous turn"],
    ["session-other", "2", "unrelated turn"],
    ["session-one", "3", "the current turn"],
    ["session-one", "4", "the subsequent turn"],
  ] as const;
  const records = await engine.rememberMany(
    inputs.map(([sessionId, sourceMessageId, statement]) => ({
      nodeName: "Example",
      statement,
      sessionId,
      residence: "stg",
      evidenceSource: { actor: "user", sourceMessageId, content: statement },
    })),
    "source",
  );

  const index = backend.vectorIndex!;
  const prepare = DatabaseSync.prototype.prepare;
  let pendingSql = "";
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.startsWith("WITH") && sql.includes("previousTurn")) pendingSql = sql;
    return prepare.call(this, sql);
  });
  const first = index.pending("test", 2);
  const second = index.pending("test", 2, first.at(-1));
  const cursor = first.at(-1)!;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const details = db
      .prepare(`EXPLAIN QUERY PLAN ${pendingSql}`)
      .all("tenant", "test", cursor.createdAt, cursor.id, 2, "tenant", "test", cursor.createdAt, 2)
      .map(({ detail }) => detail)
      .join("\n");
    assert.match(
      details,
      /nmg_memories_by_embedding_order \(namespace=\? AND created_at=\? AND id>\?\)/,
    );
    assert.match(details, /SEARCH h USING INDEX/);
    assert.match(details, /nmg_sources_by_session_ord/);
  } finally {
    db.close();
  }
  assert.deepEqual(
    [...first, ...second].map(({ id }) => id),
    records.map(({ memory }) => memory.id).sort(),
  );
  assert.deepEqual(index.pending("test", 2, second.at(-1)), []);
  const current = [...first, ...second].find(({ id }) => id === records[2]!.memory.id)!;
  assert.match(current.text, /same-session previous turn/);
  const subsequent = [...first, ...second].find(({ id }) => id === records[3]!.memory.id)!;
  assert.match(subsequent.text, /the current turn/);

  const [withdrawn] = first;
  const sessionId = records.find(({ memory }) => memory.id === withdrawn!.id)!.memory.sessionId!;
  await engine.withdraw(withdrawn!.id, "withdraw", sessionId);
  index.save("test", first, [
    [1, 0],
    [1, 1],
  ]);
  assert.deepEqual(index.stats("test"), { indexed: 1, pending: 2 });
  assert.throws(() => index.save("test", second, [[1], [1]]), /dimensions differ/);
  index.save("test", second, [
    [0, 1],
    [1, 0],
  ]);
  assert.deepEqual(index.stats("test"), { indexed: 3, pending: 0 });
});

test("SQLite combines unicode61+Han-bigram lexical recall with contentless trigram verbatim recall", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-sqlite-two-route-fts-"));
  const path = join(directory, "memory.sqlite");
  const options = { kind: "sqlite", path, namespace: "tenant" } as const;
  const backend = await openMemoryBackend(options);
  const openBackends: Awaited<ReturnType<typeof openMemoryBackend>>[] = [backend];
  t.after(async () => {
    for (const item of openBackends) await item.close();
    removeTempDirectory(directory);
  });

  const engine = new MemoryEngine(backend, () => "2026-11-21T00:00:00.000Z");
  const phrase = await engine.remember({
    nodeName: "Architecture",
    statement: "我们设计了节点记忆图谱架构，支持增量检索与多跳推理",
  });
  const scattered = await engine.remember({
    nodeName: "Notes",
    statement: "记忆模块和图谱渲染器是两个独立的组件",
  });
  const ver123 = await engine.remember({
    nodeName: "Release",
    statement: "Release v1.2.3 fixed ERR_CONNECTION_REFUSED in src/core/memory/sqlite-backend.ts",
    tesserae: [{ path: "src/core/memory/sqlite-backend.ts", snippet: "two-route verbatim check" }],
  });
  const ver123Slash = await engine.remember({
    nodeName: "Release",
    statement: "Release v1/2/3 used another separator format",
  });
  const ver124 = await engine.remember({
    nodeName: "Release",
    statement: "Release v1.2.4 updated docs/notes and fulltextKnapsack logging",
  });
  const english = await engine.remember({
    nodeName: "Prose",
    statement: "Atlas project uses ordinary lexical prose",
  });

  // Main lexical route: 2-char Han bigram and ordinary English word recall.
  const twoCharHan = await engine.search("图谱");
  assert.deepEqual(
    twoCharHan.results.map(({ memory }) => memory.id).sort(),
    [phrase.memory.id, scattered.memory.id].sort(),
  );
  const englishHits = await engine.search("ordinary");
  assert.deepEqual(
    englishHits.results.map(({ memory }) => memory.id),
    [english.memory.id],
  );

  // Two-route Chinese phrase: 3-4 char Han query still recalls scattered bigrams via main route,
  // while the contiguous substring in `phrase` is boosted first by the trigram route.
  const hanPhraseHits = await engine.search("记忆图谱");
  assert.equal(hanPhraseHits.results[0]?.memory.id, phrase.memory.id);
  assert.ok(hanPhraseHits.results.some(({ memory }) => memory.id === scattered.memory.id));

  // Verbatim trigram route: punctuation-preserving version ranks ahead of slash variant,
  // file path resolves, and quoted mid-token substring rescues CamelCase compound.
  const versionHits = await engine.search("v1.2.3");
  assert.equal(versionHits.results[0]?.memory.id, ver123.memory.id);
  assert.ok(!versionHits.results.some(({ memory }) => memory.id === ver124.memory.id));
  assert.ok(versionHits.results.some(({ memory }) => memory.id === ver123Slash.memory.id));

  const pathHits = await engine.search("src/core/memory/sqlite-backend.ts");
  assert.equal(pathHits.results[0]?.memory.id, ver123.memory.id);

  const substringHits = await engine.search('"knapsack"');
  assert.deepEqual(
    substringHits.results.map(({ memory }) => memory.id),
    [ver124.memory.id],
  );

  // Hybrid candidate admission includes trigram-only verbatim hits with positive bm25.
  assert.ok(backend.vectorIndex);
  assert.ok(backend.hybridCandidates);
  const pending = backend.vectorIndex.pending("test", 10);
  backend.vectorIndex.save(
    "test",
    pending,
    pending.map(() => [1, 0]),
  );
  const view = await backend.openRead();
  try {
    const hybrid = backend.hybridCandidates(
      view,
      { kind: "memory", text: '"knapsack"', limit: 10 },
      { indexId: "test", mode: "hybrid", vector: [0, 1] },
    );
    assert.ok(hybrid.lexicalIds.includes(ver124.memory.id));
    const rescued = hybrid.candidates.find(({ entity }) => entity.value.id === ver124.memory.id);
    assert.ok(rescued && rescued.bm25 > 0);
  } finally {
    await backend.closeRead(view);
  }

  await backend.close();

  // Simulating an existing contentless-lexical DB without trigram surface tables:
  // reopening backfills both trigram tables without creating *_content shadow tables.
  const raw = new DatabaseSync(path);
  try {
    raw.exec(`DROP TABLE nmg_memory_surface_fts;
      DROP TABLE nmg_memory_tessera_surface_fts;`);
  } finally {
    raw.close();
  }

  const reopened = await openMemoryBackend(options);
  openBackends.push(reopened);
  const checkDb = new DatabaseSync(path, { readOnly: true });
  try {
    for (const table of ["nmg_memory_surface_fts", "nmg_memory_tessera_surface_fts"]) {
      const schemaSql = String(
        checkDb.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(table)?.sql ?? "",
      );
      assert.match(schemaSql, /contentless_delete\s*=\s*1/iu);
      assert.match(schemaSql, /tokenize\s*=\s*['"]?trigram/iu);
      assert.equal(
        checkDb.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(`${table}_content`),
        undefined,
      );
    }
    assert.equal(
      checkDb
        .prepare("SELECT count(*) AS n FROM nmg_memory_tessera_surface_fts WHERE text MATCH ?")
        .get('"verbatim check"')?.n,
      1,
    );
  } finally {
    checkDb.close();
  }

  // Reopened engine finds backfilled memory rows via trigram and updates both indexes in sync.
  const reopenedEngine = new MemoryEngine(reopened, () => "2026-11-21T01:00:00.000Z");
  const backfilled = await reopenedEngine.search('"knapsack"');
  assert.deepEqual(
    backfilled.results.map(({ memory }) => memory.id),
    [ver124.memory.id],
  );

  const readView = await reopened.openRead();
  await reopened.closeRead(readView);
  const updated = await reopened.commit({
    expectedRevision: readView.revision,
    operationId: "trigram-update",
    requestHash: "trigram-update",
    resultIds: [],
    changes: {
      upsert: [
        {
          kind: "memory",
          value: { ...ver124.memory, statement: "Release v1.2.4 moved to paretoOptimizerV2" },
        },
      ],
    },
  });
  assert.equal(updated.status, "committed");
  assert.deepEqual((await reopenedEngine.search('"knapsack"')).results, []);
  assert.deepEqual(
    (await reopenedEngine.search('"paretooptimizerv2"')).results.map(({ memory }) => memory.id),
    [ver124.memory.id],
  );
});

test("SQLite upgrades to porter unicode61, CJK bigrams, and BM25F multi-column weights", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-sqlite-bm25f-porter-cjk-"));
  const path = join(directory, "memory.sqlite");
  const options = { kind: "sqlite", path, namespace: "tenant" } as const;
  const backend = await openMemoryBackend(options);
  const openBackends: Awaited<ReturnType<typeof openMemoryBackend>>[] = [backend];
  t.after(async () => {
    for (const item of openBackends) await item.close();
    removeTempDirectory(directory);
  });

  const engine = new MemoryEngine(backend, () => "2026-11-22T00:00:00.000Z");

  // 1) Porter stemming (lexical + hybrid) & CJK bigrams (Japanese kana + Korean Hangul)
  const stemDoc = await engine.remember({
    nodeName: "Hobby",
    statement: "Alice was painting pottery and volunteering on weekends",
  });
  const jaDoc = await engine.remember({
    nodeName: "Japanese",
    statement: "ローカル記憶データベースとベクトル検索エンジンを構築した",
  });
  const koDoc = await engine.remember({
    nodeName: "Korean",
    statement: "로컬데이터베이스마이그레이션을단일트랜잭션으로실행했다",
  });

  assert.equal((await engine.search("paint")).results[0]?.memory.id, stemDoc.memory.id);
  assert.equal((await engine.search("volunteer")).results[0]?.memory.id, stemDoc.memory.id);
  assert.equal((await engine.search("データベース")).results[0]?.memory.id, jaDoc.memory.id);
  assert.equal((await engine.search("마이그레이션")).results[0]?.memory.id, koDoc.memory.id);

  // Hybrid search also admits Porter-stemmed lexical hits with positive bm25
  assert.ok(backend.vectorIndex);
  assert.ok(backend.hybridCandidates);
  const pending = backend.vectorIndex.pending("test", 10);
  backend.vectorIndex.save(
    "test",
    pending,
    pending.map(() => [1, 0]),
  );
  const view = await backend.openRead();
  try {
    const hybrid = backend.hybridCandidates(
      view,
      { kind: "memory", text: "paint", limit: 10 },
      { indexId: "test", mode: "hybrid", vector: [0, 1] },
    );
    const stemHybrid = hybrid.candidates.find(
      ({ entity }) => entity.value.id === stemDoc.memory.id,
    );
    assert.ok(stemHybrid && stemHybrid.bm25 > 0);
  } finally {
    await backend.closeRead(view);
  }

  // 2) BM25F column weights: recall_triggers > statement, and tessera path/label > snippet
  const bodyOnly = await engine.remember({
    nodeName: "Cache",
    statement: "General note mentioning sentinel cache policy details",
  });
  const triggerBoosted = await engine.remember({
    nodeName: "Cache",
    statement: "General note mentioning sentinel routing rules details",
    recallTriggers: ["sentinel", "quorum"],
  });
  // Populate enough rows for stable non-degenerate BM25 IDF across memories and tesserae
  for (let i = 0; i < 8; i += 1) {
    await engine.remember({
      nodeName: "Filler",
      statement: `Background maintenance record number ${i} without query terms`,
      tesserae: [
        {
          path: `docs/filler-${i}.md`,
          label: `Filler ${i}`,
          snippet: `Unrelated filler body ${i}`,
        },
      ],
    });
  }
  const tesseraSnippetOnly = await engine.remember({
    nodeName: "Docs",
    statement: "Meeting minutes",
    tesserae: [
      {
        path: "docs/notes.md",
        label: "Weekly sync",
        snippet: "Long notes mentioning anchorpath twice: anchorpath in plain excerpt text",
      },
    ],
  });
  const tesseraPathHit = await engine.remember({
    nodeName: "Code",
    statement: "Storage module",
    tesserae: [
      {
        path: "src/anchorpath/engine.ts",
        label: "anchorpath implementation",
        snippet: "Core storage implementation",
      },
    ],
  });

  const triggerOnlyHits = await engine.search("quorum");
  assert.equal(triggerOnlyHits.results[0]?.memory.id, triggerBoosted.memory.id);
  const triggerWeightedHits = await engine.search("sentinel");
  assert.equal(triggerWeightedHits.results[0]?.memory.id, triggerBoosted.memory.id);
  assert.ok(triggerWeightedHits.results.some(({ memory }) => memory.id === bodyOnly.memory.id));

  const tesseraIdOf = (record: Awaited<ReturnType<typeof engine.remember>>) =>
    String(
      record.memory.markers.find((marker) => marker.kind === "tessera_ref")?.attributes?.tesseraId,
    );

  const readTessera = await backend.openRead();
  try {
    const tesseraHits = await backend.scan(readTessera, { kind: "tessera", text: "anchorpath" });
    assert.equal(tesseraHits[0]?.value.id, tesseraIdOf(tesseraPathHit));
    assert.ok(tesseraHits.some(({ value }) => value.id === tesseraIdOf(tesseraSnippetOnly)));
  } finally {
    await backend.closeRead(readTessera);
  }

  await backend.close();

  // 3) Upgrade migration from single-column contentless unicode61 DB preserving nmg_memory_fts_rows
  const raw = new DatabaseSync(path);
  let savedRowids: unknown;
  try {
    savedRowids = raw
      .prepare("SELECT namespace, key, fts_rowid FROM nmg_memory_fts_rows ORDER BY key")
      .all()
      .map((row) => ({ ...row }));
    raw.exec(`
      DROP TABLE nmg_memory_fts;
      CREATE VIRTUAL TABLE nmg_memory_fts
        USING fts5(text, content='', contentless_delete=1, tokenize='unicode61');
      DROP TABLE nmg_memory_tessera_fts;
      CREATE VIRTUAL TABLE nmg_memory_tessera_fts
        USING fts5(text, content='', contentless_delete=1, tokenize='unicode61');
    `);
  } finally {
    raw.close();
  }

  const upgraded = await openMemoryBackend(options);
  openBackends.push(upgraded);
  const inspect = new DatabaseSync(path, { readOnly: true });
  try {
    for (const [table, expectedCol, expectedRank] of [
      ["nmg_memory_fts", "dates", "bm25(1.0, 1.5, 1.0)"],
      ["nmg_memory_tessera_fts", "label", "bm25(1.0, 2.5, 1.8)"],
    ] as const) {
      const schemaSql = String(
        inspect.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(table)?.sql ?? "",
      );
      assert.match(schemaSql, /contentless_delete\s*=\s*1/iu);
      assert.match(schemaSql, /tokenize\s*=\s*['"]?porter\s+unicode61/iu);
      assert.match(schemaSql, new RegExp(`\\b${expectedCol}\\b`, "iu"));
      assert.equal(
        inspect.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(`${table}_content`),
        undefined,
      );
      assert.equal(
        inspect.prepare(`SELECT v FROM ${table}_config WHERE k = 'rank'`).get()?.v,
        expectedRank,
      );
    }
    assert.deepEqual(
      inspect
        .prepare("SELECT namespace, key, fts_rowid FROM nmg_memory_fts_rows ORDER BY key")
        .all()
        .map((row) => ({ ...row })),
      savedRowids,
    );
  } finally {
    inspect.close();
  }

  const upgradedEngine = new MemoryEngine(upgraded, () => "2026-11-22T01:00:00.000Z");
  assert.equal((await upgradedEngine.search("paint")).results[0]?.memory.id, stemDoc.memory.id);
  assert.equal(
    (await upgradedEngine.search("quorum")).results[0]?.memory.id,
    triggerBoosted.memory.id,
  );
  const upgradedView = await upgraded.openRead();
  try {
    const hits = await upgraded.scan(upgradedView, { kind: "tessera", text: "anchorpath" });
    assert.equal(hits[0]?.value.id, tesseraIdOf(tesseraPathHit));
  } finally {
    await upgraded.closeRead(upgradedView);
  }
});
