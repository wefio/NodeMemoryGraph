import assert from "node:assert/strict";
import test from "node:test";
import { complexitiesForMany, evaluateComplexityDiff } from "../../tools/complexity-gate.ts";

const tool = (name: string, count: number) =>
  `pi.registerTool({name: '${name}', execute(value) { ${"if(value) value++;".repeat(count)} return value; }});`;

test("inline named tool registrations retain independent baselines when another registration is removed", async () => {
  const file = "registration.ts";
  const [before, after] = await complexitiesForMany([
    { file, source: tool("remember", 25) + "\n" + tool("board", 20) },
    { file, source: tool("remember", 25) + "\n" + tool("state", 5) },
  ]);
  const baseline = new Map(before!.findings.map((finding) => [finding.name, finding]));
  const current = new Map(after!.findings.map((finding) => [finding.name, finding]));
  assert.equal(baseline.size, 2, "different inline tool owners cannot overwrite each other");
  assert.deepEqual(evaluateComplexityDiff(baseline, current, 15).violations, []);
});
