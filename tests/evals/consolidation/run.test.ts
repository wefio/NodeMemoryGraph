import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  consolidationEligible,
  contradictionsToRetract,
  evaluateLocomoConsolidation,
  minimumPositiveVotes,
  posteriorAfterOutcomes,
} from "../../../evals/consolidation/run.ts";
import { DEFAULT_STG_CONSOLIDATION_POLICY } from "../../../src/integration/config.ts";

test("default zero-annotation prior needs five independent positive outcomes", () => {
  assert.equal(minimumPositiveVotes(0.5, DEFAULT_STG_CONSOLIDATION_POLICY), 5);
  assert.equal(
    consolidationEligible(posteriorAfterOutcomes(0.5, 4, 0), DEFAULT_STG_CONSOLIDATION_POLICY),
    false,
  );
  assert.equal(
    consolidationEligible(posteriorAfterOutcomes(0.5, 5, 0), DEFAULT_STG_CONSOLIDATION_POLICY),
    true,
  );
  assert.equal(contradictionsToRetract(0.5, 5, DEFAULT_STG_CONSOLIDATION_POLICY), 2);
});

test("LoCoMo audit deduplicates evidence within a task and reports repeated coverage", () => {
  const directory = join(tmpdir(), `nmg-consolidation-eval-${process.pid}-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "locomo.json");
  const qa = Array.from({ length: 5 }, (_, index) => ({
    question_id: `q${index}`,
    question: `question ${index}`,
    answer: "answer",
    evidence: index === 0 ? ["d1", "d1"] : ["d1"],
  }));
  writeFileSync(
    path,
    JSON.stringify([{ sample_id: "sample", conversation: {}, qa }]),
    "utf8",
  );
  try {
    const report = evaluateLocomoConsolidation(path);
    assert.equal(report.cases, 5);
    assert.equal(report.uniqueOfficialEvidence, 1);
    assert.equal(report.repeatedOfficialEvidence, 1);
    assert.equal(report.eligibleOfficialEvidence, 1);
    assert.equal(report.coverage.allOfficialEvidence, 1);
    assert.equal(report.reversalStress.oneContradictionRetracts, 0);
    assert.deepEqual(report.reversalStress.contradictionsNeededHistogram, { "2": 1 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
