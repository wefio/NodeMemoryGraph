import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { NmgStore } from "../../../src/core/store.ts";
import { ensureBinaryVectors } from "../../../src/core/store/schema.ts";
import { encodeVector, storedVector } from "../../../src/core/store/vector-codec.ts";

const tables = ["memory_embeddings", "node_embeddings", "leaf_embeddings"] as const;
const ids = ["memory_id", "node_id", "block_id"] as const;

function withLegacyVectors(run: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE store_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    tables.forEach((table, index) => {
      db.exec(`CREATE TABLE ${table} (
        ${ids[index]} TEXT NOT NULL, model TEXT NOT NULL, dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (${ids[index]}, model))`);
      db.prepare(
        `INSERT INTO ${table} VALUES ('id', 'local', 3, '[0.1,0.2,0.3]', 'original')`,
      ).run();
      db.prepare(
        `INSERT INTO ${table} VALUES ('id', 'external', 2, '[1,0]', 'external-time')`,
      ).run();
    });
    run(db);
  } finally {
    db.close();
  }
}

function rows(db: DatabaseSync, table: string) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY model`).all();
}

class InspectableStore extends NmgStore {
  get database(): DatabaseSync {
    return this.db;
  }
}

test("vector migration keeps IDs, models, dimensions and timestamps while removing duplicate JSON", () => {
  withLegacyVectors((db) => {
    ensureBinaryVectors(db);
    tables.forEach((table, index) => {
      const records = rows(db, table);
      assert.equal(records.length, 2);
      for (const row of records) {
        assert.equal(row[ids[index]!], "id");
        assert.equal(row.vector_json, "[]");
        const external = row.model === "external";
        assert.equal(row.dimensions, external ? 2 : 3);
        assert.equal(row.updated_at, external ? "external-time" : "original");
        assert.deepEqual(
          Buffer.from(row.vector_blob as Uint8Array),
          encodeVector(external ? [1, 0] : [0.1, 0.2, 0.3]),
        );
      }
    });
    assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.equal(db.prepare("SELECT count(*) AS n FROM store_metadata").get()?.n, 1);
  });
});

test("vector migration preserves existing binary bytes and unverified legacy text", () => {
  withLegacyVectors((db) => {
    db.exec("ALTER TABLE memory_embeddings ADD COLUMN vector_blob BLOB");
    const blob = encodeVector([4, 5, 6]);
    db.prepare("UPDATE memory_embeddings SET vector_blob = ? WHERE model = 'local'").run(blob);
    db.exec("UPDATE memory_embeddings SET vector_json = 'not json' WHERE model = 'external'");
    ensureBinaryVectors(db);
    const [external, local] = rows(db, "memory_embeddings");
    assert.deepEqual(Buffer.from(local!.vector_blob as Uint8Array), blob);
    assert.equal(local!.vector_json, "[]");
    assert.equal(external!.vector_json, "not json");

    db.exec("DELETE FROM store_metadata");
    db.prepare(
      "UPDATE memory_embeddings SET vector_blob = ?, vector_json = '[9,9,9]' WHERE model = 'local'",
    ).run(Buffer.from([1, 2, 3]));
    ensureBinaryVectors(db);
    assert.equal(rows(db, "memory_embeddings")[1]!.vector_json, "[9,9,9]");
  });
});

test("a completed vector migration does not scan embedding tables again", (t) => {
  withLegacyVectors((db) => {
    ensureBinaryVectors(db);
    const prepare = db.prepare.bind(db);
    t.mock.method(db, "prepare", (sql: string) => {
      assert.doesNotMatch(sql, /(?:FROM|UPDATE|table_info\()\s*(?:memory|node|leaf)_embeddings/i);
      return prepare(sql);
    });
    ensureBinaryVectors(db);
  });
});

test("vector migration failure rolls back all tables, added columns and the version marker", () => {
  withLegacyVectors((db) => {
    const before = tables.map((table) => rows(db, table));
    db.exec(`CREATE TRIGGER reject_leaf_vector BEFORE UPDATE ON leaf_embeddings
      BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`);
    assert.throws(() => ensureBinaryVectors(db), /injected migration failure/);
    assert.deepEqual(
      tables.map((table) => rows(db, table)),
      before,
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM store_metadata").get()?.n, 0);
    db.exec("DROP TRIGGER reject_leaf_vector");
    ensureBinaryVectors(db);
    assert.equal(rows(db, "leaf_embeddings")[0]!.vector_json, "[]");
  });
});

test("vector migration participates in an existing transaction", () => {
  withLegacyVectors((db) => {
    db.exec("BEGIN");
    ensureBinaryVectors(db);
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT count(*) AS n FROM store_metadata").get()?.n, 0);
    assert.equal(rows(db, "memory_embeddings")[0]!.vector_json, "[1,0]");
  });
});

test("all embedding writers persist one binary payload and retain model-specific retrieval", () => {
  const store = new InspectableStore(":memory:");
  try {
    const saved = store.remember({ statement: "Automobile service", nodeName: "vehicle" });
    const [block] = store.rebuildLeafBlocks(saved.node.id, 16);
    assert.ok(block);
    store.upsertExternalNodeEmbeddings("test-external", [
      { nodeId: saved.node.id, vector: [1, 0] },
    ]);
    store.upsertExternalLeafEmbeddings("test-external", [{ blockId: block.id, vector: [1, 0] }]);
    store.upsertExternalEmbeddings("test-external", [
      { memoryId: saved.memory.id, vector: [1, 0] },
    ]);
    assert.equal(
      store.database
        .prepare(
          "SELECT vector_json FROM memory_embeddings WHERE memory_id = ? AND model <> 'test-external'",
        )
        .get(saved.memory.id)?.vector_json,
      "[]",
    );
    store.rebuildVectorIndex();
    for (const table of tables) {
      const records = rows(store.database, table);
      assert.ok(records.length > 0);
      for (const row of records) {
        assert.equal(row.vector_json, "[]");
        assert.equal((row.vector_blob as Uint8Array).length, Number(row.dimensions) * 4);
      }
    }
    assert.deepEqual(store.storedNodeEmbeddings("test-external")[0]?.vector, [1, 0]);
    assert.deepEqual(store.storedLeafEmbeddings("test-external")[0]?.vector, [1, 0]);
    assert.deepEqual(store.storedEmbeddings("test-external")[0]?.vector, [1, 0]);
    assert.equal(store.routeNodesByVector([1, 0], "test-external")[0]?.node.id, saved.node.id);
    assert.equal(store.routeLeafBlocksByVector([1, 0], "test-external")[0]?.block.id, block.id);
    const result = store.searchByVector("car", [1, 0], "test-external", {
      retrievalMode: "qwen3",
      maxTier: 3,
    });
    assert.equal(result[0]?.memory.id, saved.memory.id);
    assert.equal(result[0]?.vectorScore, 1);
    assert.deepEqual(
      store.searchByVector("car", [1, 0], "missing", { retrievalMode: "qwen3", maxTier: 3 }),
      [],
    );
  } finally {
    store.close();
  }
});

test("projected vector reads retain JSON-only rows without running a migration", (t) => {
  const store = new InspectableStore(":memory:");
  try {
    const saved = store.remember({ statement: "Automobile service", nodeName: "vehicle" });
    const [block] = store.rebuildLeafBlocks(saved.node.id, 16);
    assert.ok(block);
    store.upsertExternalNodeEmbeddings("legacy", [{ nodeId: saved.node.id, vector: [1, 0] }]);
    store.upsertExternalLeafEmbeddings("legacy", [{ blockId: block.id, vector: [1, 0] }]);
    store.upsertExternalEmbeddings("legacy", [{ memoryId: saved.memory.id, vector: [1, 0] }]);
    for (const table of tables) {
      store.database.exec(
        `UPDATE ${table} SET vector_blob = NULL, vector_json = '[1,0]' WHERE model = 'legacy'`,
      );
    }
    const prepare = store.database.prepare.bind(store.database);
    t.mock.method(store.database, "prepare", (sql: string) => {
      if (
        sql.includes("FROM memory_embeddings") ||
        sql.includes("FROM node_embeddings") ||
        sql.includes("FROM leaf_embeddings") ||
        sql.includes("h.content AS h_content")
      ) {
        assert.match(
          sql,
          /CASE WHEN typeof\([^)]*vector_blob\) = 'blob'.*vector_json END AS (?:ve_)?vector/,
        );
      }
      return prepare(sql);
    });
    assert.deepEqual(store.storedNodeEmbeddings("legacy")[0]?.vector, [1, 0]);
    assert.deepEqual(store.storedLeafEmbeddings("legacy")[0]?.vector, [1, 0]);
    assert.deepEqual(store.storedEmbeddings("legacy")[0]?.vector, [1, 0]);
    assert.equal(store.routeNodesByVector([1, 0], "legacy")[0]?.node.id, saved.node.id);
    assert.equal(store.routeLeafBlocksByVector([1, 0], "legacy")[0]?.block.id, block.id);
    const result = store.searchByVector("car", [1, 0], "legacy", {
      retrievalMode: "qwen3",
      maxTier: 3,
    });
    assert.equal(result[0]?.memory.id, saved.memory.id);
    assert.equal(result[0]?.vectorScore, 1);
    // SQLite's BLOB affinity still allows text. Preserve the legacy decoder's
    // fallback for a mistyped binary value, not just SQL NULL.
    for (const table of tables) {
      store.database.exec(
        `UPDATE ${table} SET vector_blob = 'invalid blob' WHERE model = 'legacy'`,
      );
    }
    assert.deepEqual(store.storedNodeEmbeddings("legacy")[0]?.vector, [1, 0]);
    assert.deepEqual(store.storedLeafEmbeddings("legacy")[0]?.vector, [1, 0]);
    assert.deepEqual(store.storedEmbeddings("legacy")[0]?.vector, [1, 0]);
    assert.equal(
      store.searchByVector("car", [1, 0], "legacy", { retrievalMode: "qwen3", maxTier: 3 })[0]
        ?.vectorScore,
      1,
    );
  } finally {
    store.close();
  }
});

test("FTS retrieval does not join or read embedding payloads", (t) => {
  const store = new InspectableStore(":memory:");
  try {
    const saved = store.remember({
      statement: "中文检索 retains punctuation /path/example",
      nodeName: "FTS",
    });
    const prepare = store.database.prepare.bind(store.database);
    let inspected = false;
    t.mock.method(store.database, "prepare", (sql: string) => {
      if (sql.includes("h.content AS h_content")) {
        inspected = true;
        assert.doesNotMatch(sql, /JOIN memory_embeddings|ve\.vector/);
      }
      return prepare(sql);
    });
    const result = store.search("/path/example", { retrievalMode: "fts5", maxTier: 3 });
    assert.equal(result[0]?.memory.id, saved.memory.id);
    assert.equal(result[0]?.vectorScore, 0);
    assert.equal(inspected, true);
    assert.equal(
      store.search("中文检索", { retrievalMode: "fts5", maxTier: 3 })[0]?.memory.id,
      saved.memory.id,
    );
  } finally {
    store.close();
  }
});

test("storedVector decodes projected binary and JSON values including joined aliases", () => {
  assert.deepEqual(storedVector({ vector: encodeVector([1, 2]) }), [1, 2]);
  assert.deepEqual(storedVector({ vector: "[3,4]" }), [3, 4]);
  assert.deepEqual(storedVector({ ve_vector: "[5,6]" }, "ve_"), [5, 6]);
  assert.deepEqual(storedVector({ vector: null }), []);
});
