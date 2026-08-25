import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregate,
  aggregateByCategory,
  normalizeText,
  scoreQuestion,
} from "../../evals/retrieval/score.ts";

test("normalizeText matches the legacy audit normalization", () => {
  assert.equal(normalizeText("  Hello,   WORLD!! "), "hello world");
  assert.equal(normalizeText("café—2026/08/15"), "café 2026 08 15");
});

test("scoreQuestion ranks gold hits (gold-in-candidate)", () => {
  const scored = scoreQuestion(
    {
      category: "2",
      golds: ["I went to the LGBTQ support group on 7 May 2023", "missing evidence"],
      candidates: [
        ["Melanie: hey, how have you been?"],
        ["Caroline: I went to the LGBTQ support group on 7 May 2023."],
      ],
      contextText: "1. Caroline: I went to the LGBTQ support group on 7 May 2023.",
    },
    "gold-in-candidate",
  );
  assert.deepEqual(scored.goldRanks, [2, null]);
  assert.deepEqual(scored.legacyHits, [true, false]);
});

test("a hit on any candidate part (statement or evidence excerpt) counts", () => {
  const scored = scoreQuestion(
    {
      category: "x",
      golds: ["the exact source sentence"],
      candidates: [["summary that paraphrases", "… earlier text … the exact source sentence …"]],
    },
    "gold-in-candidate",
  );
  assert.deepEqual(scored.goldRanks, [1]);
});

test("scoreQuestion matches candidate inside a gold session blob (candidate-in-gold)", () => {
  const scored = scoreQuestion(
    {
      category: "single-session-user",
      golds: ["user: I graduated with a Business Administration degree\nassistant: congrats"],
      candidates: [
        ["unrelated memory"],
        ["I graduated with a Business Administration degree"],
      ],
    },
    "candidate-in-gold",
  );
  assert.deepEqual(scored.goldRanks, [2]);
});

test("aggregate computes recall@k, MRR and legacy rates", () => {
  const questions = [
    scoreQuestion(
      {
        category: "a",
        golds: ["g1", "g2"],
        candidates: [["g1 here"], ["g2 here"]],
        contextText: "g1 here g2 here",
      },
      "gold-in-candidate",
    ),
    scoreQuestion(
      { category: "a", golds: ["g3"], candidates: [["nothing"]], contextText: "nothing" },
      "gold-in-candidate",
    ),
    scoreQuestion(
      {
        category: "b",
        golds: ["g4"],
        candidates: [["x"], ["y"], ["g4"]],
        contextText: "x y",
        durationMs: 10,
      },
      "gold-in-candidate",
    ),
  ];
  const metrics = aggregate(questions, [1, 2, 20]);
  assert.equal(metrics.questions, 3);
  assert.equal(metrics.golds, 4);
  // golds hit: g1@1, g2@2, g3 miss, g4@3
  assert.equal(metrics.recallAt["1"], 1 / 4);
  assert.equal(metrics.recallAt["2"], 2 / 4);
  assert.equal(metrics.recallAt["20"], 3 / 4);
  assert.equal(metrics.mrrGold, (1 + 1 / 2 + 0 + 1 / 3) / 4);
  assert.equal(metrics.mrrQuestion, (1 + 0 + 1 / 3) / 3);
  assert.equal(metrics.anyEvidenceRate, 2 / 3);
  assert.equal(metrics.allEvidenceRate, 2 / 3);
  // legacy: q1 2/2 hits, q2 0, q3 0 (context lacks g4)
  assert.equal(metrics.legacy.anyEvidenceRate, 1 / 3);
  assert.equal(metrics.legacy.allEvidenceRate, 1 / 3);
  assert.equal(metrics.legacy.evidenceRecall, 2 / 4);
  assert.equal(metrics.latencyMs.mean, 10);
});

test("aggregate separates windowed any/all@k from full-window rates", () => {
  // Gold hit at rank 3 with maxK=2: counted in the full-window rates, not @2.
  const metrics = aggregate(
    [
      scoreQuestion(
        { category: "a", golds: ["g1"], candidates: [["x"], ["y"], ["g1"]] },
        "gold-in-candidate",
      ),
    ],
    [1, 2],
  );
  assert.equal(metrics.anyEvidenceRate, 1);
  assert.equal(metrics.allEvidenceRate, 1);
  assert.equal(metrics.anyEvidenceAtK, 0);
  assert.equal(metrics.allEvidenceAtK, 0);
  assert.equal(metrics.recallAt["2"], 0);
});

test("aggregateByCategory buckets per category with an overall entry", () => {
  const questions = [
    scoreQuestion({ category: "a", golds: ["g1"], candidates: [["g1"]] }, "gold-in-candidate"),
    scoreQuestion({ category: "b", golds: ["g2"], candidates: [["nope"]] }, "gold-in-candidate"),
  ];
  const byCategory = aggregateByCategory(questions, [20]);
  assert.equal(byCategory["overall"]!.recallAt["20"], 1 / 2);
  assert.equal(byCategory["a"]!.recallAt["20"], 1);
  assert.equal(byCategory["b"]!.recallAt["20"], 0);
});

test("questions without gold labels are excluded from rates", () => {
  const metrics = aggregate([
    scoreQuestion({ category: "a", golds: [], candidates: [["x"]] }, "gold-in-candidate"),
    scoreQuestion({ category: "a", golds: ["g"], candidates: [["g"]] }, "gold-in-candidate"),
  ]);
  assert.equal(metrics.questions, 2);
  assert.equal(metrics.questionsWithGolds, 1);
  assert.equal(metrics.recallAt["20"], 1);
});
