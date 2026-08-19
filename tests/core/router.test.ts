import assert from "node:assert/strict";
import test from "node:test";
import { Router } from "../../src/core/router.ts";

/** Embedder spy that counts embed() calls so we can prove the router does not
 *  pay the embedding cost for nodes with no learned weights yet. */
class CountingEmbedder {
  model = "spy-v1";
  dimensions = 4;
  calls = 0;
  embed(_query: string): number[] {
    this.calls += 1;
    return [1, 0, 0, 0];
  }
}

test("router.score returns 0 for empty weights without embedding", () => {
  const embedder = new CountingEmbedder();
  const router = new Router(embedder);
  assert.equal(router.score("some query", []), 0);
  assert.equal(embedder.calls, 0, "empty weights must not trigger an embed call");
});

test("router.score embeds only when learned weights exist", () => {
  const embedder = new CountingEmbedder();
  const router = new Router(embedder);
  assert.equal(router.score("some query", [1, 0, 0, 0]), 1);
  assert.equal(embedder.calls, 1);
  // repeated calls still embed (weights are non-empty), matching cosine cost
  assert.equal(router.score("another query", [1, 0, 0, 0]), 1);
  assert.equal(embedder.calls, 2);
});

test("router.score is length-safe against dimension mismatch", () => {
  const embedder = new CountingEmbedder();
  const router = new Router(embedder);
  // different dimension than the embedder → cosineSimilarity returns 0, but
  // this is a real (non-empty) weights array so the embed does happen
  assert.equal(router.score("q", [1, 0, 0, 0, 0]), 0);
  assert.equal(embedder.calls, 1);
});
