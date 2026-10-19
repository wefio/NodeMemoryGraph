import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { searchMemories } from "../../../src/cli/inspect-data.ts";
import { NmgStore } from "../../../src/core/store.ts";
import { migrate } from "../../../src/core/store/schema.ts";
import { ftsExpression, ftsIndexedText } from "../../../src/core/store/search-ranking.ts";
import { recallTriggersFromStoredMarkers } from "../../../src/core/recall-triggers.ts";

class InspectableStore extends NmgStore {
  get database(): DatabaseSync {
    return this.db;
  }
}

function withStore(run: (store: InspectableStore, db: DatabaseSync) => void): void {
  const store = new InspectableStore(":memory:");
  try {
    run(store, store.database);
  } finally {
    store.close();
  }
}

function authoritativeRows(db: DatabaseSync) {
  return {
    history: db.prepare("SELECT * FROM history_records ORDER BY id").all(),
    memories: db.prepare("SELECT * FROM memory_records ORDER BY id").all(),
    nodes: db.prepare("SELECT * FROM memory_nodes ORDER BY id").all(),
  };
}

/** An actual pre-contentless schema, not a contentless table filled with legacy text. */
function legacyIndex(db: DatabaseSync): void {
  const registry = db
    .prepare("SELECT rowid, memory_id FROM memory_fts_registry ORDER BY rowid")
    .all();
  db.exec(`DROP TABLE memory_fts;
    CREATE VIRTUAL TABLE memory_fts USING fts5(memory_id UNINDEXED, statement, node_name, evidence, tokenize = 'unicode61');
    DROP TABLE memory_fts_registry;
    CREATE TABLE memory_fts_registry (memory_id TEXT PRIMARY KEY REFERENCES memory_records(id) ON DELETE CASCADE);
    DELETE FROM store_metadata WHERE key = 'fts_storage_format';`);
  const register = db.prepare("INSERT INTO memory_fts_registry(rowid, memory_id) VALUES (?, ?)");
  for (const row of registry) register.run(row.rowid!, row.memory_id!);
  const rows = db
    .prepare(
      `SELECT m.id, m.statement, m.markers_json, n.canonical_name, h.content
    FROM memory_records m JOIN memory_nodes n ON n.id = m.node_id
    JOIN history_records h ON h.id = m.evidence_id
    JOIN memory_fts_registry r ON r.memory_id = m.id ORDER BY r.rowid`,
    )
    .all();
  const insert = db.prepare(
    "INSERT INTO memory_fts(rowid, memory_id, statement, node_name, evidence) VALUES (?, ?, ?, ?, ?)",
  );
  rows.forEach((row, index) => {
    const triggers = recallTriggersFromStoredMarkers(row.markers_json).join(" ");
    insert.run(
      [91, 17, 503][index] ?? 600 + index,
      row.id!,
      ftsIndexedText(String(row.statement)),
      ftsIndexedText(String(row.canonical_name)),
      ftsIndexedText(`${row.content} ${triggers}`.trim()),
    );
  });
}

function scores(db: DatabaseSync, query: string) {
  const sql = String(
    db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_fts'").get()?.sql,
  );
  const modern = sql.includes("contentless_delete");
  return db
    .prepare(
      `SELECT ${modern ? "r.memory_id" : "f.memory_id"} AS memory_id,
      f.rowid, bm25(memory_fts) AS score FROM memory_fts f
      ${modern ? "JOIN memory_fts_registry r ON r.lexical_rowid = f.rowid" : ""}
      WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts), f.rowid`,
    )
    .all(ftsExpression(query));
}

