import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../../src/core/store.ts";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-leaf-summaries-"));
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

test("pendingLeafSummaries: empty until blocks are built, then one task per block", () => {
  withStore((store) => {
    writeThree(store);
    assert.equal(store.pendingLeafSummaries().length, 0);
    store.rebuildLeafBlocks();
    const tasks = store.pendingLeafSummaries();
    assert.equal(tasks.length, 1);
    const task = tasks[0]!;
    assert.equal(task.nodeName, "travel and taste");
    assert.equal(task.statements.length, 3);
    assert.ok(task.membersKey.startsWith("3:"));
    assert.ok(task.statements.some((s) => s.includes("neovim")));
  });
});

test("setLeafSummary: clears pending, rejects stale fingerprints", () => {
  withStore((store) => {
    writeThree(store);
    store.rebuildLeafBlocks();
    const task = store.pendingLeafSummaries()[0]!;
    assert.equal(store.setLeafSummary(task.blockId, "a summary", "test-model", "bogus-key"), false);
    assert.equal(store.pendingLeafSummaries().length, 1);
    assert.equal(
      store.setLeafSummary(task.blockId, "a summary", "test-model", task.membersKey),
      true,
    );
    assert.equal(store.pendingLeafSummaries().length, 0);
  });
});

test("pendingLeafSummaries: membership change re-pends the block", () => {
  withStore((store) => {
    writeThree(store);
    store.rebuildLeafBlocks();
    const task = store.pendingLeafSummaries()[0]!;
    store.setLeafSummary(task.blockId, "a summary", "test-model", task.membersKey);
    store.remember({
      statement: "user dislikes cilantro",
      nodeName: "travel and taste",
      sourceActor: "user",
    });
    store.rebuildLeafBlocks();
    // Block ids are content-addressed: the new member set is a new block
    // without a summary, so it is pending again.
    assert.equal(store.pendingLeafSummaries().length, 1);
  });
});

test("routeLeafBlocksByFts: summary-only terms match the block, not its members", () => {
  withStore((store) => {
    writeThree(store);
    store.rebuildLeafBlocks();
    // Nothing indexed yet: routing is empty even for a member term.
    assert.equal(store.routeLeafBlocksByFts("neovim").length, 0);
    const task = store.pendingLeafSummaries()[0]!;
    store.setLeafSummary(
      task.blockId,
      "quixotic zebra anthology: dining, travel, tooling preferences",
      "test-model",
      task.membersKey,
    );
    const hits = store.routeLeafBlocksByFts("zebra anthology");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.blockId, task.blockId);
  });
});

test("searchContext leafBlockRouting: opt-in appends block members verbatim", () => {
  withStore((store) => {
    const ids = writeThree(store);
    store.rebuildLeafBlocks();
    const task = store.pendingLeafSummaries()[0]!;
    store.setLeafSummary(
      task.blockId,
      "zebra index terms, tooling: neovim",
      "test-model",
      task.membersKey,
    );

    const off = store.searchContext("zebra");
    assert.equal(off.results.length, 0);

    const on = store.searchContext("zebra", { leafBlockRouting: true });
    assert.equal(on.results.length, 3);
    for (const result of on.results) {
      assert.ok(ids.includes(result.memory.id));
      assert.equal(result.leafBlockId, task.blockId);
    }

    // A member matched directly (its own FTS row) is not duplicated when the
    // block summary also matches: the append skips already-ranked members.
    const dup = store.searchContext("neovim", { leafBlockRouting: true });
    const neovimHits = dup.results.filter((r) => r.memory.statement.includes("neovim"));
    assert.equal(neovimHits.length, 1);
    assert.equal(dup.results.length, 3);
  });
});

test("leafEmbeddingDocuments prefers the semantic summary when present", () => {
  withStore((store) => {
    writeThree(store);
    store.rebuildLeafBlocks();
    const structural = store.leafEmbeddingDocuments();
    assert.equal(structural.length, 1);
    assert.ok(!structural[0]!.text.includes("zebra"));
    const task = store.pendingLeafSummaries()[0]!;
    store.setLeafSummary(task.blockId, "zebra semantic text", "test-model", task.membersKey);
    const semantic = store.leafEmbeddingDocuments();
    assert.ok(semantic[0]!.text.includes("zebra semantic text"));
  });
});
