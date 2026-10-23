// Clause-ablation helpers: the subset arms must fuse exactly like the recorded
// full arm, or the ablation describes a different mechanism.

import assert from "node:assert/strict";
import test from "node:test";

import {
  armPairStats,
  derivedPathCohorts,
  fuseByMaxScore,
  identityDiffCount,
  memberLists,
  memberListsByIndex,
  type Candidate,
} from "../../evals/omnimemeval/research/audits/clause-ablation.ts";
import { pairedComparison } from "../../evals/omnimemeval/research/audits/locomo-audit-shared.ts";

const candidate = (id: string, score: number, content = id): Candidate => ({ id, score, content });

test("fusion keeps the highest score per memory id", () => {
  const fused = fuseByMaxScore(
    [[candidate("a", 0.4), candidate("b", 0.9)], [candidate("a", 0.8)]],
    10,
  );
  assert.deepEqual(
    fused.map((item) => [item.id, item.score]),
    [
      ["b", 0.9],
      ["a", 0.8],
    ],
  );
});

test("fusion deduplicates by id and caps the page", () => {
  const fused = fuseByMaxScore(
    [
      [candidate("a", 0.1), candidate("b", 0.2), candidate("c", 0.3)],
      [candidate("c", 0.9), candidate("d", 0.05)],
    ],
    3,
  );
  assert.equal(fused.length, 3);
  assert.deepEqual(
    fused.map((item) => item.id),
    ["c", "b", "a"],
  );
});

test("fusion breaks score ties deterministically by id", () => {
  const first = fuseByMaxScore([[candidate("b", 0.5), candidate("a", 0.5)]], 10);
  const second = fuseByMaxScore([[candidate("a", 0.5), candidate("b", 0.5)]], 10);
  assert.deepEqual(
    first.map((item) => item.id),
    ["a", "b"],
  );
  assert.deepEqual(
    second.map((item) => item.id),
    ["a", "b"],
  );
});

test("member lists select only the requested derived paths, original first", () => {
  const raw = {
    B_full: [candidate("orig", 0.9)],
    derived100: [[candidate("content", 0.8)], [candidate("aspect", 0.7)]],
  };
  assert.deepEqual(
    memberLists(raw, []).map((list) => list.map((item) => item.id)),
    [["orig"]],
  );
  assert.deepEqual(
    memberLists(raw, ["content"]).map((list) => list.map((item) => item.id)),
    [["orig"], ["content"]],
  );
  assert.deepEqual(
    memberLists(raw, ["aspect"]).map((list) => list.map((item) => item.id)),
    [["orig"], ["aspect"]],
  );
  assert.deepEqual(
    memberLists(raw, ["content", "aspect"]).map((list) => list.map((item) => item.id)),
    [["orig"], ["content"], ["aspect"]],
  );
});

test("a missing derived path contributes an empty list rather than an error", () => {
  const raw = { B_full: [candidate("orig", 0.9)], derived100: [[candidate("content", 0.8)]] };
  assert.deepEqual(
    memberLists(raw, ["content", "aspect"]).map((list) => list.length),
    [1, 1, 0],
  );
});

test("the full subset reproduces a recorded full-arm list built the same way", () => {
  const raw = {
    B_full: [candidate("a", 0.5), candidate("b", 0.6)],
    derived100: [
      [candidate("b", 0.7), candidate("c", 0.4)],
      [candidate("d", 0.3), candidate("a", 0.2)],
    ],
  };
  const recorded = [
    candidate("b", 0.7),
    candidate("a", 0.5),
    candidate("c", 0.4),
    candidate("d", 0.3),
  ];
  const rebuilt = fuseByMaxScore(memberLists(raw, ["content", "aspect"]), 20);
  assert.deepEqual(
    rebuilt.map((item) => [item.id, item.score]),
    recorded.map((item) => [item.id, item.score]),
  );
});