test("lexical FTS retains postings and doc sizes but no full-text content copy", () => {
  withStore((store, db) => {
    const saved = store.remember({
      statement: "用户喜欢中文解释 C++ v2.4.1",
      nodeName: "中文解释",
    });
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_fts_content'").get(),
      undefined,
    );
    const row = db.prepare("SELECT statement, node_name, evidence FROM memory_fts").get();
    assert.equal(row?.statement, null);
    assert.equal(row?.node_name, null);
    assert.equal(row?.evidence, null);
    assert.ok(store.ftsCandidates("中文解释", 8).includes(saved.memory.id));
    assert.ok(store.surfaceAnchorCandidates("`C++` v2.4.1", 8).includes(saved.memory.id));
    assert.equal(
      db.prepare("SELECT content FROM history_records WHERE id = ?").get(saved.history.id)?.content,
      saved.history.content,
    );
  });
});

test("legacy FTS migration preserves BM25, tie order, both rowid mappings and authoritative rows", () => {
  withStore((store, db) => {
    const records = ["alice", "bob", "carol"].map((owner) =>
      store.remember({
        statement: "storage 用户喜欢中文解释 C++ v2.4.1",
        nodeName: "FTS",
        memoryType: "event",
        scope: { owner },
        recallTriggers: ["nickname-alias"],
      }),
    );
    legacyIndex(db);
    const before = authoritativeRows(db);
    const surfaceRows = db
      .prepare("SELECT rowid, memory_id FROM memory_fts_registry ORDER BY rowid")
      .all();
    const queries = ["storage", "中文", "nickname-alias"];
    const expected = queries.map((query) => scores(db, query));
    for (const ranked of expected) assert.equal(ranked.length, 3);
    migrate(db);
    assert.deepEqual(authoritativeRows(db), before);
    assert.deepEqual(
      db.prepare("SELECT rowid, memory_id FROM memory_fts_registry ORDER BY rowid").all(),
      surfaceRows,
    );
    queries.forEach((query, index) => assert.deepEqual(scores(db, query), expected[index]));
    assert.deepEqual(store.ftsCandidates("storage", 2), [
      records[1]!.memory.id,
      records[0]!.memory.id,
    ]);
    assert.deepEqual(store.ftsCandidatesInNodes("storage", [records[0]!.node.id], 2), [
      records[1]!.memory.id,
      records[0]!.memory.id,
    ]);
    assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  });
});

test("contentless FTS refresh removes old terms and triggers from both indexes atomically", () => {
  withStore((store, db) => {
    const saved = store.remember({
      statement: "oldtoken C++ v2.4.1",
      nodeName: "FTS",
      recallTriggers: ["oldalias"],
    });
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE memory_records SET statement = ?, markers_json = '[]' WHERE id = ?").run(
        "newtoken Rust v3.5.2",
        saved.memory.id,
      );
      store.upsertFts(saved.memory.id, "newtoken Rust v3.5.2", saved.node.id, saved.history.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    // The retained evidence legitimately still contains the old statement.
    assert.ok(store.ftsCandidates("oldtoken", 8).includes(saved.memory.id));
    assert.ok(store.ftsCandidates("newtoken", 8).includes(saved.memory.id));
    assert.deepEqual(store.ftsCandidates("oldalias", 8), []);
    assert.deepEqual(store.surfaceAnchorCandidates("`oldalias`", 8), []);
    assert.ok(store.surfaceAnchorCandidates("v3.5.2", 8).includes(saved.memory.id));
    assert.equal(db.prepare("SELECT count(*) AS n FROM memory_fts").get()?.n, 1);
  });
});

