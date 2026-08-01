import assert from "node:assert/strict";
import test from "node:test";

import {
  propagateEdgeActivation,
  relationActivationDefaults,
  updateRelationStrength,
} from "../../src/core/edge-activation.ts";
import type { NodeRelation } from "../../src/core/types.ts";

function relation(overrides: Partial<NodeRelation> = {}): NodeRelation {
  return {
    id: "r1",
    sourceNodeId: "a",
    targetNodeId: "b",
    type: "depends_on",
    evidenceIds: [],
    residence: "ltg",
    status: "consolidated",
    stability: 1,
    strength: 0.8,
    direction: "source->target",
    fanBudget: true,
    activationRule: "conductive",
    consolidationSource: "explicit",
    consolidatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("relation defaults separate directed, symmetric, and regulatory edges", () => {
  assert.deepEqual(relationActivationDefaults("depends_on"), {
    activationRule: "conductive",
    direction: "source->target",
    fanBudget: true,
  });
  assert.equal(relationActivationDefaults("related_to").direction, "both");
  assert.equal(relationActivationDefaults("contradicts").activationRule, "regulatory");
  assert.equal(relationActivationDefaults("derived_from").fanBudget, false);
});

test("bounded propagation follows direction and never mutates relations", () => {
  const edge = relation();
  const before = structuredClone(edge);
  const forward = propagateEdgeActivation(new Map([["a", 1]]), [edge], { maxHops: 1 });
  const reverse = propagateEdgeActivation(new Map([["b", 1]]), [edge], { maxHops: 1 });

  assert.ok((forward.nodeActivations.get("b") ?? 0) > 0);
  assert.equal(reverse.nodeActivations.get("a") ?? 0, 0);
  assert.deepEqual(edge, before);
});

test("fan-out dilution shares a fixed source budget", () => {
  const one = propagateEdgeActivation(new Map([["a", 1]]), [relation()], { maxHops: 1 });
  const many = propagateEdgeActivation(
    new Map([["a", 1]]),
    [
      relation(),
      relation({ id: "r2", targetNodeId: "c" }),
      relation({ id: "r3", targetNodeId: "d" }),
    ],
    { maxHops: 1 },
  );
  assert.ok((many.nodeActivations.get("b") ?? 0) < (one.nodeActivations.get("b") ?? 0));
});

test("regulatory activation is visible but does not diffuse", () => {
  const result = propagateEdgeActivation(
    new Map([["a", 1]]),
    [relation({ type: "contradicts", direction: "both", activationRule: "regulatory" })],
    { maxHops: 2 },
  );
  assert.equal(result.nodeActivations.get("b") ?? 0, 0);
  assert.equal(result.edges[0]?.channel, "regulatory");
});

test("prediction-error learning is bounded and blocks redundant strength growth", () => {
  assert.ok(updateRelationStrength(0.2, 1, 0.2) > 0.2);
  assert.equal(updateRelationStrength(0.8, 1, 1), 0.8);
  assert.ok(updateRelationStrength(0.8, 0, 0.8) < 0.8);
  assert.equal(updateRelationStrength(1, 1, 0), 1);
});
