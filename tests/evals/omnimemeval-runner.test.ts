import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SUITES,
  createRunPlan,
  parseRunOptions,
  type BenchmarkConfig,
  type BenchmarkSuite,
} from "../../evals/omnimemeval/run.ts";

function fixtureRepo(suite: BenchmarkSuite, config?: Partial<BenchmarkConfig>): string {
  const root = mkdtempSync(join(tmpdir(), "nmg-omni-runner-"));
  const scripts = join(root, ".benchmarks", "official", "OmniMemEval", "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, SUITES[suite].runner), "#!/usr/bin/env bash\n", "utf8");
  writeFileSync(join(root, "benchmark.env"), "LLM_API_KEY=test\n", "utf8");
  const suites = Object.fromEntries(Object.keys(SUITES).map((name) => [name, []]));
  writeFileSync(
    join(root, "benchmark.json"),
    JSON.stringify({
      envFile: "benchmark.env",
      commonArgs: ["--workers", "1", "--llm-workers", "16", "--top-k", "20"],
      suites,
      ...config,
    }),
    "utf8",
  );
  return root;
}

test("CLI exposes only suite, config, resume, and dry-run", () => {
  assert.deepEqual(parseRunOptions(["beam", "--config", "canary.json", "--dry-run"]), {
    suite: "beam",
    configPath: "canary.json",
    dryRun: true,
  });
  assert.throws(
    () => parseRunOptions(["beam", "--llm-workers", "32"]),
    /Unsupported command option/,
  );
});

test("one config supplies common and suite-specific official arguments", () => {
  const suites = Object.fromEntries(Object.keys(SUITES).map((name) => [name, []])) as Record<
    BenchmarkSuite,
    string[]
  >;
  suites.beam = ["--scale", "100k", "--judge-batch-size", "4"];
  const repoRoot = fixtureRepo("beam", { suites });
  const plan = createRunPlan(
    parseRunOptions(["beam", "--config", "benchmark.json"]),
    { repoRoot, now: new Date("2026-08-28T01:02:03.456Z") },
  );

  assert.equal(plan.version, "beam_20260828T010203Z");
  assert.deepEqual(plan.args.slice(-7), [
    "16",
    "--top-k",
    "20",
    "--scale",
    "100k",
    "--judge-batch-size",
    "4",
  ]);
  assert.ok(plan.args.includes("--workers"));
  assert.equal(plan.environment.NMG_ROOT, repoRoot);
  assert.equal(plan.environment.NMG_NODE, process.execPath);
});

test("configured arguments cannot replace runner-owned identity", () => {
  const repoRoot = fixtureRepo("locomo", { commonArgs: ["--env", "other.env"] });
  assert.throws(
    () =>
      createRunPlan(parseRunOptions(["locomo", "--config", "benchmark.json"]), {
        repoRoot,
      }),
    /cannot set runner-owned option --env/,
  );
});

test("resume infers suite and version from the exact result directory", () => {
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
    [
      'ENV_FILE_BASENAME="benchmark.env"',
      'LIB="nmg"',
      'VERSION="old-run"',
      "WORKERS=1",
      "LLM_WORKERS=16",
      "TOPK=20",
    ].join("\n"),
    "utf8",
  );

  const plan = createRunPlan(
    parseRunOptions(["--resume", resultDir, "--config", "benchmark.json"]),
    { repoRoot },
  );
  assert.equal(plan.suite, "longmemeval");
  assert.equal(plan.version, "old-run");
  assert.ok(!plan.args.includes("--from-step"));
});

test("resume rejects config drift instead of silently changing the run", () => {
  const repoRoot = fixtureRepo("longmemeval", {
    commonArgs: ["--workers", "2", "--llm-workers", "16", "--top-k", "20"],
  });
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
    'ENV_FILE_BASENAME="benchmark.env"\nLIB="nmg"\nVERSION="old-run"\nWORKERS=1\n',
    "utf8",
  );
  assert.throws(
    () =>
      createRunPlan(
        parseRunOptions(["--resume", resultDir, "--config", "benchmark.json"]),
        { repoRoot },
      ),
    /Resume config drift: --workers was 1, now 2/,
  );
});
