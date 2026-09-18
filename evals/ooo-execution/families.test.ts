// The two task families the granularity arms run, checked offline and with no model: the instrument's
// own answers have to be accepted by both plans - one unit over the whole task, or four units where
// the last one waits for the three builders - and a wrong answer has to be rejected by the frozen
// checks.
//
// This is the F2c/F3 pair. The report family is the instrument's own; the pipeline family is held out
// of it, so a plan that only works on the family it was built against cannot pass here. The two specs
// of each family differ only in granularity, so a difference between the arms is the plan's and not
// the task's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { cannedWorker, runPlan, specFrom, type SpecFile } from "./plan-driver.ts";

/** Each family: its directory, the one unit the coarse plan declares, and the four of the fine one
 *  in plan order - the last of which is the summary that waits for the other three. */
const FAMILIES = [
  {
    name: "report",
    dir: "evals/ooo-execution/fixtures/report",
    coarseUnit: "report",
    fineUnits: ["alpha", "beta", "gamma", "summary"],
    summary: "summary",
  },
  {
    name: "pipeline",
    dir: "evals/ooo-execution/fixtures/pipeline",
    coarseUnit: "pipeline",
    fineUnits: ["normalize", "scale", "total", "summarize"],
    summary: "summarize",
  },
] as const;

const read = (dir: string, name: string): SpecFile =>
  JSON.parse(readFileSync(resolve(dir, name), "utf8")) as SpecFile;

for (const family of FAMILIES) {
  const coarse = read(family.dir, "coarse.spec.json");
  const fine = read(family.dir, "fine.spec.json");

  test(`${family.name}: one plan is the other's work at another granularity`, () => {
    assert.deepEqual(
      Object.keys(coarse.units),
      [family.coarseUnit],
      "the coarse plan is a single unit over the whole task",
    );
    assert.deepEqual(Object.keys(fine.units), family.fineUnits);
    assert.deepEqual(
      fine.plan.map((row) => row.id),
      family.fineUnits,
    );
    assert.deepEqual(
      fine.plan.find((row) => row.id === family.summary)?.dependencies,
      family.fineUnits.slice(0, 3),
      "the summary depends on all three builders, which is what makes the granularity real",
    );
    assert.deepEqual(
      Object.values(fine.units)
        .flatMap((unit) => unit.editable)
        .sort(),
      coarse.units[family.coarseUnit]!
        .editable.slice()
        .sort(),
      "the fine plan's units cover exactly the files the coarse unit may edit",
    );
  });

  test(`${family.name}: both plans accept the instrument's answers, and the same composed ones`, async () => {
    const arms = [
      { name: "coarse", file: coarse, slots: 1, units: 1 },
      { name: "fine", file: fine, slots: 1, units: 4 },
      { name: "fine", file: fine, slots: 2, units: 4 },
    ];
    const seen: { name: string; slots: number; units: number; host: number }[] = [];
    for (const arm of arms) {
      const run = await runPlan(specFrom(arm.file, cannedWorker(arm.file), arm.slots));
      assert.deepEqual(run.incomplete, [], `${arm.name}/${arm.slots}: ${run.incomplete.join("; ")}`);
      assert.deepEqual(
        run.units.map((unit) => unit.verdict),
        run.units.map(() => "accepted"),
        `${arm.name}/${arm.slots}: a correct answer must be accepted`,
      );
      assert.equal(
        run.parent?.verdict,
        "accept",
        `${arm.name}/${arm.slots}: the composed check sees every unit's work, not the last unit's ` +
          "frozen copies of its siblings",
      );
      assert.equal(run.units.length, arm.units);
      seen.push({ name: arm.name, slots: arm.slots, units: run.units.length, host: run.hostChecks });
    }
    // The composed acceptance is the same one in both plans - the same frozen checks over the same
    // frozen files - so the granularity is the only thing the arms differ in.
    assert.deepEqual(
      coarse.parentChecks,
      fine.parentChecks,
      "both plans are accepted by the same composed check",
    );
    assert.deepEqual(
      seen.map((arm) => [arm.units, arm.host]),
      [
        [1, 1],
        [4, 4],
        [4, 4],
      ],
      `the plans kept their own number of units: ${JSON.stringify(seen)}`,
    );
  });

  test(`${family.name}: a wrong answer fails the unit's own check, and the composition with it`, async () => {
    const first = family.fineUnits[0];
    const unit = fine.units[first]!;
    const editable = unit.editable[0]!;
    const wrong: SpecFile = {
      ...fine,
      units: {
        ...fine.units,
        [first]: {
          ...unit,
          canned: { ...unit.canned, [editable]: `${family.dir}/${first}-wrong.canned.ts` },
        },
      },
    };
    const run = await runPlan(specFrom(wrong, cannedWorker(wrong), 1));
    assert.equal(
      run.units.find((unit) => unit.taskId === first)?.verdict,
      "rejected",
      "the frozen check rejects the wrong answer, so acceptance is the check's judgement",
    );
    assert.deepEqual(
      run.order,
      [first],
      "a rejected attempt keeps its claim, so the plan does not move on to the next unit",
    );
    assert.ok(
      run.incomplete.some((entry) => entry.startsWith(first)),
      `incomplete: ${JSON.stringify(run.incomplete)}`,
    );
    assert.equal(
      run.parent?.verdict,
      "reject",
      "the composition cannot accept without the builder its summary needs",
    );
  });

  test(`${family.name}: a unit nothing checks is refused rather than accepted on nothing`, () => {
    const first = family.fineUnits[0];
    const unit = fine.units[first]!;
    const unchecked: SpecFile = {
      ...fine,
      units: {
        ...fine.units,
        // The same unit without its own checks: a unit is checked by what it declares, or by the
        // spec's own list, and having neither is a refusal rather than a unit accepted on nothing.
        [first]: {
          instruction: unit.instruction,
          editable: unit.editable,
          ...(unit.visible ? { visible: unit.visible } : {}),
          ...(unit.canned ? { canned: unit.canned } : {}),
        },
      },
    };
    assert.throws(
      () => specFrom(unchecked, cannedWorker(unchecked), 1),
      new RegExp(`${first}: no checks`),
      "a unit is checked by what it declares, or by the spec's own list",
    );
  });
}
