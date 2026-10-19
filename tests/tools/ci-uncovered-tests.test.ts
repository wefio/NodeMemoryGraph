// The CI coverage check exists to answer "which suites does CI actually run?" with a measurement
// rather than an assertion, so its own test has to be hermetic: a throwaway repository with a
// package.json and a few tracked test files, no eslint, no worktrees, no network.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
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

test("on-demand selection excludes fixture inputs and archived evidence without hiding CI gaps", (t) => {
  const files = [
    "tests/core/a.test.ts",
    "evals/ooo-execution/harness.test.ts",
    "evals/other/fixtures/independent.test.ts",
    "evals/ooo-execution/fixtures/report/alpha.test.ts",
    "docs/experiments/execution/archive/run/candidate.test.ts",
    "tests/lab/gap.test.ts",
  ];
  const root = fixture(scripts('"tests/core/**/*.test.ts"'), files);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const coverage = testCoverage(root);
  assert.deepEqual(coverage.unreached, files.slice(1).sort());
  assert.deepEqual(coverage.unacknowledged, ["tests/lab/gap.test.ts"]);
  assert.deepEqual(coverage.onDemand, [
    "evals/ooo-execution/harness.test.ts",
    "evals/other/fixtures/independent.test.ts",
    "tests/lab/gap.test.ts",
  ]);

  const tool = fileURLToPath(new URL("../../tools/ci-uncovered-tests.ts", import.meta.url));
  const listed = spawnSync(process.execPath, ["--experimental-strip-types", tool, "--list"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split(/\r?\n/u), coverage.onDemand);
  const checked = spawnSync(process.execPath, ["--experimental-strip-types", tool, "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(checked.status, 1, checked.stdout);
  assert.match(checked.stdout, /fixture checks run through their harness/u);
  assert.match(checked.stdout, /archived candidate evidence/u);
  assert.match(checked.stderr, /1 test file\(s\)/u);
});

test("an inventory containing only fixture inputs and archive evidence has no on-demand suites", (t) => {
  const files = [
    "evals/ooo-execution/fixtures/report/alpha.test.ts",
    "docs/experiments/execution/archive/run/candidate.test.ts",
  ];
  const root = fixture(scripts('"tests/core/**/*.test.ts"'), files);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const coverage = testCoverage(root);
  assert.deepEqual(coverage.unreached, files.slice().sort());
  assert.deepEqual(coverage.unacknowledged, []);
  assert.deepEqual(coverage.onDemand, []);
  const tool = fileURLToPath(new URL("../../tools/ci-uncovered-tests.ts", import.meta.url));
  const listed = spawnSync(process.execPath, ["--experimental-strip-types", tool, "--list"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, "");
});

function runWorkflow(root: string, nodeBody: string) {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/on-demand-suites.yml", import.meta.url), "utf8"),
  ) as { jobs: { uncovered: { steps: Array<{ name?: string; run?: string }> } } };
  const step = workflow.jobs.uncovered.steps.find(
    (entry) => entry.name === "Run them, one file at a time",
  );
  assert.ok(step?.run, "the real workflow runner must be present");
  const body = step.run.replaceAll("${{ matrix.os }}", "fixture");
  // Windows' bare bash may launch WSL; the workflow uses Git Bash instead.
  const bash =
    process.platform === "win32"
      ? resolve(
          execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(),
          "../../../bin/bash.exe",
        )
      : "bash";
  return spawnSync(bash, ["-c", `node() { ${nodeBody}; }\n${body}`], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("an empty on-demand selection records skipped TAP without invoking Node discovery", (t) => {
  const root = fixture(scripts('"tests/core/**/*.test.ts"'), []);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, "unreached.txt"), "", "utf8");
  const result = runWorkflow(root, 'printf "unexpected discovery\\n"; return 19');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^1\.\.0 # SKIP no on-demand suites selected$/mu);
  assert.doesNotMatch(result.stdout, /unexpected discovery/u);
  assert.equal(readFileSync(join(root, "unreached-fixture.tap"), "utf8"), result.stdout);
});

test("the workflow passes selected suite paths intact and keeps Node failures visible", (t) => {
  const root = fixture(scripts('"tests/core/**/*.test.ts"'), []);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const suite = "evals/ooo-execution/a suite.test.ts";
  writeFileSync(join(root, "unreached.txt"), `${suite}\n`, "utf8");
  const result = runWorkflow(
    root,
    'printf "%s\\n" "$@" > node-args.txt; printf "TAP version 13\\nnot ok 1 - injected failure\\n"; return 17',
  );
  assert.equal(result.status, 17, result.stderr || result.stdout);
  assert.deepEqual(readFileSync(join(root, "node-args.txt"), "utf8").trim().split(/\r?\n/u), [
    "--experimental-strip-types",
    "--test",
    "--test-concurrency=1",
    "--test-reporter=tap",
    suite,
  ]);
  assert.equal(readFileSync(join(root, "unreached-fixture.tap"), "utf8"), result.stdout);
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
