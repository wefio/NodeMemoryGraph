// The CI coverage check exists to answer "which suites does CI actually run?" with a measurement
// rather than an assertion, so its own test has to be hermetic: a throwaway repository with a
// package.json and a few tracked test files, no eslint, no worktrees, no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { testCoverage } from "../../tools/ci-uncovered-tests.ts";

function fixture(scripts: Record<string, string>, files: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "nmg-ci-coverage-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }), "utf8");
  for (const file of files) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "// fixture\n", "utf8");
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

const scripts = (coverage: string) => ({
  build: "tsc",
  "prompts:generate": "node tools/generate.ts",
  "verify:product-ci": "npm run build && npm run test:coverage",
  "verify:research": "npm run prompts:generate && npm run test:research",
  "verify:chaos": "npm run test:chaos",
  "test:coverage": `node --test ${coverage}`,
  "test:research": 'node --test "tests/evals/**/*.test.ts"',
  "test:chaos": 'node --test "tests/chaos/*.test.ts"',
});

test("it names the suites no CI job reaches, and passes when they are acknowledged", (t) => {
  const root = fixture(scripts('"tests/core/**/*.test.ts"'), [
    "tests/core/a.test.ts",
    "tests/evals/b.test.ts",
    "evals/ooo-execution/c.test.ts",
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const coverage = testCoverage(root);
  assert.deepEqual(coverage.unreached, ["evals/ooo-execution/c.test.ts"]);
  assert.deepEqual(coverage.unacknowledged, []);
  assert.ok(coverage.covered.has("tests/core/a.test.ts"));
  assert.ok(coverage.covered.has("tests/evals/b.test.ts"));
  // `evals/` is the acknowledged root: it holds harnesses that drive real worktrees and, for
  // live rounds, a paid provider, so they are on-demand rather than required.
  assert.equal(coverage.unreached.length, 1);
});

test("a suite outside the acknowledged root fails the check instead of quietly leaving CI", (t) => {
  const root = fixture(scripts('"tests/core/**/*.test.ts"'), [
    "tests/core/a.test.ts",
    "tests/lab/b.test.ts",
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const coverage = testCoverage(root);
  assert.deepEqual(coverage.unreached, ["tests/lab/b.test.ts"]);
  assert.deepEqual(coverage.unacknowledged, ["tests/lab/b.test.ts"]);

  // Covering it in a job's globs clears the finding: the check asks for coverage or an explicit
  // acknowledgement, not for a particular layout.
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: scripts('"tests/core/**/*.test.ts" "tests/lab/**/*.test.ts"') }),
    "utf8",
  );
  assert.deepEqual(testCoverage(root).unacknowledged, []);
});

test("untracked work in progress is not judged", (t) => {
  const root = fixture(scripts('"tests/core/**/*.test.ts"'), ["tests/core/a.test.ts"]);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  mkdirSync(join(root, "tests/lab"), { recursive: true });
  writeFileSync(join(root, "tests/lab/wip.test.ts"), "// not added yet\n", "utf8");
  assert.deepEqual(testCoverage(root).unreached, [], "an uncommitted suite is not a CI gap yet");
});

test("a CI entry point that names a missing script is a named error, not a silent skip", (t) => {
  const root = fixture(
    {
      build: "tsc",
      "verify:product-ci": "npm run build && npm run gone",
      "verify:research": "npm run test:research",
      "verify:chaos": "npm run test:chaos",
      "test:research": 'node --test "tests/evals/**/*.test.ts"',
      "test:chaos": 'node --test "tests/chaos/*.test.ts"',
    },
    ["tests/core/a.test.ts"],
  );
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  assert.throws(() => testCoverage(root), /no such script: gone/);
});
