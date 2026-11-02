import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { migrate } from "../../../src/core/store/schema.ts";

function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  db.exec(`
    INSERT INTO history_records(id, role, content, created_at) VALUES ('h', 'user', 'x', '2026');
    INSERT INTO memory_nodes(id, canonical_name, kind, summary, created_at, updated_at)
      VALUES ('n', 'sample', 'topic', '', '2026', '2026');
    INSERT INTO memory_records(id, node_id, evidence_id, statement, tier, importance, created_at, markers_json)
      VALUES ('m', 'n', 'h', 'x', 0, 0.5, '2026', '[{"kind":"anchor_ref","attributes":{"anchorId":"old","path":"a.ts"}}]');
    CREATE TABLE anchors (id TEXT PRIMARY KEY, path TEXT NOT NULL, snippet TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '', kind TEXT, memory_id TEXT, created_at TEXT NOT NULL);
    INSERT INTO anchors VALUES ('old','a.ts','old snippet','oldtoken',NULL,NULL,'2026');
  `);
  return db;
}

function marker(db: DatabaseSync): { kind: string; attributes: Record<string, string> } {
  const row = db.prepare("SELECT markers_json FROM memory_records WHERE id='m'").get();
  return JSON.parse(String(row?.markers_json))[0];
}

test("migration merges nonconflicting legacy bookmarks and repairs markers on repeat", () => {
  const db = fixture();
  try {
    db.exec(
      "INSERT INTO tesserae(id,path,snippet,label,created_at) VALUES ('new','b.ts','new','newtoken','2026')",
    );
    migrate(db);
    migrate(db);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tesserae").get()?.n, 2);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM tesserae_fts WHERE tesserae_fts MATCH 'oldtoken'").get()
        ?.n,
      1,
    );
    assert.deepEqual(marker(db), {
      kind: "tessera_ref",
      attributes: { tesseraId: "old", path: "a.ts" },
    });
  } finally {
    db.close();
  }
});

test("migration rejects conflicting IDs without changing either table or markers", () => {
  const db = fixture();
  try {
    db.exec(
      "INSERT INTO tesserae(id,path,snippet,label,created_at) VALUES ('old','b.ts','different','newtoken','2026')",
    );
    assert.throws(() => migrate(db), /conflict/i);
    assert.equal(
      db.prepare("SELECT snippet FROM anchors WHERE id='old'").get()?.snippet,
      "old snippet",
    );
    assert.equal(
      db.prepare("SELECT snippet FROM tesserae WHERE id='old'").get()?.snippet,
      "different",
    );
    assert.equal(marker(db).kind, "anchor_ref");
  } finally {
    db.close();
  }
});

test("migration repairs markers after an already completed legacy rename", () => {
  const db = fixture();
  try {
    db.exec("INSERT INTO tesserae SELECT *, NULL FROM anchors; DROP TABLE anchors");
    migrate(db);
    assert.deepEqual(marker(db), {
      kind: "tessera_ref",
      attributes: { tesseraId: "old", path: "a.ts" },
    });
  } finally {
    db.close();
  }
});

test("migration renames a legacy-only table and rebuilds its search index", () => {
  const db = fixture();
  try {
    db.exec("DROP TABLE tesserae_fts; DROP TABLE tesserae");
    migrate(db);
    migrate(db);
    assert.equal(
      db.prepare("SELECT snippet FROM tesserae WHERE id='old'").get()?.snippet,
      "old snippet",
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM tesserae_fts WHERE tesserae_fts MATCH 'oldtoken'").get()
        ?.n,
      1,
    );
    assert.deepEqual(marker(db), {
      kind: "tessera_ref",
      attributes: { tesseraId: "old", path: "a.ts" },
    });
  } finally {
    db.close();
  }
});

test("migration rolls back its rename when a marker update fails and can retry", () => {
  const db = fixture();
  try {
    db.exec(`DROP TABLE tesserae_fts; DROP TABLE tesserae;
      CREATE TRIGGER reject_marker BEFORE UPDATE OF markers_json ON memory_records
      BEGIN SELECT RAISE(ABORT, 'injected marker failure'); END;`);
    assert.throws(() => migrate(db), /injected marker failure/);
    assert.equal(
      db.prepare("SELECT snippet FROM anchors WHERE id='old'").get()?.snippet,
      "old snippet",
    );
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='tesserae'").get(), undefined);
    assert.equal(marker(db).kind, "anchor_ref");
    db.exec("DROP TRIGGER reject_marker");
    migrate(db);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM tesserae_fts WHERE tesserae_fts MATCH 'oldtoken'").get()
        ?.n,
      1,
    );
    assert.equal(marker(db).attributes.tesseraId, "old");
  } finally {
    db.close();
  }
});

test("migration accepts matching duplicate rows and retains the current fingerprint", () => {
  const db = fixture();
  try {
    db.exec("INSERT INTO tesserae SELECT *, 'fingerprint' FROM anchors");
    migrate(db);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tesserae").get()?.n, 1);
    assert.equal(
      db.prepare("SELECT file_simhash FROM tesserae WHERE id='old'").get()?.file_simhash,
      "fingerprint",
    );
  } finally {
    db.close();
  }
});

test("migration repairs a marker whose kind was renamed but its ID was not", () => {
  const db = fixture();
  try {
    db.exec(`INSERT INTO tesserae SELECT *, NULL FROM anchors; DROP TABLE anchors;
      UPDATE memory_records SET markers_json =
        '[{"kind":"tessera_ref","attributes":{"anchorId":"old","path":"a.ts"}},{"kind":"note","attributes":{"anchorId":"keep"}}]';`);
    migrate(db);
    const row = db.prepare("SELECT markers_json FROM memory_records WHERE id='m'").get();
    assert.deepEqual(JSON.parse(String(row?.markers_json)), [
      { kind: "tessera_ref", attributes: { tesseraId: "old", path: "a.ts" } },
      { kind: "note", attributes: { anchorId: "keep" } },
    ]);
  } finally {
    db.close();
  }
});

test("migration refuses unknown legacy columns without discarding them", () => {
  const db = fixture();
  try {
    db.exec(
      "ALTER TABLE anchors ADD COLUMN custom_data TEXT; UPDATE anchors SET custom_data='keep'",
    );
    assert.throws(() => migrate(db), /unsupported columns/);
    assert.equal(
      db.prepare("SELECT custom_data FROM anchors WHERE id='old'").get()?.custom_data,
      "keep",
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tesserae").get()?.n, 0);
  } finally {
    db.close();
  }
});

test("migration participates in an outer transaction", () => {
  const db = fixture();
  try {
    db.exec("BEGIN");
    migrate(db);
    db.exec("ROLLBACK");
    assert.equal(
      db.prepare("SELECT snippet FROM anchors WHERE id='old'").get()?.snippet,
      "old snippet",
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tesserae").get()?.n, 0);
    assert.equal(marker(db).kind, "anchor_ref");
  } finally {
    db.close();
  }
});
