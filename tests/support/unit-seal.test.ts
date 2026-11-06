// The seal is a run-time claim, so it can only be checked from outside it: this test starts a
// child with the seal preloaded and asks it to cross a boundary. That makes this file
// end-to-end by the same rule it is testing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
// Relative, because `--import` resolves a bare Windows path as a URL scheme.
const seal = "./tests/helpers/unit-seal.ts";

function runProbe(source: string, childContext: boolean) {
  const env = { ...process.env };
  if (childContext) env.NODE_TEST_CONTEXT = "child-v8";
  else delete env.NODE_TEST_CONTEXT;
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--import", seal, "--input-type=module", "-e", source],
    { cwd: root, encoding: "utf8", env },
  );
}

test("the unit seal refuses a process boundary and names the rule", () => {
  const result = runProbe(
    `import { spawnSync } from "node:child_process";
spawnSync("node", ["--version"]);`,
    true,
  );
  assert.notEqual(result.status, 0, "the child should have thrown");
  assert.match(result.stderr, /unit layer: node:child_process\.spawnSync is sealed/);
});

test("the seal refuses a real database and any socket", () => {
  for (const [source, expected] of [
    [`import { DatabaseSync } from "node:sqlite"; new DatabaseSync(":memory:");`, "node:sqlite"],
    [`import { connect } from "node:net"; connect({ port: 1 });`, "node:net"],
  ] as const) {
    const result = runProbe(source, true);
    assert.notEqual(result.status, 0, expected);
    assert.ok(result.stderr.includes(`unit layer: ${expected}.`), result.stderr);
  }
});

test("the seal stays inert in the runner process that spawns the tests", () => {
  const result = runProbe(
    `import { spawnSync } from "node:child_process";
process.stdout.write(String(spawnSync(process.execPath, ["--version"]).status));`,
    false,
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "0", "the runner itself must still be able to spawn children");
});
