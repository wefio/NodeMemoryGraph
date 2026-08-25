import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };

test("product and coverage tests exclude research and chaos suites", () => {
  for (const name of ["test:product", "test:coverage"]) {
    const script = packageJson.scripts[name];
    assert.ok(script.includes("tests/core/**/*.test.ts"));
    assert.ok(script.includes("tests/guardrails/**/*.test.ts"));
    assert.doesNotMatch(script, /tests\/(benchmarks|evals|official|chaos)/);
  }
});

test("research and chaos suites remain explicit execution groups", () => {
  assert.match(packageJson.scripts["test:research"], /tests\/benchmarks/);
  assert.match(packageJson.scripts["test:research"], /tests\/evals/);
  assert.match(packageJson.scripts["test:research"], /tests\/official/);
  assert.match(packageJson.scripts["test:chaos"], /tests\/chaos/);
});
