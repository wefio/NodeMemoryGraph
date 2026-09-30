import assert from "node:assert/strict";
import test from "node:test";

import { rerankEqualScoresByQueryCoverage } from "../../../src/core/store/search-ranking.ts";

test("query coverage resolves lexical score ties without crossing score boundaries", () => {
  const candidates = [
    { id: "partial", score: 4, text: "Atlas project notes" },
    { id: "complete", score: 4, text: "Atlas project uses SQLite" },
    { id: "lower", score: 2, text: "Atlas project uses SQLite" },
  ];
  const rank = (items: typeof candidates) =>
    rerankEqualScoresByQueryCoverage(
      "Atlas project SQLite",
      items,
      (item) => item.score,
      (item) => item.text,
    );
  const ranked = rank(candidates);
  assert.deepEqual(
    ranked.map((item) => item.id),
    ["complete", "partial", "lower"],
  );
  assert.deepEqual(rank(ranked), ranked, "reranking is stable on repeated calls");
  assert.deepEqual(
    candidates.map((item) => item.id),
    ["partial", "complete", "lower"],
  );
});
