/**
 * Progressive-vs-full candidate-timing profile.
 *
 * Answers: does a single progressive round-1 (leaf-block FTS hits + node-routed
 * blocks) actually save anything over full-store candidate generation?
 *
 * Measures on a real large per-user store:
 *   - fullStore: routeLeafBlocksByFts(query, 50) — time + hit count
 *   - nodeRoute: routeNodesByFts(query, 2) — time + node count
 *   - nodeBlocks: node-routed blocks (2/node) — time + count
 *   - early-stop overlap: do the round-1 blocks cover the full-store top-N?
 *
 * Usage (from repo root):
 *   set -a; source .env; set +a
 *   node --experimental-strip-types evals/retrieval/profile-progressive.ts
 */
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { NmgStore } from "../../src/core/store.ts";
import {
  createNodeSummaryProviderFromEnv,
  drainNodeSummaries,
} from "../../src/integration/node-summarizer.ts";
import { loadDataset } from "./datasets.ts";

const STORES_ROOT = resolve(".benchmarks/retrieval-stores");

function storeFileFor(userId: string): string {
  return `${createHash("sha256").update(userId).digest("hex").slice(0, 24)}.sqlite`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function timeMs(fn: () => unknown, runs = 40): number {
  fn(); // warmup
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

interface Row {
  blockId?: string;
  nodeId?: string;
}

async function main() {
  const spec = loadDataset("longmemeval", { full: true });
  const dir = resolve(STORES_ROOT, "longmemeval");

  // largest store by leaf blocks, plus its real question
  let largest = { file: "", blocks: 0 };
  for (const item of spec.questions) {
    const f = storeFileFor(item.userId);
    try {
      const db = new DatabaseSync(resolve(dir, f), { readOnly: true });
      const blocks = (db.prepare("SELECT COUNT(*) c FROM memory_leaf_blocks").get() as { c: number }).c;
      db.close();
      if (blocks > largest.blocks) largest = { file: f, blocks };
    } catch {
      /* store may not exist yet */
    }
  }
  console.log(`largest longmemeval store: ${largest.file} (${largest.blocks} leaf blocks)`);
  const question = spec.questions.find((q) => storeFileFor(q.userId) === largest.file);
  if (!question) throw new Error("no question maps to the largest store");

  const store = new NmgStore(resolve(dir, largest.file));

  // ensure node summaries so the node-routed arm has an index
  const provider = createNodeSummaryProviderFromEnv();
  if (provider) {
    const pending = store.pendingNodeSummaries({ limit: 1000 }).length;
    if (pending > 0) {
      console.log(`draining ${pending} pending node summaries …`);
      const r = await drainNodeSummaries(store, provider, { maxCalls: 1000 });
      console.log(`  node summaries: +${r.summarized} (failed ${r.failed}, truncated ${r.truncated})`);
    } else {
      console.log("  no pending node summaries (already summarized)");
    }
  } else {
    console.warn("no summary provider — node-routed arm will be empty");
  }

  // query set: the real question + queries derived from stored memory content
  const texts = (
    (store as unknown as { db: DatabaseSync }).db
      .prepare("SELECT statement FROM memory_records ORDER BY ROWID LIMIT 2000")
      .all() as Array<{ statement: string }>
  ).map((r) => String(r.statement));
  const queries = [question.query];
  for (const t of texts) {
    const words = t.split(/\s+/u).filter((w) => w.length > 1);
    if (words.length >= 4) queries.push(words.slice(0, 12).join(" "));
    if (queries.length >= 40) break;
  }
  console.log(`queries: ${queries.length} (first is the real LME question)`);

  const results: Array<{
    query: string;
    fullMs: number;
    fullHits: number;
    nodeMs: number;
    nodeHits: number;
    nodeBlocksMs: number;
    nodeBlocks: number;
    overlapTop3: number;
    overlapTop10: number;
    overlapAll: number;
    round1Size: number;
  }> = [];

  for (const query of queries) {
    const full = store.routeLeafBlocksByFts(query, 50);
    const fullMs = timeMs(() => store.routeLeafBlocksByFts(query, 50));
    const nodes = store.routeNodesByFts(query, 2);
    const nodeMs = timeMs(() => store.routeNodesByFts(query, 2));

    // node-routed blocks (2 per node, mirroring leafBlockRouting)
    const nodeBlockIds: string[] = [];
    const nodeBlocksMs = timeMs(() => {
      for (const node of nodes) {
        const blocks = (
          (store as unknown as { db: DatabaseSync }).db
            .prepare(
              `SELECT id FROM memory_leaf_blocks
                WHERE node_id = ? ORDER BY memory_count DESC, id ASC LIMIT 2`,
            )
            .all(node.nodeId) as Row[]
        ).map((b) => String(b.blockId));
        void blocks;
      }
    });
    for (const node of nodes) {
      const blocks = (
        (store as unknown as { db: DatabaseSync }).db
          .prepare(
            `SELECT id FROM memory_leaf_blocks
              WHERE node_id = ? ORDER BY memory_count DESC, id ASC LIMIT 2`,
          )
          .all(node.nodeId) as Array<{ id: string }>
      ).map((b) => String(b.id));
      for (const id of blocks) if (!nodeBlockIds.includes(id)) nodeBlockIds.push(id);
    }

    const directTop3 = full.slice(0, 3).map((h) => h.blockId);
    const round1 = [...new Set([...directTop3, ...nodeBlockIds])];
    const fullTop10 = full.slice(0, 10).map((h) => h.blockId);
    const fullAll = full.map((h) => h.blockId);
    const overlap = (target: string[]) => target.filter((id) => round1.includes(id)).length;

    results.push({
      query: query.slice(0, 40),
      fullMs,
      fullHits: full.length,
      nodeMs,
      nodeHits: nodes.length,
      nodeBlocksMs,
      nodeBlocks: nodeBlockIds.length,
      overlapTop3: overlap(fullTop10.slice(0, 3)),
      overlapTop10: overlap(fullTop10),
      overlapAll: overlap(fullAll),
      round1Size: round1.length,
    });
  }

  const agg = (k: keyof (typeof results)[0]) =>
    median(results.map((r) => r[k] as number));
  console.log("\n== per-query medians ==");
  console.log(`full-block candidates : ${agg("fullMs").toFixed(3)} ms, ${agg("fullHits").toFixed(1)} hits`);
  console.log(`node routing          : ${agg("nodeMs").toFixed(3)} ms, ${agg("nodeHits").toFixed(1)} nodes`);
  console.log(`node->blocks          : ${agg("nodeBlocksMs").toFixed(3)} ms, ${agg("nodeBlocks").toFixed(1)} blocks`);
  console.log(`round-1 size          : ${agg("round1Size").toFixed(1)} blocks`);
  console.log(`overlap top-3         : ${agg("overlapTop3").toFixed(2)} / 3 (${((agg("overlapTop3") / 3) * 100).toFixed(0)}%)`);
  console.log(`overlap top-10        : ${agg("overlapTop10").toFixed(2)} / 10`);
  console.log(`overlap all           : ${agg("overlapAll").toFixed(2)} / ${agg("fullHits").toFixed(1)}`);
  console.log(`\nnode-routed empty (no node FTS hits): ${results.filter((r) => r.nodeHits === 0).length}/${results.length}`);

  store.close();
}

await main();
