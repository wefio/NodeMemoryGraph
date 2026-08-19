import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../../src/core/store.ts";
import { drainNodeSummaries } from "../../../src/integration/node-summarizer.ts";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-node-summaries-"));
  const store = new NmgStore(join(directory, "test.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function writeThree(store: NmgStore): string[] {
  const ids: string[] = [];
  for (const statement of [
    "user had lunch at a Thai place on 2026-05-01",
    "user booked a flight to Tokyo for 2026-06-15",
    "user's favorite editor is neovim",
  ]) {
    ids.push(
      store.remember({ statement, nodeName: "travel and taste", sourceActor: "user" }).memory.id,
    );
  }
  return ids;
}

/** Build leaf summaries for every pending block so node summaries can consume
 *  them (the node tier's input is leaf-block summaries, never raw memories). */
function summarizeAllBlocks(store: NmgStore): void {
  store.rebuildLeafBlocks();
  for (const task of store.pendingLeafSummaries()) {
    store.setLeafSummary(
      task.blockId,
      `block summary of ${task.nodeName}: ${task.statements.slice(0, 3).join("; ")}`,
      "test-model",
      task.membersKey,
    );
  }
}

test("pendingNodeSummaries: no task until blocks carry summaries, then one task per node", () => {
  withStore((store) => {
    writeThree(store);
    store.rebuildLeafBlocks();
    assert.equal(store.pendingNodeSummaries().length, 0, "no node task before block summaries");
    summarizeAllBlocks(store);
    const tasks = store.pendingNodeSummaries({ minBlocks: 1 });
    assert.equal(tasks.length, 1);
    const task = tasks[0]!;
    assert.equal(task.nodeName, "travel and taste");
    assert.equal(task.memberCount, 3);
    assert.ok(task.statements.length >= 1);
    assert.ok(task.statements.some((s) => s.includes("travel")));
  });
});

test("setNodeSummary: persists, indexes node FTS, clears pending", () => {
  withStore((store) => {
    writeThree(store);
    summarizeAllBlocks(store);
    const task = store.pendingNodeSummaries({ minBlocks: 1 })[0]!;
    assert.equal(
      store.setNodeSummary(task.nodeId, "travel: thai lunch, tokyo flight, neovim editor", "test-model", task.memberCount),
      true,
    );
    assert.equal(store.pendingNodeSummaries({ minBlocks: 1 }).length, 0, "summary clears pending");
    // Node FTS lexical routing finds the node.
    const hits = store.routeNodesByFts("tokyo flight", 2);
    assert.ok(
      hits.some((h) => h.nodeId === task.nodeId),
      "node summary indexed into memory_node_fts",
    );
    // Unknown node ids are rejected, empty summaries are rejected.
    assert.equal(store.setNodeSummary("does-not-exist", "x", "m", 1), false);
    assert.throws(() => store.setNodeSummary(task.nodeId, "   ", "m", 1));
  });
});

test("pendingNodeSummaries: hysteresis — small additions do not re-pend, enough do", () => {
  withStore((store) => {
    writeThree(store);
    summarizeAllBlocks(store);
    const task = store.pendingNodeSummaries({ minBlocks: 1 })[0]!;
    store.setNodeSummary(task.nodeId, "node summary", "test-model", task.memberCount);
    assert.equal(store.pendingNodeSummaries({ minBlocks: 1 }).length, 0);

    // One new member: below the default threshold (5) and within the refresh
    // window — must NOT re-pend.
    store.remember({
      statement: "user prefers emacs over vim",
      nodeName: "travel and taste",
      sourceActor: "user",
    });
    assert.equal(
      store.pendingNodeSummaries({ minBlocks: 1 }).length,
      0,
      "1 new member below threshold does not re-pend",
    );

    // Six more members: cumulative delta crosses the threshold — re-pends.
    for (let i = 0; i < 6; i += 1) {
      store.remember({
        statement: `travel packing note ${i}`,
        nodeName: "travel and taste",
        sourceActor: "user",
      });
    }
    assert.equal(
      store.pendingNodeSummaries({ minBlocks: 1 }).length,
      1,
      "7 new members cross the hysteresis threshold",
    );
  });
});

test("pendingNodeSummaries: aged refresh — any change re-pends after the window", () => {
  withStore((store) => {
    writeThree(store);
    summarizeAllBlocks(store);
    const task = store.pendingNodeSummaries({ minBlocks: 1 })[0]!;
    store.setNodeSummary(task.nodeId, "node summary", "test-model", task.memberCount);
    assert.equal(store.pendingNodeSummaries({ minBlocks: 1 }).length, 0);

    // 10 new members (> threshold), but force the aged-refresh arm off by
    // using a huge refresh window; the new-member arm still fires.
    for (let i = 0; i < 10; i += 1) {
      store.remember({
        statement: `note ${i}`,
        nodeName: "travel and taste",
        sourceActor: "user",
      });
    }
    assert.equal(
      store.pendingNodeSummaries({ minBlocks: 1, refreshMs: 86_400_000 }).length,
      1,
      "new-member arm fires regardless of age",
    );
  });
});

test("drainNodeSummaries: provider summarizes pending nodes and persists them", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-node-summary-drain-"));
  const store = new NmgStore(join(directory, "test.sqlite"));
  try {
    writeThree(store);
    summarizeAllBlocks(store);
    const provider = {
      model: "fake-node-summarizer",
      summarize: async (input: { nodeName: string; statements: readonly string[] }) =>
        `node ${input.nodeName}: ${input.statements[0]}`,
    };
    const result = await drainNodeSummaries(store, provider, { maxCalls: 8, minBlocks: 1 });
    assert.equal(result.summarized, 1);
    assert.equal(result.failed, 0);
    assert.equal(store.pendingNodeSummaries({ minBlocks: 1 }).length, 0);
    const hits = store.routeNodesByFts("node travel", 2);
    assert.ok(hits.length >= 1, "drained summary is FTS-routable");
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("leafBlockRouting: node-summary hit expands node blocks even without leaf summaries", () => {
  withStore((store) => {
    writeThree(store);
    store.rebuildLeafBlocks();
    const node = store.searchContext("neovim", { limit: 1 }).results[0]!.node;
    // Node summary indexed manually — blocks keep no leaf summaries, so any
    // expansion here proves the node-routed arm exempts blocks from the
    // summarized-block gate.
    assert.equal(
      store.setNodeSummary(node.id, "tokyo flight and neovim editor travel", "test-model", 3),
      true,
    );
    const ctx = store.searchContext("tokyo flight", {
      limit: 8,
      leafBlockRouting: true,
      leafBlockRoutingMaxMembers: 12,
    });
    assert.ok(
      ctx.results.some((r) => r.memory.statement.toLowerCase().includes("tokyo")),
      "node-routed block members expand into the context",
    );
  });
});

test("summary routing signal: routed+recalled detail persists and aggregates", () => {
  withStore((store) => {
    writeThree(store);
    store.rebuildLeafBlocks();
    summarizeAllBlocks(store);
    const node = store.searchContext("neovim", { limit: 1 }).results[0]!.node;
    // Index a node summary that shares terms with the query so the node-summary
    // FTS route matches it ("tokyo flight" is also present in the raw statement,
    // so the same node should ALSO be in the base result set → recalled=true).
    store.setNodeSummary(node.id, "tokyo flight and neovim editor travel", "test-model", 3);

    const ctx = store.searchContext("tokyo flight", {
      limit: 8,
      leafBlockRouting: true,
      leafBlockRoutingMaxMembers: 12,
    });
    const trace = store.retrievalTrace(ctx.activeGraph!.id);
    assert.ok(trace, "trace persisted");
    assert.ok((trace!.nodeRouteSignal ?? []).length >= 1, "node-route signal recorded");
    const signal = (trace!.nodeRouteSignal ?? []).find((s) => s.nodeId === node.id);
    assert.ok(signal, "the routed node appears in the signal");
    assert.equal(signal!.routed, true);
    // "tokyo flight" is verbatim in the raw statement, so base lexical retrieval
    // must also have pulled the node → recalled true.
    assert.equal(signal!.recalled, true, "node in base result set is recalled");

    // Aggregate tier: the node accumulated a routed (and recalled) counter.
    const aggregate = (
      (store as unknown as { db: import("node:sqlite").DatabaseSync }).db
        .prepare(
          `SELECT summary_routed_count, summary_recalled_count
             FROM node_retrieval_signals WHERE node_id = ?`,
        )
        .get(node.id) as { summary_routed_count: number; summary_recalled_count: number }
    );
    assert.ok(aggregate.summary_routed_count >= 1, "routed count aggregated");
    assert.ok(aggregate.summary_recalled_count >= 1, "recalled count aggregated");
  });
});

test("summary routing signal: routed but NOT recalled marks the IR gap", () => {
  withStore((store) => {
    // Two distinct nodes. The travel node's summary carries an abstract word
    // ("plans") that its raw statement does not; the plans node's raw statement
    // DOES carry it, so base lexical retrieval pulls the plans node and skips
    // the travel node — the node-summary FTS still matches the travel node.
    store.remember({
      statement: "user booked a flight to Tokyo on 2026-06-15",
      nodeName: "travel",
      sourceActor: "user",
    });
    store.remember({
      statement: "user reviews quarterly business plans every week",
      nodeName: "plans",
      sourceActor: "user",
    });
    store.rebuildLeafBlocks();
    const travelNode = store.searchContext("tokyo", { limit: 1 }).results[0]!.node;
    assert.notEqual(travelNode.canonicalName, "plans", "the travel node is the target");
    store.setNodeSummary(
      travelNode.id,
      "the user's travel plans and tech preferences",
      "test-model",
      1,
    );

    const ctx = store.searchContext("plans", {
      limit: 8,
      leafBlockRouting: true,
      leafBlockRoutingMaxMembers: 12,
    });
    const trace = store.retrievalTrace(ctx.activeGraph!.id);
    assert.ok(trace, "trace persisted");
    const signal = (trace!.nodeRouteSignal ?? []).find((s) => s.nodeId === travelNode.id);
    assert.ok(signal, "the summary-routed travel node appears in the signal");
    assert.equal(signal!.routed, true);
    assert.equal(
      signal!.recalled,
      false,
      "summary-routed node missing from base results = IR gap (routed ∧ !recalled)",
    );
  });
});

test("trainRouter: triple-confirmed nodes learn at twice the base rate", () => {
  withStore((store) => {
    store.remember({ statement: "user booked a flight to Tokyo", nodeName: "alpha", sourceActor: "user" });
    store.remember({ statement: "user likes green tea", nodeName: "beta", sourceActor: "user" });
    const aNode = store.searchContext("tokyo", { limit: 1 }).results[0]!.node;
    const bNode = store.searchContext("green tea", { limit: 1 }).results[0]!.node;
    const query = "tokyo flight travel";
    // aNode is triple-confirmed (boosted lr), bNode is plain use.
    store.trainRouter(query, [aNode.id, bNode.id], 0.2, [aNode.id]);
    const readWeights = (nodeId: string): number[] => {
      const row = (
        (store as unknown as { db: import("node:sqlite").DatabaseSync }).db
          .prepare("SELECT weights_json FROM router_weights WHERE node_id = ?")
          .get(nodeId) as { weights_json: string }
      );
      return JSON.parse(row.weights_json) as number[];
    };
    // Cosine is scale-invariant: from a zero init, both nodes sit on the query
    // direction after one update regardless of lr. The boosted lr instead shows
    // up in the vector NORM (each update moves confirmed nodes farther).
    const norm = (v: readonly number[]): number =>
      Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    const normA = norm(readWeights(aNode.id));
    const normB = norm(readWeights(bNode.id));
    assert.ok(
      normA > normB,
      `confirmed node should move farther (normA=${normA.toFixed(3)} > normB=${normB.toFixed(3)})`,
    );
  });
});

test("summaryRouteGapReport: routed∧!recalled nodes surface as the IR gap", () => {
  withStore((store) => {
    store.remember({
      statement: "user booked a flight to Tokyo on 2026-06-15",
      nodeName: "travel",
      sourceActor: "user",
    });
    store.remember({
      statement: "user reviews quarterly business plans every week",
      nodeName: "plans",
      sourceActor: "user",
    });
    store.rebuildLeafBlocks();
    const travelNode = store.searchContext("tokyo", { limit: 1 }).results[0]!.node;
    store.setNodeSummary(
      travelNode.id,
      "the user's travel plans and tech preferences",
      "test-model",
      1,
    );
    // Two queries both gap the travel node (summary-routed, base misses it).
    store.searchContext("plans", { limit: 8, leafBlockRouting: true, leafBlockRoutingMaxMembers: 12 });
    store.searchContext("plans", { limit: 8, leafBlockRouting: true, leafBlockRoutingMaxMembers: 12 });
    const report = store.summaryRouteGapReport(10);
    const travel = report.find((r) => r.nodeId === travelNode.id);
    assert.ok(travel, "travel node appears in the gap report");
    assert.equal(travel!.routed, 2);
    assert.equal(travel!.recalled, 0);
    assert.equal(travel!.gap, 2);
    assert.equal(travel!.gapRatio, 1);
  });
});
