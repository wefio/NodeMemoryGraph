import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

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

test("local and CI verification groups share named package contracts", () => {
  const contracts = [
    "verify:static",
    "verify:product-ci",
    "verify:research",
    "verify:node-compat",
    "verify:chaos",
  ];
  for (const name of contracts) {
    assert.ok(packageJson.scripts[name], `missing package script ${name}`);
    assert.match(workflow, new RegExp(`npm run ${name.replace(":", "\\:")}`));
  }
  assert.match(packageJson.scripts["verify:static"], /agent:context:check/);
  assert.match(packageJson.scripts["verify:product-ci"], /test:coverage/);
});
