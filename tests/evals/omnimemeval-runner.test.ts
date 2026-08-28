import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SUITES,
  createRunPlan,
  parseRunOptions,
  type BenchmarkSuite,
} from "../../evals/omnimemeval/run.ts";

function fixtureRepo(suite: BenchmarkSuite): string {
  const root = mkdtempSync(join(tmpdir(), "nmg-omni-runner-"));
  const scripts = join(root, ".benchmarks", "official", "OmniMemEval", "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, SUITES[suite].runner), "#!/usr/bin/env bash\n", "utf8");
  writeFileSync(join(root, "benchmark.env"), "LLM_API_KEY=test\n", "utf8");
  return root;
}

test("all user-memory suites share one common default contract", () => {
  for (const suite of Object.keys(SUITES) as BenchmarkSuite[]) {
    const options = parseRunOptions([suite, "--env", "benchmark.env"]);
    assert.equal(options.workers, 1, suite);
    assert.equal(options.llmWorkers, 16, suite);
    assert.equal(options.topK, 20, suite);
    assert.equal(options.numRuns, 1, suite);
    assert.equal(options.fromStep, 1, suite);
  }
});

test("the unified plan delegates to the pinned official runner", () => {
  const repoRoot = fixtureRepo("beam");
  const options = parseRunOptions([
    "beam",
    "--env",
    "benchmark.env",
    "--version",
    "beam-canary",
    "--workers",
    "2",
    "--llm-workers",
    "32",
    "--to-step",
    "2",
    "--",
    "--scale",
    "100k",
  ]);
  const plan = createRunPlan(options, { repoRoot });

  assert.match(plan.runner, /run_beam_eval\.sh$/);
  assert.deepEqual(plan.args.slice(0, 5), [
    "./scripts/run_beam_eval.sh",
    "--lib",
    "nmg",
    "--env",
    join(repoRoot, "benchmark.env").replaceAll("\\", "/"),
  ]);
  assert.ok(plan.args.includes("beam-canary"));
  assert.ok(plan.args.includes("32"));
  assert.deepEqual(plan.args.slice(-2), ["--scale", "100k"]);
  assert.equal(plan.environment.NMG_ROOT, repoRoot);
  assert.equal(plan.environment.PYTHONUTF8, "1");
});

test("suite-only options cannot silently become common policy", () => {
  assert.throws(
    () => parseRunOptions(["locomo", "--env", "benchmark.env", "--scale", "100k"]),
    /not a common option/,
  );
  assert.throws(
    () =>
      parseRunOptions([
        "locomo",
        "--env",
        "benchmark.env",
        "--",
        "--scale",
        "100k",
      ]),
    /not a supported locomo option/,
  );
});

test("resume is fail-closed without an exact result directory", () => {
  assert.throws(
    () =>
      parseRunOptions([
        "longmemeval",
        "--env",
        "benchmark.env",
        "--version",
        "old-run",
        "--from-step",
        "2",
      ]),
    /requires both --version and --resume-dir/,
  );
});

test("resume validates suite, version, and prerequisite artifacts", () => {
  const repoRoot = fixtureRepo("longmemeval");
  const resultDir = join(
    repoRoot,
    ".benchmarks",
    "official",
    "OmniMemEval",
    "results",
    "lme",
    "nmg-old-run",
  );
  mkdirSync(resultDir, { recursive: true });
  writeFileSync(
    join(resultDir, "experiment_config.sh"),
    'LIB="nmg"\nVERSION="old-run"\n',
    "utf8",
  );
  writeFileSync(join(resultDir, "success_records.txt"), "0\n", "utf8");

  const good = parseRunOptions([
    "longmemeval",
    "--env",
    "benchmark.env",
    "--version",
    "old-run",
    "--from-step",
    "2",
    "--resume-dir",
    resultDir,
  ]);
  assert.doesNotThrow(() => createRunPlan(good, { repoRoot }));

  const wrongVersion = { ...good, version: "different-run" };
  assert.throws(() => createRunPlan(wrongVersion, { repoRoot }), /Resume version mismatch/);

  const afterSearch = { ...good, fromStep: 3 };
  assert.throws(
    () => createRunPlan(afterSearch, { repoRoot }),
    /nmg_lme_search_results\.json is missing or empty/,
  );
});

test("generated versions are stable for an injected clock", () => {
  const repoRoot = fixtureRepo("personamem-v2");
  const options = parseRunOptions(["personamem-v2", "--env", "benchmark.env"]);
  const plan = createRunPlan(options, {
    repoRoot,
    now: new Date("2026-08-27T01:02:03.456Z"),
  });
  assert.equal(plan.version, "personamem-v2_20260827T010203Z");
});
