import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

function runHeapChecks(exposeGc: boolean): string {
  const environment = { ...process.env };
  // The child owns its reporter; inheriting the parent's test context masks TAP.
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      exposeGc ? "--expose-gc" : "--no-expose-gc",
      "--experimental-strip-types",
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern=^(Tensor allocate 50K|HA propagate × 5K)",
      fileURLToPath(new URL("../core/robustness.test.ts", import.meta.url)),
    ],
    { env: environment, encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("missing GC reports both heap checks as skipped while NaN stress still passes", () => {
  const tap = runHeapChecks(false);
  assert.match(
    tap,
    /^ok \d+ - Tensor allocate 50K does not blow heap # SKIP run with --expose-gc/mu,
  );
  assert.match(tap, /^ok \d+ - HA propagate × 5K: stable heap # SKIP run with --expose-gc/mu);
  assert.match(tap, /^ok \d+ - HA propagate × 5K: no NaN$/mu);
});

test("exposed GC executes both heap checks and NaN stress without skips", () => {
  const tap = runHeapChecks(true);
  assert.match(tap, /^ok \d+ - Tensor allocate 50K does not blow heap$/mu);
  assert.match(tap, /^ok \d+ - HA propagate × 5K: stable heap$/mu);
  assert.match(tap, /^ok \d+ - HA propagate × 5K: no NaN$/mu);
  assert.doesNotMatch(tap, /# SKIP/u);
});