test("forget and dormant transitions remove both FTS indexes, restore reindexes retained source", () => {
  withStore((store, db) => {
    const saved = store.remember({ statement: "retentiontoken C++", nodeName: "FTS" });
    store.setMemoryStorageState(saved.memory.id, "dormant");
    assert.deepEqual(store.ftsCandidates("retentiontoken", 8), []);
    assert.deepEqual(store.surfaceAnchorCandidates("`C++`", 8), []);
    assert.equal(db.prepare("SELECT count(*) AS n FROM memory_fts_registry").get()?.n, 0);
    store.setMemoryStorageState(saved.memory.id, "indexed");
    assert.ok(store.ftsCandidates("retentiontoken", 8).includes(saved.memory.id));
    store.deleteMemory(saved.memory.id);
    assert.deepEqual(store.ftsCandidates("retentiontoken", 8), []);
    assert.deepEqual(store.surfaceAnchorCandidates("`C++`", 8), []);
    assert.equal(db.prepare("SELECT count(*) AS n FROM memory_fts").get()?.n, 0);
    migrate(db);
    assert.equal(db.prepare("SELECT count(*) AS n FROM memory_fts").get()?.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM memory_fts_registry").get()?.n, 0);
    assert.deepEqual(store.ftsCandidates("retentiontoken", 8), []);
  });
});

test("FTS migration failure restores the old table, registry schema, indexes and version markers", () => {
  withStore((store, db) => {
    store.remember({ statement: "rollbacktoken 用户喜欢中文解释", nodeName: "FTS" });
    legacyIndex(db);
    const before = authoritativeRows(db);
    const oldSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_fts'").get()?.sql;
    const oldScores = scores(db, "rollbacktoken");
    const oldMarkers = db.prepare("SELECT * FROM store_metadata ORDER BY key").all();
    db.exec(`CREATE TRIGGER reject_fts_format BEFORE INSERT ON store_metadata
      WHEN NEW.key = 'fts_storage_format' BEGIN SELECT RAISE(ABORT, 'injected FTS migration failure'); END`);
    assert.throws(() => migrate(db), /injected FTS migration failure/);
    assert.equal(
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_fts'").get()?.sql,
      oldSql,
    );
    assert.deepEqual(
      db
        .prepare("PRAGMA table_info(memory_fts_registry)")
        .all()
        .map((row) => row.name),
      ["memory_id"],
    );
    assert.deepEqual(db.prepare("SELECT * FROM store_metadata ORDER BY key").all(), oldMarkers);
    assert.deepEqual(scores(db, "rollbacktoken"), oldScores);
    assert.deepEqual(authoritativeRows(db), before);
    db.exec("DROP TRIGGER reject_fts_format");
    migrate(db);
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_fts_content'").get(),
      undefined,
    );
  });
});

test("standalone FTS refresh failure restores both indexes and both rowid mappings", () => {
  withStore((store, db) => {
    const saved = store.remember({ statement: "originaltoken C++", nodeName: "FTS" });
    const before = scores(db, "originaltoken");
    const registry = db.prepare("SELECT rowid, * FROM memory_fts_registry").all();
    db.exec(`CREATE TRIGGER reject_fts_refresh BEFORE UPDATE ON memory_fts_registry
      BEGIN SELECT RAISE(ABORT, 'injected FTS refresh failure'); END`);
    assert.throws(
      () => store.upsertFts(saved.memory.id, "replacedtoken Rust", saved.node.id, saved.history.id),
      /injected FTS refresh failure/,
    );
    assert.deepEqual(scores(db, "originaltoken"), before);
    assert.deepEqual(db.prepare("SELECT rowid, * FROM memory_fts_registry").all(), registry);
    assert.deepEqual(store.ftsCandidates("replacedtoken", 8), []);
    assert.deepEqual(store.surfaceAnchorCandidates("`Rust`", 8), []);
    assert.ok(store.surfaceAnchorCandidates("`C++`", 8).includes(saved.memory.id));
  });
});

test("FTS migration participates in the caller's transaction and rolls back its schema change", () => {
  withStore((store, db) => {
    store.remember({ statement: "nestedtoken", nodeName: "FTS" });
    legacyIndex(db);
    const before = scores(db, "nestedtoken");
    db.exec("BEGIN");
    migrate(db);
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_fts_content'").get(),
      undefined,
    );
    db.exec("ROLLBACK");
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_fts_content'").get());
    assert.deepEqual(scores(db, "nestedtoken"), before);
    assert.deepEqual(
      db
        .prepare("PRAGMA table_info(memory_fts_registry)")
        .all()
        .map((row) => row.name),
      ["memory_id"],
    );
  });
});

