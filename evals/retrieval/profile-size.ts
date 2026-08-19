/**
 * Store-size profiling — per-user store scale (memory/block/node counts).
 *
 * NMG is per-user stores (each user a separate sqlite). This prints the size
 * distribution so we can pick a representative "large" store for the
 * progressive-vs-full candidate-timing profile.
 *
 * Usage:
 *   node --experimental-strip-types evals/retrieval/profile-size.ts <dataset>
 */

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const STORES_ROOT = resolve(".benchmarks/retrieval-stores");

function open(path: string) {
  return new DatabaseSync(path, { readOnly: true });
}

function main() {
  const dataset = process.argv[2] ?? "longmemeval";
  const dir = resolve(STORES_ROOT, dataset);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sqlite"));
  const rows: Array<{ file: string; mem: number; blocks: number; nodes: number; leafFts: number }> = [];

  for (const file of files) {
    const db = open(resolve(dir, file));
    try {
      const mem = db.prepare("SELECT COUNT(*) c FROM memory_records").get() as { c: number };
      const blocks = db.prepare("SELECT COUNT(*) c FROM memory_leaf_blocks").get() as { c: number };
      const nodes = db.prepare("SELECT COUNT(*) c FROM memory_nodes").get() as { c: number };
      const leafFts = db.prepare("SELECT COUNT(*) c FROM memory_leaf_fts").get() as { c: number };
      rows.push({ file, mem: mem.c, blocks: blocks.c, nodes: nodes.c, leafFts: leafFts.c });
    } catch (e) {
      rows.push({ file, mem: -1, blocks: -1, nodes: -1, leafFts: -1 });
    }
    db.close();
  }

  rows.sort((a, b) => b.blocks - a.blocks);
  const total = rows.length;
  const sum = (k: "mem" | "blocks" | "nodes") => rows.reduce((s, r) => s + (r[k] > 0 ? r[k] : 0), 0);
  const avg = (k: "mem" | "blocks" | "nodes") => (sum(k) / Math.max(1, total)).toFixed(1);
  console.log(`\n== ${dataset}: ${total} stores ==`);
  console.log(`avg per store — mem: ${avg("mem")}  blocks: ${avg("blocks")}  nodes: ${avg("nodes")}`);
  console.log("\ntop-8 by blocks:");
  for (const r of rows.slice(0, 8)) {
    console.log(
      `  ${r.file}  mem=${r.mem}  blocks=${r.blocks}  nodes=${r.nodes}  leafFts=${r.leafFts}`,
    );
  }
}

main();
