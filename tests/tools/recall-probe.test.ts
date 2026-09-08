import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultVariants,
  executeProbeRow,
  probeLabel,
  summarizeProbe,
  type RecallProbeRow,
} from "../../src/lab/recall-probe.ts";

test("probeLabel is deterministic on_target when the expected memory surfaces", () => {
  assert.equal(probeLabel(["a", "b", "c"], "b"), "on_target");
  assert.equal(probeLabel(["a", "c"], "b"), "gap");
});

test("executeProbeRow labels the primary query and each variant", async () => {
  const row: RecallProbeRow = {
    groupId: "weather",
    query: "how do i check the weather",
    expectMemoryId: "m1",
    variants: ["天气", "how to get weather?"],
  };
  const execution = await executeProbeRow(row, async (query) => {
    // m1 surfaces for the english variants but not the CJK one.
    return query === "天气" ? [] : ["m1"];
  });
  assert.equal(execution.primary, "on_target");
  assert.deepEqual(
    execution.variants.map((variant) => variant.label),
    ["gap", "on_target"],
  );
});

test("summarizeProbe buckets gaps, robust and fragile groups", async () => {
  const rows: RecallProbeRow[] = [
    { groupId: "weather", query: "how do i check weather", expectMemoryId: "m1", variants: ["wttr"] },
    { groupId: "absent", query: "unused thing", expectMemoryId: "m2", variants: [] },
    { groupId: "fragile", query: "recall me", expectMemoryId: "m3", variants: ["near alias"] },
  ];
  const executions = [];
  for (const row of rows) {
    executions.push(
      await executeProbeRow(row, async (query) => {
        if (row.groupId === "absent") return [];
        if (row.groupId === "fragile") return query === "near alias" ? [] : ["m3"];
        return query === "wttr" ? ["m1"] : ["m1"];
      }),
    );
  }
  const summary = summarizeProbe(executions);
  assert.deepEqual(summary.gaps, ["absent"]);
  assert.deepEqual(summary.robust, ["weather"]);
  assert.equal(summary.fragile.length, 1);
  assert.equal(summary.fragile[0]!.groupId, "fragile");
  assert.deepEqual(summary.fragile[0]!.failedVariants, ["near alias"]);
});

test("defaultVariants adds a floor of cheap perturbations and de-fluffs", () => {
  const variants = defaultVariants("how do i check the weather");
  assert.ok(variants.includes("how do i check the weather?"));
  assert.ok(variants.includes("check the weather"));
  assert.ok(!variants.includes("how do i check the weather"));
});
