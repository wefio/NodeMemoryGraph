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
import { sqliteQueryWhere } from "../../src/core/memory/entity-rows.ts";
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
    for (const [filter, constrained] of [
      [{ exactText: "a new statement" }, "name"],
      [{ nodeId: "node-1" }, "node"],
    ] as const) {
      const where = sqliteQueryWhere({ kind: "memory", scope, ...filter });
      const details = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT kind, payload FROM nmg_memory_entities
          WHERE namespace='tenant' AND ${where} ORDER BY id LIMIT ? OFFSET ?`,
        )
        .all(80, 0)
        .map(({ detail }) => detail)
        .join("\n");
      assert.match(
        details,
        new RegExp(`namespace=\\? AND kind=\\? AND ${constrained}=\\? AND scope=\\?`),
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
      "DROP INDEX IF EXISTS nmg_memory_edge_source; DROP INDEX IF EXISTS nmg_memory_edge_target",
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
    if (sql.startsWith("SELECT") && sql.includes("kind = 'edge'")) neighborSql = sql;
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
        .all(128, 0)
        .map(({ detail }) => detail)
        .join("\n");
      assert.match(plan, /nmg_memory_edge_source \(namespace=\? AND source=\?\)/);
      assert.match(plan, /nmg_memory_edge_target \(namespace=\? AND target=\?\)/);
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
    raw.exec(`DROP TABLE ${table};
      CREATE VIRTUAL TABLE ${table} USING fts5(namespace UNINDEXED, key UNINDEXED, text);
      INSERT INTO ${table}(rowid, namespace, key, text)
        SELECT 91, namespace, key, 'obsolete test projection'
        FROM nmg_memory_entities WHERE kind='${kind}';`);
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
        sql.startsWith("SELECT kind, payload") &&
        sql.includes("MATCH")
      )
        searchPlan = prepare.call(this, `EXPLAIN QUERY PLAN ${sql}`).get(128, 0)?.detail;
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
    if (sql.includes("SELECT kind, payload FROM nmg_memory_entities")) selects++;
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
    raw
      .prepare("UPDATE nmg_memory_entities SET name='' WHERE key=?")
      .run(`history:${original.history.id}`);
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
    assert.match(details, /nmg_memory_embedding_order \(namespace=\? AND <expr>=\? AND id>\?\)/);
    assert.match(details, /SEARCH h .* \(namespace=\? AND key=\?\)/);
    assert.match(details, /nmg_memory_history_sequence/);
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
