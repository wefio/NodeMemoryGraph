import assert from "node:assert/strict";
import test from "node:test";

import { evaluateControllerGate } from "../../src/lab/controller-gate.ts";

const healthyController = {
  trainingCases: 12,
  candidateRecall: 0.6,
  baselineRecall: 0.5,
  learnedRecall: 0.51,
  baselinePrecision: 0.4,
  learnedPrecision: 0.4,
  baselineInferenceMs: 0.05,
  learnedInferenceMs: 0.1,
};

const healthyMatchedProduct = {
  cases: 12,
  baseline: {
    taskSuccessRate: 0.8,
    evidenceSufficiencyRate: 0.75,
    meanToolRounds: 2,
    meanTokens: 1_000,
    meanEndToEndLatencyMs: 1_000,
  },
  learned: {
    taskSuccessRate: 0.81,
    evidenceSufficiencyRate: 0.76,
    meanToolRounds: 2.2,
    meanTokens: 1_100,
    meanEndToEndLatencyMs: 1_150,
  },
};

test("controller can enter shadow mode when candidate retrieval is still inadequate", () => {
  const gate = evaluateControllerGate(healthyController);

  assert.equal(gate.controllerGate.passed, true);
  assert.equal(gate.retrievalGate.passed, false);
  assert.deepEqual(gate.eligibility, {
    shadow: true,
    active: false,
    defaultPi: false,
  });
});

test("active/default eligibility requires controller, retrieval, and matched product gates", () => {
  const gate = evaluateControllerGate({
    ...healthyController,
    candidateRecall: 0.85,
    matchedProduct: healthyMatchedProduct,
  });

  assert.equal(gate.controllerGate.passed, true);
  assert.equal(gate.retrievalGate.passed, true);
  assert.equal(gate.productGate.passed, true);
  assert.deepEqual(gate.eligibility, {
    shadow: true,
    active: true,
    defaultPi: true,
  });
});

test("good offline metrics remain shadow-only without matched product evidence", () => {
  const gate = evaluateControllerGate({
    ...healthyController,
    candidateRecall: 0.85,
  });

  assert.equal(gate.controllerGate.passed, true);
  assert.equal(gate.retrievalGate.passed, true);
  assert.equal(gate.productGate.hasMatchedEvidence, false);
  assert.equal(gate.productGate.passed, false);
  assert.deepEqual(gate.eligibility, {
    shadow: true,
    active: false,
    defaultPi: false,
  });
});

test("matched product gate rejects quality and end-to-end cost regressions", () => {
  const gate = evaluateControllerGate({
    ...healthyController,
    candidateRecall: 0.85,
    matchedProduct: {
      ...healthyMatchedProduct,
      learned: {
        ...healthyMatchedProduct.learned,
        taskSuccessRate: 0.6,
        evidenceSufficiencyRate: 0.5,
        meanToolRounds: 5,
        meanTokens: 2_000,
        meanEndToEndLatencyMs: 2_000,
      },
    },
  });

  assert.equal(gate.productGate.taskSuccessNotDegraded, false);
  assert.equal(gate.productGate.evidenceSufficiencyNotDegraded, false);
  assert.equal(gate.productGate.toolRoundsBounded, false);
  assert.equal(gate.productGate.tokensBounded, false);
  assert.equal(gate.productGate.endToEndLatencyBounded, false);
  assert.equal(gate.productGate.passed, false);
  assert.equal(gate.eligibility.active, false);
});

test("good candidate recall cannot hide a controller regression", () => {
  const gate = evaluateControllerGate({
    ...healthyController,
    candidateRecall: 0.9,
    learnedRecall: 0.3,
  });

  assert.equal(gate.retrievalGate.passed, true);
  assert.equal(gate.controllerGate.recallNotDegraded, false);
  assert.equal(gate.controllerGate.passed, false);
  assert.deepEqual(gate.eligibility, {
    shadow: false,
    active: false,
    defaultPi: false,
  });
});

test("controller gate enforces training and bounded inference independently", () => {
  const gate = evaluateControllerGate({
    ...healthyController,
    trainingCases: 3,
    learnedInferenceMs: 1.1,
  });

  assert.equal(gate.controllerGate.enoughTrainingCases, false);
  assert.equal(gate.controllerGate.inferenceCostBounded, false);
  assert.equal(gate.controllerGate.passed, false);
});

test("controller gate rejects paraphrase inflation and evidence leakage", () => {
  const gate = evaluateControllerGate({
    ...healthyController,
    trainingEvidenceTargets: 2,
    validationEvidenceTargets: 1,
    overlappingEvidenceTargets: 1,
  });

  assert.equal(gate.controllerGate.enoughEvidenceDiversity, false);
  assert.equal(gate.controllerGate.evidenceTargetsHeldOut, false);
  assert.equal(gate.controllerGate.passed, false);
  assert.equal(gate.eligibility.shadow, false);
});
