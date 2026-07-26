import assert from "node:assert/strict";
import test from "node:test";

import { evaluateControllerGate } from "../../src/core/controller-gate.ts";

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

test("active/default eligibility requires both controller and retrieval gates", () => {
  const gate = evaluateControllerGate({
    ...healthyController,
    candidateRecall: 0.85,
  });

  assert.equal(gate.controllerGate.passed, true);
  assert.equal(gate.retrievalGate.passed, true);
  assert.deepEqual(gate.eligibility, {
    shadow: true,
    active: true,
    defaultPi: true,
  });
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
