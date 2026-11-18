import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
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

test("SQLite upgrades existing text indexes and replaces both projections at their original rowids", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-sqlite-fts-keys-"));
  t.after(() => removeTempDirectory(directory));
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
  raw.exec("DROP TABLE IF EXISTS nmg_memory_fts_rows");
  const projections = ["nmg_memory_fts", "nmg_memory_tessera_fts"];
  const before = projections.map((table) => raw.prepare(`SELECT rowid, key FROM ${table}`).get());
  const reopened = await openMemoryBackend(options);
  try {
    assert.equal(raw.prepare("SELECT count(*) AS count FROM nmg_memory_fts_rows").get()?.count, 2);
    const view = await reopened.openRead();
    const [tessera] = await reopened.scan(view, { kind: "tessera" });
    await reopened.closeRead(view);
    assert.equal(tessera?.kind, "tessera");
    if (tessera?.kind !== "tessera") throw Error("Tessera missing");
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
    for (const [index, table] of projections.entries()) {
      assert.deepEqual(raw.prepare(`SELECT rowid, key FROM ${table}`).all(), [before[index]]);
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
    raw.close();
  }
});
