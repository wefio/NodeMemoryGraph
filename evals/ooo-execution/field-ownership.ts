/** Controlled field-ownership probe. Run from the repository root with --out <report.json>.
 * No providers, store mutation, or benchmark data. Observations do not select a storage policy. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import {
  compileTaskUnits,
  dispatchTasks,
  type CompiledTasks,
} from "../../src/integration/task-semantics.ts";
import { snapshotAnswer, unitLegality } from "../../src/integration/ooo-execution.ts";
import type { PatchTaskSpec, ProbePlan } from "../../src/integration/ooo-board.ts";

const { values } = parseArgs({ options: { out: { type: "string" } } });
if (!values.out) throw new Error("usage: --out <report.json>");
const FILE = "data/shared.txt";
const spec = (content = "1"): PatchTaskSpec => ({
  instruction: "produce a value",
  files: { [FILE]: content },
  editable: [FILE],
  verify: async () => "accept",
});
const plan: ProbePlan = [
  ["A", "v1", [], "isolated-artifact", null, null],
  ["B", "v1", [], "isolated-artifact", null, null],
];
let controlledModels = 0;
function compiled(plan: ProbePlan, specs?: Record<string, PatchTaskSpec>): CompiledTasks {
  const result = compileTaskUnits({ plan, specs });
  if (!result.legal) throw new Error(JSON.stringify(result.refusals));
  controlledModels++;
  return result;
}
const units = compiled(plan, { A: spec(), B: spec() });
const tasks = dispatchTasks(units.units, {});
const overlapping = unitLegality(tasks, 2);
assert.deepEqual(
  units.units.map((unit) => unit.effects.proposeWrite),
  [[FILE], [FILE]],
);
assert.deepEqual(overlapping.legal, ["A", "B"]);
const changedEffect = unitLegality(
  tasks.map((task) => (task.id === "B" ? { ...task, effect: "local-write" } : task)),
  2,
);
assert.deepEqual(changedEffect.legal, ["A"]);
assert.ok(
  changedEffect.units.find((unit) => unit.id === "B")?.reasons.includes("effect-not-startable"),
);

const changedBytes = compiled(plan, { A: spec("2"), B: spec() });
const changedByteLegality = unitLegality(dispatchTasks(changedBytes.units, {}), 2);
assert.notEqual(units.units[0]!.patch!.digest, changedBytes.units[0]!.patch!.digest);
assert.deepEqual(changedByteLegality.legal, overlapping.legal);

const dependentPlan: ProbePlan = [plan[0]!, ["B", "v1", ["A"], "isolated-artifact", null, null]];
const dependent = compiled(dependentPlan, { A: spec(), B: spec() });
const beforeDependency = unitLegality(dispatchTasks(dependent.units, {}), 2);
const afterDependency = unitLegality(
  dispatchTasks(dependent.units, {
    artifacts: { A: "a-value" },
    verdicts: { A: { digest: "a-value", verdict: "accepted" } },
  }),
  2,
);
assert.deepEqual(beforeDependency.legal, ["A"]);
assert.deepEqual(afterDependency.legal, ["B"]);

const operations = (["double", "sum"] as const).map((operation) => {
  const model = compiled([["P", "4", [], "read-only", null, operation]]);
  return {
    operation,
    legal: unitLegality(dispatchTasks(model.units, {}), 1).legal,
    answer: snapshotAnswer({ operation, input: "4", dependencies: {} }),
  };
});
assert.deepEqual(
  operations.map((row) => row.legal),
  [["P"], ["P"]],
);
assert.deepEqual(
  operations.map((row) => row.answer),
  ["8", "0"],
);

const sources = [
  "src/integration/task-semantics.ts",
  "src/integration/ooo-execution.ts",
  "src/integration/ooo-patch.ts",
];
const report = {
  measuredAt: new Date().toISOString(),
  baseRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sources: sources.map((path) => ({
    path,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  })),
  controlledModels,
  scope:
    "pure Task-Unit model/eligibility and snapshot evaluator; no live providers or protocol migration",
  overlappingProposalPaths: {
    writes: units.units.map((unit) => unit.effects.proposeWrite),
    effects: tasks.map((task) => task.effect),
    legal: overlapping.legal,
    changedEffectLegal: changedEffect.legal,
    changedEffectReasons: changedEffect.units,
  },
  changedInputBytes: {
    beforeDigest: units.units[0]!.patch!.digest,
    afterDigest: changedBytes.units[0]!.patch!.digest,
    beforeLegal: overlapping.legal,
    afterLegal: changedByteLegality.legal,
  },
  declaredDependency: {
    beforeAccepted: beforeDependency.legal,
    afterAccepted: afterDependency.legal,
  },
  operations,
};
assert.equal(report.sources.length, 3);
writeFileSync(values.out, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    output: values.out,
    measuredAt: report.measuredAt,
    models: report.controlledModels,
    sources: report.sources.length,
  }),
);
