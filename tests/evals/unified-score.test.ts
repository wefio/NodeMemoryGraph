import assert from "node:assert/strict";
import test from "node:test";

import {
  binaryRowScore,
  continuousRowScore,
  scoreEvidenceIds,
} from "../../evals/official/unified-score.ts";

test("binary and continuous task scores retain different success semantics", () => {
  assert.deepEqual(binaryRowScore(1), { taskScore: 1, taskSuccess: true, evidence: null });
  assert.deepEqual(binaryRowScore(0), { taskScore: 0, taskSuccess: false, evidence: null });
  assert.deepEqual(continuousRowScore(1), {
    taskScore: 1,
    taskSuccess: null,
    evidence: null,
  });
});

test("evidence ID score distinguishes any, all, and fractional recall", () => {
  assert.deepEqual(scoreEvidenceIds(["e2", "noise"], ["e1", "e2"]), {
    kind: "id",
    any: 1,
    all: 0,
    recall: 0.5,
  });
  assert.equal(scoreEvidenceIds([], []), null);
  assert.equal(scoreEvidenceIds(null, ["e1"]), null);
});