test("a live read-only store handles legacy FTS and a writer's atomic upgrade without migrating", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-readonly-fts-"));
  const path = join(directory, "test.sqlite");
  const writer = new InspectableStore(path);
  let reader: NmgStore | undefined;
  try {
    const saved = writer.remember({ statement: "readonlytoken 用户偏好中文解释", nodeName: "FTS" });
    legacyIndex(writer.database);
    reader = new NmgStore(path, undefined, { readOnly: true });
    assert.ok(reader.ftsCandidates("readonlytoken", 8).includes(saved.memory.id));
    assert.ok(reader.ftsCandidates("中文", 8).includes(saved.memory.id));
    assert.equal(
      writer.database
        .prepare("SELECT value FROM store_metadata WHERE key = 'fts_storage_format'")
        .get(),
      undefined,
    );
    migrate(writer.database);
    assert.ok(reader.ftsCandidates("readonlytoken", 8).includes(saved.memory.id));
    assert.ok(reader.ftsCandidates("中文", 8).includes(saved.memory.id));
  } finally {
    reader?.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unchanged store opens do not rewrite the FTS corpus", (t) => {
  withStore((store, db) => {
    store.remember({ statement: "stabletoken", nodeName: "FTS" });
    const exec = db.exec.bind(db),
      prepare = db.prepare.bind(db);
    t.mock.method(db, "exec", (sql: string) => {
      assert.doesNotMatch(sql, /DROP TABLE memory_fts|DELETE FROM memory_fts/);
      return exec(sql);
    });
    t.mock.method(db, "prepare", (sql: string) => {
      assert.doesNotMatch(sql, /INSERT INTO memory_fts\(/);
      return prepare(sql);
    });
    migrate(db);
    assert.ok(store.ftsCandidates("stabletoken", 8).length > 0);
  });
});

test("identical text from different owners and sources stays separate evidence after migration", () => {
  withStore((store, db) => {
    const common = "identical-source-token 用户偏好中文解释";
    const first = store.remember({
      statement: common,
      nodeName: "FTS",
      scope: { owner: "alice" },
      sourceActor: "user",
    });
    const second = store.remember({
      statement: common,
      nodeName: "FTS",
      scope: { owner: "bob" },
      sourceActor: "tool",
    });
    assert.notEqual(first.memory.id, second.memory.id);
    assert.notEqual(first.history.id, second.history.id);
    legacyIndex(db);
    const before = authoritativeRows(db);
    migrate(db);
    assert.deepEqual(authoritativeRows(db), before);
    assert.equal(db.prepare("SELECT count(*) AS n FROM history_records").get()?.n, 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM memory_records").get()?.n, 2);
    assert.deepEqual(
      new Set(store.ftsCandidates("identical", 8)),
      new Set([first.memory.id, second.memory.id]),
    );
  });
});

test("read-only-style inspect and store queries read legacy and contentless layouts without migration", () => {
  withStore((store, db) => {
    const saved = store.remember({
      statement: "A summary without the source keyword",
      evidence: "evidenceonlytoken",
      nodeName: "FTS",
    });
    legacyIndex(db);
    const before = db.prepare("SELECT total_changes() AS n").get()?.n;
    assert.equal(searchMemories(db, "evidenceonlytoken")[0]?.id, saved.memory.id);
    assert.ok(store.ftsCandidates("evidenceonlytoken", 8).includes(saved.memory.id));
    assert.equal(db.prepare("SELECT total_changes() AS n").get()?.n, before);
    migrate(db);
    assert.equal(searchMemories(db, "evidenceonlytoken")[0]?.id, saved.memory.id);
    assert.ok(store.ftsCandidates("evidenceonlytoken", 8).includes(saved.memory.id));
  });
});
