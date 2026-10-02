import assert from "node:assert/strict";
import test from "node:test";

import {
  checkRefinement,
  type TaskUnit,
  type CompiledTasks,
  type RefinementSpec,
  type RefinementConstraint,
} from "../../src/integration/task-semantics.ts";

/** A shape adapter can supply normalized resource identities without a patch envelope. */
function unit(id: string, writes: readonly string[], permission = true): TaskUnit {
  return {
    id,
    revision: "v1",
    index: id === "parent" ? 0 : 1,
    instruction: "produce a numeric artifact",
    patch: null,
    inputs: { files: [], dependencies: [] },
    effects: { effect: "isolated-artifact", operation: null, read: [], proposeWrite: writes },
    requires: [],
    waitEvent: null,
    obligations: permission ? ["permission-closure"] : [],
  };
}
function model(
  parentWrites: readonly string[],
  childWrites: readonly string[],
  permission = true,
): CompiledTasks {
  return {
    units: [unit("parent", parentWrites, permission), unit("child", childWrites, permission)],
    refusals: [],
    legal: true,
    digest: "normalized-control-model",
  };
}
const scope = [{ kind: "within-parent-writes", name: "numeric-resource-closure" }] as const;
function split(constraints: readonly RefinementConstraint[] = scope): RefinementSpec {
  return {
    parent: "parent",
    parts: ["child"],
    join: "child",
    obligations: { "permission-closure": ["child"] },
    constraints,
  };
}
function malformed(constraints: readonly unknown[]): RefinementSpec {
  return { ...split(), constraints } as unknown as RefinementSpec;
}

// Negative mappings use an explicit malformed-boundary cast, not a diagnostic suppression.
test("a declared write constraint rejects wider numeric resources without reading patch metadata", () => {
  const spec = split();
  const refusals = checkRefinement(model(["value:sum"], ["value:admin"]), spec);
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0]?.task, "child");
  assert.equal(refusals[0]?.field, "effects.proposeWrite");
  assert.equal(refusals[0]?.obligation, "permission-closure");
  assert.match(refusals[0]?.reason ?? "", /numeric-resource-closure/);
  assert.match(refusals[0]?.reason ?? "", /value:admin/);
});

test("a declared write constraint permits narrower opaque resources", () => {
  assert.deepEqual(
    checkRefinement(model(["value:sum", "value:label"], ["value:sum"]), split()),
    [],
  );
});

test("a parent's permission obligation cannot be silently lost by omitting its declared constraint", () => {
  const refusals = checkRefinement(model(["value:sum"], ["value:sum"]), split([]));
  assert.ok(
    refusals.some(
      (refusal) => refusal.field === "constraints" && refusal.obligation === "permission-closure",
    ),
  );
});

test("the mechanism does not enable a write rule a protocol did not declare or require", () => {
  assert.deepEqual(checkRefinement(model(["value:sum"], ["value:admin"], false), split([])), []);
});

test("a protocol chooses the rule's name, while its declared primitive remains the same", () => {
  const spec = split([{ kind: "within-parent-writes", name: "artifact-authority" }]);
  const refusals = checkRefinement(model([], ["value:sum"]), spec);
  assert.match(refusals[0]?.reason ?? "", /artifact-authority/);
});

test("an unsupported named primitive is refused at its declaration instead of ignored", () => {
  const spec = malformed([{ kind: "guess-permissions", name: "guessed-authority" }]);
  const refusals = checkRefinement(model([], []), spec);
  assert.ok(
    refusals.some(
      (refusal) =>
        refusal.field === "constraints.0.kind" && refusal.reason.includes("guessed-authority"),
    ),
  );
});

test("a missing constraint array, unnamed rule and non-object declaration are refused", () => {
  const missing = { ...split(), constraints: undefined } as unknown as RefinementSpec;
  assert.ok(
    checkRefinement(model([], []), missing).some((refusal) => refusal.field === "constraints"),
  );
  assert.ok(
    checkRefinement(model([], []), malformed([{ kind: "within-parent-writes", name: " " }])).some(
      (refusal) => refusal.field === "constraints.0.name",
    ),
  );
  assert.ok(
    checkRefinement(model([], []), malformed([null])).some(
      (refusal) => refusal.field === "constraints.0",
    ),
  );
});

test("aliases and duplicate names are refused at the declaration", () => {
  const aliased = malformed([{ kind: "within-parent-writes", name: "scope", enabled: true }]);
  assert.ok(
    checkRefinement(model([], []), aliased).some(
      (refusal) => refusal.field === "constraints.0.enabled",
    ),
  );
  const duplicate = split([
    { kind: "within-parent-writes", name: "scope" },
    { kind: "within-parent-writes", name: "scope" },
  ]);
  assert.ok(
    checkRefinement(model([], []), duplicate).some(
      (refusal) => refusal.field === "constraints.1.name",
    ),
  );
});
