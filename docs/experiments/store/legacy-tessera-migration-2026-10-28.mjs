import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { migrate, migrateLegacyTesseraeTables } from "../../../src/core/store/schema.ts";

const { values } = parseArgs({ options: { run: { type: "boolean" } } });
if (!values.run) throw new Error("usage: node --experimental-strip-types <script> --run");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (revision !== "cd193624f10d72b69b010ca70de5d61c6f8cd09d")
  throw new Error("this characterization requires revision cd193624 with unmodified store schema");
try {
  execFileSync("git", ["diff", "--quiet", "HEAD", "--", "src/core/store/schema.ts"]);
} catch {
  throw new Error("this characterization requires an unmodified store schema");
}

function fixture(oldOnly, oldRow, newId) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  db.exec(`
    INSERT INTO history_records(id,role,content,created_at) VALUES ('h','user','sample','2026');
    INSERT INTO memory_nodes(id,canonical_name,kind,summary,created_at,updated_at)
      VALUES ('n','sample','topic','','2026','2026');
    INSERT INTO memory_records(id,node_id,evidence_id,statement,tier,importance,created_at,markers_json)
      VALUES ('m','n','h','sample',0,0.5,'2026','[{"kind":"anchor_ref","attributes":{"anchorId":"old"}}]');
  `);
  if (oldOnly) db.exec("DROP TABLE tesserae_fts; DROP TABLE tesserae");
  db.exec(`CREATE TABLE anchors (
    id TEXT PRIMARY KEY, path TEXT NOT NULL, snippet TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '', kind TEXT, memory_id TEXT, created_at TEXT NOT NULL
  )`);
  if (oldRow)
    db.prepare("INSERT INTO anchors(id,path,snippet,label,created_at) VALUES (?,?,?,?,?)").run(
      "old",
      "a.ts",
      "oldtext",
      "oldtoken",
      "2026",
    );
  if (newId)
    db.prepare("INSERT INTO tesserae(id,path,snippet,label,created_at) VALUES (?,?,?,?,?)").run(
      newId,
      "b.ts",
      "newtext",
      "newtoken",
      "2026",
    );
  return db;
}

function observation(db) {
  const oldExists = db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='anchors'")
    .get();
  return {
    old: oldExists ? db.prepare("SELECT count(*) AS n FROM anchors").get().n : null,
    current: db.prepare("SELECT count(*) AS n FROM tesserae").get().n,
    oldMarker: db
      .prepare("SELECT count(*) AS n FROM memory_records WHERE markers_json LIKE '%anchor_ref%'")
      .get().n,
    oldFts: db
      .prepare("SELECT count(*) AS n FROM tesserae_fts WHERE tesserae_fts MATCH 'oldtoken'")
      .get().n,
  };
}

const results = {};
for (const [name, oldOnly, oldRow, newId] of [
  ["old-only", true, true, null],
  ["both-empty-old", false, false, "new"],
  ["both-disjoint", false, true, "new"],
  ["both-same-id", false, true, "old"],
]) {
  const db = fixture(oldOnly, oldRow, newId);
  try {
    migrate(db);
    migrate(db);
    const actual = observation(db);
    if (name === "old-only")
      assert.deepEqual(actual, { old: null, current: 1, oldMarker: 0, oldFts: 1 });
    else assert.deepEqual(actual, { old: oldRow ? 1 : 0, current: 1, oldMarker: 1, oldFts: 0 });
    results[name] = actual;
  } finally {
    db.close();
  }
}

const db = fixture(true, true, null);
try {
  let injected = false;
  const faulty = {
    prepare: (...args) => db.prepare(...args),
    exec(sql) {
      if (sql.includes("UPDATE memory_records") && !injected) {
        injected = true;
        throw new Error("injected failure before marker update");
      }
      return db.exec(sql);
    },
  };
  assert.throws(() => migrateLegacyTesseraeTables(faulty), /injected failure/);
  migrate(db);
  migrate(db);
  const actual = observation(db);
  assert.deepEqual(actual, { old: null, current: 1, oldMarker: 1, oldFts: 1 });
  results["interrupted-then-retry"] = actual;
} finally {
  db.close();
}

process.stdout.write(
  JSON.stringify(
    { revision, node: process.version, measuredAt: new Date().toISOString(), results },
    null,
    2,
  ) + "\n",
);
