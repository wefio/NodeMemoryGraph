// The advisory cost model's own properties. These are the checks that separate "measured" from
// "ran": the design's ordering depends on this model being an instrument, so a violated property is
// a broken instrument rather than a finding, and each one throws here.
//
// The last case is the one worth keeping: the model may not grow a quality term. A simulated pass
// rate would be exactly the thing the design forbids ("模拟的 token 或命中率不冒充实测"), and it
// would be tempting to add.
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertModelProperties,
  type CostParams,
  fusionAccounting,
  fusionVerdict,
  type PlanShape,
  planEdges,
  simulatePlan,
} from "./cost-model.ts";

const base: CostParams = {
  workMs: 8_000,
  rederiveMs: 6_000,
  hitRate: 0.5,
  verifyMs: 1_500,
  contextMsPerUnit: 1_200,
  coarseContextSaving: 0.5,
  sessionStartMs: 1_500,
  sessionStartMeasured: false,
  unitsPerSession: 2,
  slots: 4,
};

test("the model's own properties hold, and it throws instead of warning", () => {
  assertModelProperties(base);
  assertModelProperties({ ...base, slots: 1 });
  assertModelProperties({ ...base, hitRate: 0, rederiveMs: 0 });
});

test("one execution slot buys nothing, and splitting without slots is a loss", () => {
  const independent: PlanShape = { units: 4, density: 0, seed: 7 };
  const serial = simulatePlan(independent, { ...base, slots: 1 });
  assert.equal(serial.savedMs, 0, "one slot cannot overlap anything");
  assert.ok(
    serial.makespanMs > serial.coarseMs,
    "a split on one slot pays four session boundaries and buys no overlap",
  );
});

test("independent work on enough slots finishes in one unit plus one check per unit", () => {
  const independent: PlanShape = { units: 4, density: 0, seed: 7 };
  const wide = simulatePlan(independent, base);
  const perUnit =
    base.workMs + (1 - base.hitRate) * base.rederiveMs + base.contextMsPerUnit + base.verifyMs;
  assert.equal(wide.makespanMs, perUnit + 3 * base.verifyMs);
  assert.equal(wide.hostMs, 4 * base.verifyMs, "the host checks four candidates, one at a time");
  assert.ok(wide.makespanMs >= wide.criticalPathMs, "no schedule finishes below its critical path");
  assert.ok(wide.slotUtilisation > 0 && wide.slotUtilisation <= 1);
});

test("a chain gains nothing from splitting however many slots it has", () => {
  const chain: PlanShape = { units: 4, density: 1, seed: 7 };
  const chained = simulatePlan(chain, base);
  assert.equal(chained.savedMs, 0);
  assert.ok(chained.makespanMs > chained.coarseMs, "the coarse arm keeps its one session");
});

test("the turning point: independence pays, and a single dependency edge does not", () => {
  const gain = (shape: PlanShape) =>
    simulatePlan(shape, base).coarseMs - simulatePlan(shape, base).makespanMs;
  assert.ok(gain({ units: 4, density: 0, seed: 7 }) > 0, "independent units pay off");
  assert.ok(gain({ units: 2, density: 1, seed: 7 }) < 0, "one dependency edge is a chain");
  assert.ok(
    gain({ units: 8, density: 0, seed: 7 }) > gain({ units: 4, density: 0, seed: 7 }),
    "more independent units pay off more",
  );
});

test("the graph is derived from the seed, so a gain cannot come from a hand-picked shape", () => {
  const edges = planEdges({ units: 6, density: 0.5, seed: 11 });
  assert.deepEqual(edges, planEdges({ units: 6, density: 0.5, seed: 11 }));
  assert.equal(planEdges({ units: 6, density: 0, seed: 11 }).length, 0);
  assert.equal(
    planEdges({ units: 4, density: 1, seed: 11 }).length,
    6,
    "every forward edge exists",
  );
  assert.ok(
    edges.every(([from, to]) => from < to),
    "edges point forward, so the plan is acyclic",
  );
});

test("impossible input is refused rather than defaulted", () => {
  const shape: PlanShape = { units: 4, density: 0, seed: 7 };
  assert.throws(() => simulatePlan(shape, { ...base, slots: 0 }), /slots/);
  assert.throws(() => simulatePlan(shape, { ...base, hitRate: 1.5 }), /hit-rate/);
  assert.throws(() => simulatePlan(shape, { ...base, verifyMs: -1 }), /verify-ms/);
  assert.throws(() => planEdges({ units: 0, density: 0, seed: 1 }), /units/);
  assert.throws(() => planEdges({ units: 4, density: 2, seed: 1 }), /density/);
  assert.throws(() => simulatePlan(shape, { ...base, unitsPerSession: 0 }), /unitsPerSession/);
  assert.throws(() => simulatePlan(shape, { ...base, unitsPerSession: 1.5 }), /unitsPerSession/);
});

test("fusion books the shared startup once per session, not once per unit", () => {
  const shape: PlanShape = { units: 4, density: 0, seed: 7 };
  const fused = simulatePlan(shape, { ...base, unitsPerSession: 4 });
  const plain = simulatePlan(shape, base);
  assert.equal(fused.sharedStartupMs, base.sessionStartMs, "one session pays its startup once");
  assert.equal(
    fused.fusionSavedMs,
    3 * base.contextMsPerUnit,
    "four units in one session drop three boundaries",
  );
  assert.equal(fused.fusedMs, plain.makespanMs - 3 * base.contextMsPerUnit + base.sessionStartMs);
  // The same plan with a bound of two: two sessions, each paying its own startup and dropping one
  // boundary, and the two lines never collapse into one number.
  const pairs = simulatePlan(shape, { ...base, unitsPerSession: 2 });
  assert.equal(pairs.sharedStartupMs, 2 * base.sessionStartMs);
  assert.equal(pairs.fusionSavedMs, 2 * base.contextMsPerUnit);
});

test("a fusion bound of one unit removes no boundary and still pays the startup", () => {
  const shape: PlanShape = { units: 4, density: 0, seed: 7 };
  const none = simulatePlan(shape, { ...base, unitsPerSession: 1 });
  assert.equal(none.fusionSavedMs, 0, "a unit per session has no boundary to remove");
  assert.equal(none.fusedMs, none.makespanMs + 4 * base.sessionStartMs);
  assert.equal(
    fusionVerdict(fusionAccounting(shape, { ...base, unitsPerSession: 1 }), base),
    "none",
  );
});

test("an assumed session startup never reads as a gain", () => {
  const shape: PlanShape = { units: 4, density: 0, seed: 7 };
  const fusion = fusionAccounting(shape, { ...base, unitsPerSession: 4 });
  assert.equal(fusionVerdict(fusion, base), "unmeasured", "no run has priced the startup");
  assert.equal(fusionVerdict(fusion, { ...base, sessionStartMeasured: true }), "gain");
  const costly = fusionAccounting(shape, { ...base, unitsPerSession: 2, sessionStartMs: 9_000 });
  assert.equal(fusionVerdict(costly, { ...base, sessionStartMeasured: true }), "cost");
});

test("the model has no quality term: a simulated pass rate is not available to report", () => {
  const result = simulatePlan({ units: 4, density: 0.25, seed: 7 }, base) as unknown as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(result))
    assert.doesNotMatch(
      key,
      /quality|pass|accept|correct|success/i,
      `the cost model grew a ${key} term; cost only, or the design's caveat is false`,
    );
});