test("member lists generalize to any number of derived clauses", () => {
  const c = (id: string) => candidate(id, 0.5);
  const raw = {
    B_full: [c("orig")],
    derived100: [[c("d0")], [c("d1")], [c("d2")], [c("d3")]],
  };
  assert.deepEqual(
    memberListsByIndex(raw, [0, 1, 2, 3]).map((list) => list.map((item) => item.id)),
    [["orig"], ["d0"], ["d1"], ["d2"], ["d3"]],
  );
  // An index the run does not carry contributes an empty list, not an error.
  assert.deepEqual(
    memberListsByIndex(raw, [0, 7]).map((list) => list.length),
    [1, 1, 0],
  );
});

test("identity diff count is zero when two arms never disagree", () => {
  const rows = [
    { id: "q1", plusContent: { hitPositions: [0, -1] }, plusBoth: { hitPositions: [0, -1] } },
    { id: "q2", plusContent: { hitPositions: [1, 2] }, plusBoth: { hitPositions: [1, 2] } },
  ];
  assert.equal(identityDiffCount(rows, "plusContent", "plusBoth"), 0);
  rows[1]!.plusBoth = { hitPositions: [1, -1] };
  assert.equal(identityDiffCount(rows, "plusContent", "plusBoth"), 1);
});

test("arm pair stats agree with the frozen pairedComparison", () => {
  const rows = [
    {
      id: "both-all",
      A: { hitPositions: [0, -1] },
      plusContent: { hitPositions: [0, -1] },
      plusBoth: { hitPositions: [0, 1] },
    },
    {
      id: "base-all",
      A: { hitPositions: [0, 1] },
      plusContent: { hitPositions: [0, 1] },
      plusBoth: { hitPositions: [0, -1] },
    },
    {
      id: "tie-all",
      A: { hitPositions: [0, 1] },
      plusContent: { hitPositions: [0, 1] },
      plusBoth: { hitPositions: [0, 1] },
    },
    {
      id: "excluded-minus-two",
      A: { hitPositions: [0] },
      plusContent: { hitPositions: [0] },
      plusBoth: { hitPositions: [0, -2] },
    },
    {
      id: "not-eligible",
      A: { hitPositions: [0] },
      plusContent: { hitPositions: [0] },
      plusBoth: { hitPositions: [0] },
    },
  ];
  const eligible = new Set(["both-all", "base-all", "tie-all", "excluded-minus-two"]);
  const mine = armPairStats(rows, eligible, "plusContent", "plusBoth");
  const frozen = pairedComparison(rows, "plusContent", "plusBoth", eligible);
  assert.equal(mine.n, frozen.n);
  assert.equal(mine.wins, frozen.wins);
  assert.equal(mine.losses, frozen.losses);
  assert.equal(mine.ties, frozen.ties);
  assert.equal(mine.allBefore, 2);
  assert.equal(mine.allAfter, 2);
});

test("cohorts split by how many derived clauses a question actually ran", () => {
  const rows = [
    { id: "one", category: 4, plusContent: { hitPositions: [0] }, plusBoth: { hitPositions: [0] } },
    {
      id: "two-multi",
      category: 1,
      plusContent: { hitPositions: [0, -1] },
      plusBoth: { hitPositions: [0, 1] },
    },
    {
      id: "two-reg",
      category: 2,
      plusContent: { hitPositions: [0] },
      plusBoth: { hitPositions: [0] },
    },
  ];
  const derivedPaths = new Map([
    ["one", 1],
    ["two-multi", 2],
    ["two-reg", 2],
  ]);
  const eligible = new Set(["one", "two-multi", "two-reg"]);
  const cohorts = derivedPathCohorts(rows, derivedPaths, eligible);
  assert.deepEqual(Object.keys(cohorts), ["1", "2"]);
  // With one derived clause the aspect clause never ran, so the arms must agree.
  assert.equal(cohorts["1"]!.n, 1);
  assert.equal(cohorts["1"]!.diffCount, 0);
  assert.equal(cohorts["1"]!.plusBothEqualsPlusContent, true);
  // With two, the third clause can act; the multi-hop slice is reported apart.
  assert.equal(cohorts["2"]!.n, 2);
  assert.equal(cohorts["2"]!.diffCount, 1);
  assert.equal(cohorts["2"]!.pairedPlusBothVsPlusContent.wins, 1);
  assert.equal(cohorts["2"]!.multiHop.n, 1);
  assert.equal(cohorts["2"]!.multiHop.wins, 1);
});
