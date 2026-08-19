/**
 * Merge all eval embedding caches into one shared cache
 * (.benchmarks/shared-embedding-cache.sqlite).
 *
 * Embeddings are content-hashed (index_id, input_kind, text_hash) — the same
 * text + model yields the same key everywhere, so one cache serves every eval
 * variant. We measured 27.4% redundancy (248k duplicate rows) across the 5
 * non-empty caches, mostly bge-union-k20 (96% overlap with omnimemeval-nmg).
 *
 * Usage: node evals/omnimemeval/merge-embedding-caches.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const TARGET = resolve(ROOT, ".benchmarks/shared-embedding-cache.sqlite");
const SOURCES = [
  resolve(ROOT, ".benchmarks/omnimemeval-nmg/embedding-cache.sqlite"),
  resolve(ROOT, ".benchmarks/omnimemeval-nmg-bge-union-k20/embedding-cache.sqlite"),
  resolve(ROOT, ".benchmarks/retrieval-stores/locomo/embedding-cache.sqlite"),
  resolve(ROOT, ".benchmarks/retrieval-stores/beam/embedding-cache.sqlite"),
  resolve(ROOT, "evals/results/embedding-cache.sqlite"),
];

if (existsSync(TARGET)) {
  console.log(`removing previous ${TARGET}`);
  rmSync(TARGET, { force: true });
}

const target = new DatabaseSync(TARGET);
target.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = OFF;
  PRAGMA busy_timeout = 10000;
  CREATE TABLE embedding_cache (
    index_id TEXT NOT NULL,
    input_kind TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    vector_blob BLOB NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (index_id, input_kind, text_hash)
  );
`);

const insert = target.prepare(
  `INSERT OR IGNORE INTO embedding_cache (index_id, input_kind, text_hash, vector_blob, created_at)
   VALUES (?, ?, ?, ?, ?)`,
);

let total = 0;
let kept = 0;
for (const src of SOURCES) {
  if (!existsSync(src)) {
    console.log(`skip (missing): ${src}`);
    continue;
  }
  const s = new DatabaseSync(src, { readOnly: true });
  const count = s.prepare("SELECT COUNT(*) c FROM embedding_cache").get().c;
  let rows = 0;
  let offset = 0;
  const BATCH = 20000;
  while (offset < count) {
    const batch = s
      .prepare(
        `SELECT index_id, input_kind, text_hash, vector_blob, created_at
         FROM embedding_cache ORDER BY rowid LIMIT ? OFFSET ?`,
      )
      .all(BATCH, offset);
    if (batch.length === 0) break;
    target.exec("BEGIN");
    try {
      for (const r of batch) {
        const wasMissing = insert.run(r.index_id, r.input_kind, r.text_hash, r.vector_blob, r.created_at).changes > 0;
        rows += 1;
        if (wasMissing) kept += 1;
      }
      target.exec("COMMIT");
    } catch (e) {
      target.exec("ROLLBACK");
      throw e;
    }
    offset += batch.length;
  }
  total += rows;
  s.close();
  console.log(`merged ${src.split(/[\\/]/).slice(-3).join("/")}: ${rows} rows`);
}

const finalCount = target.prepare("SELECT COUNT(*) c FROM embedding_cache").get().c;
console.log(`\nmerged ${total} rows -> ${finalCount} unique (dropped ${total - finalCount} duplicates)`);
target.exec("PRAGMA wal_checkpoint(TRUNCATE)");
target.close();
