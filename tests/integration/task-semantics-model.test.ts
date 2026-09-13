/**
 * The offline model is the compiler's first consumer, so these tests assert what the
 * comparison is for: that the ordered mode is the plan order and nothing else, that the
 * out-of-order mode is the dependency-closed order freedom, and that fusion's freedom is
 * paid for in rollbacks when a dependency was not accepted — never claimed as free.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MODEL_UNITS,
  UNMODELLED_BY_MODEL,
  compareModes,
  type ModelInput,
} from "../../src/integration/task-semantics-model.ts";
import type { PatchTaskSpec, ProbePlan } from "../../src/integration/ooo-board.ts";

const verify = async () => "accept" as const;
const spec = (): PatchTaskSpec => ({
  instruction: "Rename byId to planIndex in nextTask only.",
  files: { "src/integration/ooo-execution.ts": "export const planIndex = 1;\n" },
  editable: ["src/integration/ooo-execution.ts"],
  verify,
});

const dependent: ProbePlan = [
  ["P", "4", [], "isolated-artifact", null, null],
  ["D", "5", ["P"], "read-only", null, "double"],
];
const independent: ProbePlan = [
  ["A", "1", [], "read-only", null, null],
  ["B", "1", [], "read-only", null, null],
];

const input = (overrides: Partial<ModelInput> = {}): ModelInput => ({
  plan: dependent,
  specs: { P: spec() },
  outcomes: { P: "accepted", D: "accepted" },
  ...overrides,
});

function summary(input: ModelInput) {
  const report = compareModes(input);
  return Object.fromEntries(report.comparison.map((entry) => [entry.mode, entry]));
}

test("the ordered mode is the declared plan order and nothing else", () => {
  const report = compareModes(input());
  const ordered = report.plans.filter((plan) => plan.mode === "ordered");
  assert.equal(ordered.length, 1);
  assert.deepEqual(ordered[0]!.order, ["P", "D"]);
  assert.equal(summary(input()).ordered!.orders, 1);
  assert.deepEqual(report.refused, undefined);
  const free = input({ plan: independent, specs: {}, outcomes: { A: "accepted", B: "accepted" } });
  assert.equal(summary(free).ordered!.orders, 1, "the baseline never gains order freedom");
  assert.equal(summary(free)["out-of-order"]!.orders, 2);
});

test("the out-of-order mode is dependency-closed order freedom", () => {
  const same = summary(input());
  assert.equal(same["out-of-order"]!.orders, 1, "D still cannot settle before P");
  assert.equal(same["out-of-order"]!.minRollbacks, 0);

  const free = summary(
    input({ plan: independent, specs: {}, outcomes: { A: "accepted", B: "accepted" } }),
  );
  assert.equal(free["out-of-order"]!.orders, 2, "independent units settle in either order");
  assert.deepEqual([free["out-of-order"]!.minWaits, free["out-of-order"]!.maxWaits], [0, 0]);
});

test("fusion trades the wait for a speculative start when the dependency is accepted", () => {
  const fused = summary(input()).fused!;
  assert.equal(fused.orders, 2);
  assert.equal(fused.minWaits, 0, "one order starts D before P settles");
  assert.equal(fused.maxWaits, 1, "the other order waits for the verdict");
  assert.equal(fused.maxRollbacks, 0, "P was accepted, so nothing was voided");
  const speculative = compareModes(input()).plans.find((plan) => plan.order[0] === "D")!;
  assert.equal(speculative.waits, 0);
  assert.deepEqual(speculative.accepted, ["D", "P"]);
});

test("a dependency that is not accepted makes fusion pay a rollback and a retry", () => {
  const rejected = input({ outcomes: { P: "rejected", D: "accepted" } });
  const fused = summary(rejected).fused!;
  assert.equal(fused.minRollbacks, 0, "fusion may still choose to wait");
  assert.equal(fused.maxRollbacks, 1, "and the speculative order pays for it");
  assert.deepEqual([fused.minWaits, fused.maxWaits], [0, 1], "waiting is the other branch");
  const speculative = compareModes(rejected).plans.find((plan) => plan.order[0] === "D")!;
  assert.equal(speculative.rollbacks, 1);
  assert.equal(speculative.retries, 1);
  assert.deepEqual(speculative.accepted, [], "D cannot be accepted on a rejected dependency");
  const waited = summary(rejected)["out-of-order"]!;
  assert.deepEqual(
    [waited.minRollbacks, waited.maxRollbacks],
    [0, 0],
    "the out-of-order mode never rolls back; it only waits",
  );
});

test("the comparison is deterministic and does not mutate its input", () => {
  const first = input();
  const before = JSON.stringify(first);
  assert.equal(compareModes(first).digest, compareModes(input()).digest);
  assert.equal(JSON.stringify(first), before);
});

test("the model refuses a plan that is not legal and one above its cap, by name", () => {
  const illegal = compareModes(
    input({
      plan: [["A", "1", ["ghost"], "read-only", null, null]] as unknown as ProbePlan,
      specs: {},
    }),
  );
  assert.match(illegal.refused ?? "", /1 refusal/u);
  assert.deepEqual(illegal.plans, []);

  const five: ProbePlan = ["A", "B", "C", "D2", "E"].map((id) => [
    id,
    "1",
    [],
    "read-only",
    null,
    null,
  ]) as unknown as ProbePlan;
  const capped = compareModes(input({ plan: five, specs: {}, outcomes: {} }));
  assert.match(capped.refused ?? "", new RegExp(`cap of ${MAX_MODEL_UNITS}`, "u"));
  assert.deepEqual(capped.comparison, []);
});

test("what the model does not cover is named rather than silently absent", () => {
  assert.deepEqual(UNMODELLED_BY_MODEL, ["external-waits", "real-verification", "wall-clock"]);
});
