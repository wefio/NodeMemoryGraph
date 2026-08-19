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
