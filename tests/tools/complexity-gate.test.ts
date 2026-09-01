import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateComplexityDiff } from "../../tools/complexity-gate.ts";

interface Finding {
  file: string;
  line: number;
  name: string;
  complexity: number;
}

function key(finding: Finding): string {
  return `${finding.file}::${finding.name}`;
}

test("unchanged complex methods pass the gate", () => {
  const baseline = new Map<string, Finding>([
    [
      key({ file: "a.ts", line: 1, name: "legacy", complexity: 30 }),
      { file: "a.ts", line: 1, name: "legacy", complexity: 30 },
    ],
  ]);
  const current = new Map(baseline);
  const { violations } = evaluateComplexityDiff(baseline, current, 15);
  assert.deepEqual(violations, []);
});

test("a new method above the threshold fails the gate", () => {
  const baseline = new Map<string, Finding>();
  const current = new Map<string, Finding>([
    [
      key({ file: "a.ts", line: 5, name: "fresh", complexity: 20 }),
      { file: "a.ts", line: 5, name: "fresh", complexity: 20 },
    ],
  ]);
  const { violations } = evaluateComplexityDiff(baseline, current, 15);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!, /new method 'fresh'.*complexity 20/u);
});

test("a new method at or below the threshold passes", () => {
  const baseline = new Map<string, Finding>();
  const current = new Map<string, Finding>([
    [
      key({ file: "a.ts", line: 5, name: "fresh", complexity: 15 }),
      { file: "a.ts", line: 5, name: "fresh", complexity: 15 },
    ],
  ]);
  const { violations } = evaluateComplexityDiff(baseline, current, 15);
  assert.deepEqual(violations, []);
});

test("a method whose complexity grew fails the gate", () => {
  const baseline = new Map<string, Finding>([
    [
      key({ file: "a.ts", line: 1, name: "grew", complexity: 10 }),
      { file: "a.ts", line: 1, name: "grew", complexity: 10 },
    ],
  ]);
  const current = new Map<string, Finding>([
    [
      key({ file: "a.ts", line: 1, name: "grew", complexity: 16 }),
      { file: "a.ts", line: 1, name: "grew", complexity: 16 },
    ],
  ]);
  const { violations } = evaluateComplexityDiff(baseline, current, 15);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!, /complexity grew 10 -> 16/u);
});

test("a method whose complexity shrank passes (and is not reported)", () => {
  const baseline = new Map<string, Finding>([
    [
      key({ file: "a.ts", line: 1, name: "improved", complexity: 30 }),
      { file: "a.ts", line: 1, name: "improved", complexity: 30 },
    ],
  ]);
  const current = new Map<string, Finding>([
    [
      key({ file: "a.ts", line: 1, name: "improved", complexity: 8 }),
      { file: "a.ts", line: 1, name: "improved", complexity: 8 },
    ],
  ]);
  const { violations } = evaluateComplexityDiff(baseline, current, 15);
  assert.deepEqual(violations, []);
});

test("removed methods are ignored", () => {
  const baseline = new Map<string, Finding>([
    [
      key({ file: "a.ts", line: 1, name: "gone", complexity: 40 }),
      { file: "a.ts", line: 1, name: "gone", complexity: 40 },
    ],
  ]);
  const current = new Map<string, Finding>();
  const { violations } = evaluateComplexityDiff(baseline, current, 15);
  assert.deepEqual(violations, []);
});
