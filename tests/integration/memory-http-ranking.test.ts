import assert from "node:assert/strict";
import test from "node:test";

import { mergePendingHttpRows, rankHttpRows } from "../../src/integration/memory-http-ranking.ts";

test("HTTP page ranking sorts by score and breaks ties by record ID before truncating", () => {
  assert.deepEqual(
    rankHttpRows(
      [
        { id: "b", score: 4 },
        { id: "higher", score: 5 },
        { id: "a", score: 4 },
      ],
      2,
    ),
    [
      { id: "higher", score: 5 },
      { id: "a", score: 4 },
    ],
  );
});

test("pending evidence is scored across the entire window before applying top_k", async () => {
  const newest = { id: "newer", score: 0, content: "An unrelated turn." };
  const match = { id: "older", score: 0, content: "The copper falcon arrived." };
  const { results, usedVectors } = await mergePendingHttpRows({
    waiting: [newest, match],
    features: [["copper falcon", "FALCON"]],
    candidates: [{ id: "folded", score: 1, content: "A folded result." }],
    topK: 1,
  });
  assert.deepEqual(results, [{ ...match, score: 2 }]);
  assert.equal(match.score, 0);
  assert.equal(usedVectors, false);
});

test("an append-only clause retains its best evidence without taking a page slot", async () => {
  const supplemental = { id: "supplement", score: 0, content: "Timeline planning details." };
  const direct = { id: "primary", score: 0, content: "A budget decision." };
  const appendedById = new Map([[supplemental.id, { ...supplemental, score: 3 }]]);
  const contributions = [{ contributed: 0 }, { contributed: 0 }];
  const { results } = await mergePendingHttpRows({
    waiting: [supplemental, direct],
    features: [["budget"], ["timeline planning"]],
    candidates: [],
    topK: 1,
    appendedById,
    appendOnly: [false, true],
    contributions,
  });
  assert.deepEqual(results, [{ ...direct, score: 1 }]);
  assert.deepEqual([...appendedById.values()], [{ ...supplemental, score: 3 }]);
  assert.deepEqual(contributions, [{ contributed: 1 }, { contributed: 1 }]);
});

test("pending ranking embeds only missing and stale vectors in one batch with unique query features", async () => {
  const calls: string[][] = [];
  const cached = {
    id: "cached",
    content: "cached text",
    score: 0,
    vector: [1, 0],
    vector_model: "current",
  };
  const stale = {
    id: "stale",
    content: "stale text",
    score: 0,
    vector: [1, 0],
    vector_model: "old",
  };
  const missing = { id: "missing", content: "missing text", score: 0 };
  const vectors = new Map([
    ["query", [1, 0]],
    ["stale text", [0, 1]],
    ["missing text", [0.6, 0.8]],
  ]);
  const outcome = await mergePendingHttpRows({
    waiting: [cached, stale, missing],
    features: [["query", "query"]],
    candidates: [],
    topK: 3,
    client: {
      indexId: "current",
      async embedQueries(texts) {
        calls.push([...texts]);
        return texts.map((text) => vectors.get(text)!);
      },
    },
  });
  assert.deepEqual(calls, [["query", "stale text", "missing text"]]);
  assert.deepEqual(
    outcome.results.map(({ id }) => id),
    ["cached", "missing", "stale"],
  );
  assert.equal(outcome.usedVectors, true);
});

test("an embedding failure preserves the already retrieved results", async () => {
  const candidates = [{ id: "folded", score: 4, content: "An available result." }];
  const outcome = await mergePendingHttpRows({
    waiting: [{ id: "pending", score: 0, content: "Pending evidence." }],
    features: [["query"]],
    candidates,
    topK: 1,
    client: {
      indexId: "fixture",
      async embedQueries() {
        throw new Error("Fixture provider timed out");
      },
    },
  });
  assert.deepEqual(outcome, { results: candidates, usedVectors: false });
});
