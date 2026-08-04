/**
 * Qualitative probe: MGR differentiable set logic vs single-vector retrieval
 * on real LoCoMo multi-hop failures.
 *
 * Loads a benchmark user's BGE record embeddings from an NMG SQLite database,
 * then for each probe case compares:
 *   baseline — top-K by cos(question vector)
 *   logic    — top-K by MGR logicSearch(and/or/not over sub-query atoms)
 *
 * Requires the local BGE server (evals/omnimemeval/bge_server.py) on :8000.
 *
 * Usage:
 *   node --experimental-strip-types evals/omnimemeval/mgr-logic-probe.ts <db-path>
 */

import { DatabaseSync } from "node:sqlite";

import { Logic, MemoryGraphReasoner } from "../../src/lab/memory-graph-reasoner.ts";
import type { LogicExpr } from "../../src/lab/memory-graph-reasoner.ts";

const EMBED_URL = "http://127.0.0.1:8000/v1/embeddings";
const EMBED_MODEL = "BAAI/bge-small-en-v1.5";
const TOP_K = 20;

interface ProbeCase {
  question: string;
  /** Sub-query texts in expression order, for readability of the output. */
  subQueries: string[];
  expr: (atoms: Float32Array[]) => LogicExpr;
  /** Distinctive substrings of the gold evidence statements. */
  gold: string[];
}

const CASES: ProbeCase[] = [
  {
    question: "Which city have both Jean and John visited?",
    subQueries: [
      "cities and places Gina has traveled to or visited",
      "cities and places Jon has traveled to or visited",
    ],
    expr: ([a, b]) => Logic.and(Logic.atom(a!), Logic.atom(b!)),
    gold: ["Been only to Rome once", "trip last week to Rome"],
  },
  {
    question: "How did Gina promote her clothes store?",
    subQueries: [
      "Gina's methods to promote her online clothing store",
      "Gina speaking about her own fashion products and designs",
    ],
    expr: ([a, b]) => Logic.and(Logic.atom(a!), Logic.atom(b!)),
    gold: [
      "teamed up with a local",
      "limited edition line",
      "offers and promotions",
      "video presentation",
    ],
  },
  {
    question: "Which events has Jon participated in to promote his business venture?",
    subQueries: [
      "events Jon attended to promote his business venture",
      "specific named events like fairs, competitions, meetups, or networking gatherings",
    ],
    expr: ([a, b]) => Logic.and(Logic.atom(a!), Logic.atom(b!)),
    gold: ["went to a fair", "networking events", "dance competition"],
  },
];

async function embed(texts: string[]): Promise<Float32Array[]> {
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`embed failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => Float32Array.from(d.embedding));
}

function main(): void {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error("usage: mgr-logic-probe.ts <db-path>");
    process.exit(1);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT r.id, r.statement, e.vector_blob
       FROM memory_records r
       JOIN memory_embeddings e ON e.memory_id = r.id
       WHERE r.status = 'active' AND e.model LIKE 'BAAI/%'`,
    )
    .all() as { id: string; statement: string; vector_blob: Uint8Array }[];
  db.close();
  console.log(`loaded ${rows.length} active records with BGE embeddings`);

  const graph = new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        vector: new Float32Array(r.vector_blob.buffer, r.vector_blob.byteOffset, 384).slice(),
      },
    ]),
  );
  const mgr = new MemoryGraphReasoner(384);

  void (async () => {
    for (const c of CASES) {
      console.log("=".repeat(88));
      console.log("Q:", c.question);

      const [qVec, ...subVecs] = await embed([c.question, ...c.subQueries]);

      // baseline: single-vector cosine top-K
      const baseline = mgr.logicSearch(Logic.atom(qVec!), graph, TOP_K);

      // logic expression over sub-queries
      const logic = mgr.logicSearch(c.expr(subVecs), graph, TOP_K);

      const report = (name: string, results: { nodeId: string; membership: number }[]) => {
        const hits: string[] = [];
        for (const g of c.gold) {
          const row = rows.find((r) => r.statement.includes(g));
          if (!row) {
            hits.push(`  gold "${g}" NOT IN DB`);
            continue;
          }
          const rank = results.findIndex((r) => r.nodeId === row.id);
          hits.push(
            rank >= 0
              ? `  gold "${g.slice(0, 40)}..." rank=${rank + 1} (m=${results[rank]!.membership.toFixed(3)})`
              : `  gold "${g.slice(0, 40)}..." NOT in top-${TOP_K}`,
          );
        }
        console.log(`-- ${name}`);
        console.log(hits.join("\n"));
      };
      report("baseline (single vector)", baseline);
      report(`logic (${c.subQueries.join("  ∧/¬  ")})`, logic);

      console.log("-- logic top-5:");
      for (const r of logic.slice(0, 5)) {
        const row = rows.find((x) => x.id === r.nodeId)!;
        console.log(`  ${r.membership.toFixed(3)}  ${row.statement.slice(0, 100)}`);
      }
      console.log();
    }
  })();
}

main();
