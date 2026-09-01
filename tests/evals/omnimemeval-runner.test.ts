import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SUITES,
  createRunPlan,
  loadBenchmarkEnvironment,
  parseRunOptions,
  preflightEmbeddingProvider,
  runPlan,
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
  const plan = createRunPlan(parseRunOptions(["beam", "--config", "benchmark.json"]), {
    repoRoot,
    now: new Date("2026-08-28T01:02:03.456Z"),
  });

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
  assert.equal(plan.environment.LLM_CONCURRENCY, "16");
});

test("maintained PersonaMem profile selects the validated static-first layout", () => {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), "evals", "omnimemeval", "benchmark.config.json"), "utf8"),
  ) as BenchmarkConfig;

  assert.deepEqual(config.suites["personamem-v2"], ["--prompt-layout", "static-first"]);
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
      createRunPlan(parseRunOptions(["--resume", resultDir, "--config", "benchmark.json"]), {
        repoRoot,
      }),
    /Resume config drift: --workers was 1, now 2/,
  );
});

test("benchmark environment loads embedding settings without exposing them in runner args", () => {
  const repoRoot = fixtureRepo("beam");
  writeFileSync(
    join(repoRoot, "benchmark.env"),
    [
      "NMG_EMBED_PROVIDER=openai",
      'NMG_EMBED_BASE_URL="http://127.0.0.1:8000/v1"',
      "NMG_EMBED_MODEL=BAAI/bge-small-en-v1.5",
      "NMG_EMBED_CACHE_ONLY=1",
    ].join("\n"),
    "utf8",
  );
  const plan = createRunPlan(parseRunOptions(["beam", "--config", "benchmark.json"]), {
    repoRoot,
  });
  const environment = loadBenchmarkEnvironment(plan);
  assert.equal(environment.NMG_EMBED_PROVIDER, "openai");
  assert.equal(environment.NMG_EMBED_BASE_URL, "http://127.0.0.1:8000/v1");
  assert.equal(environment.NMG_EMBED_CACHE_ONLY, "1");
  assert.ok(!plan.args.some((argument) => argument.includes("NMG_EMBED")));
});

test("embedding preflight probes the configured provider before a benchmark starts", async () => {
  let calls = 0;
  const environment = {
    NMG_EMBED_PROVIDER: "openai",
    NMG_EMBED_BASE_URL: "http://provider.invalid/v1",
  };
  await preflightEmbeddingProvider(environment, () => ({
    indexId: "test-index",
    model: "test-model",
    profile: "plain",
    embed: async () => [],
    embedDocuments: async () => [],
    embedQueries: async (inputs: string[]) => {
      calls += 1;
      return inputs.map(() => [1]);
    },
  }));
  assert.equal(calls, 1);
});

test("embedding preflight fails before execution when the provider is unavailable", async () => {
  await assert.rejects(
    preflightEmbeddingProvider({ NMG_EMBED_PROVIDER: "openai" }, () => ({
      indexId: "test-index",
      model: "test-model",
      profile: "plain",
      embed: async () => [],
      embedDocuments: async () => [],
      embedQueries: async () => {
        throw new Error("fetch failed");
      },
    })),
    /embedding provider preflight failed.*fetch failed/i,
  );
});

test("explicit cache-only mode skips the provider preflight", async () => {
  let factoryCalls = 0;
  await preflightEmbeddingProvider(
    { NMG_EMBED_PROVIDER: "openai", NMG_EMBED_CACHE_ONLY: "1" },
    () => {
      factoryCalls += 1;
      throw new Error("provider must not be constructed in cache-only mode");
    },
  );
  assert.equal(factoryCalls, 0);
});

test("runPlan writes a bounded resource report and propagates the exit code", async () => {
  const repoRoot = fixtureRepo("locomo");
  const omniRoot = join(repoRoot, ".benchmarks", "official", "OmniMemEval");
  // Point the runner at a real quick command instead of the shell stub: sleep
  // long enough for the sampler to capture at least one tick, then exit 0.
  const scriptPath = join(omniRoot, "scripts", SUITES.locomo.runner);
  writeFileSync(scriptPath, "#!/usr/bin/env bash\nsleep 1\nexit 0\n", "utf8");
  const plan = createRunPlan(parseRunOptions(["locomo", "--config", "benchmark.json"]), {
    repoRoot,
  });
  const code = await runPlan(plan);
  assert.equal(code, 0);

  const reportPath = join(
    omniRoot,
    "results",
    SUITES.locomo.resultFolder,
    plan.version,
    "resource_report.json",
  );
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    label: string;
    ticks: unknown[];
    summary: { processCountMax: number };
  };
  assert.equal(report.label, `locomo@${plan.version}`);
  assert.ok(report.ticks.length >= 1, "captured at least one tick");
  assert.ok(report.summary.processCountMax >= 1);
});
