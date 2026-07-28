// Qualitative check: contradictionNotes over the real BEAM conv1 store.
import { DatabaseSync } from "node:sqlite";
import { NmgStore } from "../src/core/store.ts";

const dbPath = ".benchmarks/beam-conv1-nmg.sqlite";
const raw = new DatabaseSync(dbPath, { readOnly: true });
const rows = raw
  .prepare(
    `SELECT m.id, m.statement FROM memory_records m
      WHERE m.status IN ('active','disputed') AND m.claims_json IS NOT NULL
      ORDER BY m.rowid`,
  )
  .all() as { id: string; statement: string }[];
raw.close();
console.log(`records with claims: ${rows.length}`);

const store = new NmgStore(dbPath);
const notes = store.contradictionNotes(rows.map((r) => r.id));
console.log(`notes emitted: ${notes.size}`);
for (const r of rows) {
  const note = notes.get(r.id);
  if (note) {
    console.log("---");
    console.log(`stmt: ${r.statement.slice(0, 110)}`);
    console.log(`note: ${note}`);
  }
}
store.close();
