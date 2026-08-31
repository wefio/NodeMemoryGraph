import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  configuredProvider,
  createEmbeddingClientFromEnv,
  type EmbeddingClient,
} from "../../src/core/embedding-provider.ts";
import { loadEnvironmentFile } from "../local-env.ts";

export type BenchmarkSuite =
  | "longmemeval"
  | "locomo"
  | "beam"
  | "personamem-v2"
  | "halumem";

type SuiteDefinition = {
  runner: string;
  resultFolder: string;
};

export const SUITES: Readonly<Record<BenchmarkSuite, SuiteDefinition>> = {
  longmemeval: { runner: "run_lme_eval.sh", resultFolder: "lme" },
  locomo: { runner: "run_locomo_eval.sh", resultFolder: "locomo" },
  beam: { runner: "run_beam_eval.sh", resultFolder: "beam" },
  "personamem-v2": { runner: "run_pmv2_eval.sh", resultFolder: "pmv2" },
  halumem: { runner: "run_halumem_eval.sh", resultFolder: "halumem" },
};

export type BenchmarkConfig = {
  envFile: string;
  commonArgs: string[];
  suites: Record<BenchmarkSuite, string[]>;
};

export type RunOptions = {
  suite?: BenchmarkSuite;
  configPath?: string;
  resumeDir?: string;
  dryRun: boolean;
};

export type RunPlan = {
  suite: BenchmarkSuite;
  version: string;
  configPath: string;
  repoRoot: string;
  omniRoot: string;
  envFile: string;
  runner: string;
  bash: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
};

export type EmbeddingClientFactory = (
  environment: NodeJS.ProcessEnv,
) => EmbeddingClient | undefined;

const RUNNER_OWNED_OPTIONS = new Set(["--env", "--lib", "--version", "--replay"]);
const RESUME_UNSAFE_OPTIONS = new Set(["--clear", "--no-resume"]);
const RESUME_UNSAFE_VALUE_OPTIONS = new Set(["--from-step", "--to-step"]);

function usage(): string {
  return `Usage:
  npm run benchmark:omni -- <suite> [--config <file>] [--dry-run]
  npm run benchmark:omni -- --resume <result-dir> [--config <file>] [--dry-run]

Suites:
  longmemeval | locomo | beam | personamem-v2 | halumem

Stable benchmark arguments live in:
  evals/omnimemeval/benchmark.config.json
`;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export function parseRunOptions(argv: string[]): RunOptions {
  const options: RunOptions = { dryRun: false };
  let index = 0;
  if (argv[0] && !argv[0].startsWith("--")) {
    if (!(argv[0] in SUITES)) throw new Error(`Unsupported suite: ${argv[0]}`);
    options.suite = argv[0] as BenchmarkSuite;
    index = 1;
  }
  for (; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--config") {
      options.configPath = requireValue(argv, index, option);
      index += 1;
    } else if (option === "--resume") {
      options.resumeDir = requireValue(argv, index, option);
      index += 1;
    } else if (option === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`Unsupported command option: ${option}`);
    }
  }
  if (options.resumeDir && options.suite) {
    throw new Error("--resume infers the suite from the result directory; omit the suite");
  }
  if (!options.resumeDir && !options.suite) throw new Error(`A suite is required.\n\n${usage()}`);
  return options;
}

function validateArgVector(name: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  for (const argument of value) {
    if (RUNNER_OWNED_OPTIONS.has(argument)) {
      throw new Error(`${name} cannot set runner-owned option ${argument}`);
    }
  }
  return value;
}

export function loadBenchmarkConfig(path: string): BenchmarkConfig {
  if (!existsSync(path)) throw new Error(`Benchmark config not found: ${path}`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BenchmarkConfig>;
  if (typeof raw.envFile !== "string" || !raw.envFile) {
    throw new Error("Benchmark config requires envFile");
  }
  const suites = raw.suites as Partial<Record<BenchmarkSuite, unknown>> | undefined;
  if (!suites) throw new Error("Benchmark config requires suites");
  const normalizedSuites = {} as Record<BenchmarkSuite, string[]>;
  for (const suite of Object.keys(SUITES) as BenchmarkSuite[]) {
    normalizedSuites[suite] = validateArgVector(`suites.${suite}`, suites[suite]);
  }
  return {
    envFile: raw.envFile,
    commonArgs: validateArgVector("commonArgs", raw.commonArgs),
    suites: normalizedSuites,
  };
}

function generatedVersion(suite: BenchmarkSuite, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${suite}_${stamp}`;
}

function resolveEnvFile(repoRoot: string, omniRoot: string, input: string): string {
  const candidates = isAbsolute(input)
    ? [input]
    : [resolve(repoRoot, input), resolve(omniRoot, input)];
  const selected = candidates.find((candidate) => existsSync(candidate));
  if (!selected) throw new Error(`Environment file not found: ${input}`);
  return selected;
}

function configValue(config: string, key: string): string | undefined {
  const match = config.match(new RegExp(`^${key}=(?:\"([^\"]*)\"|'([^']*)'|([^\\s#]+))`, "m"));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

/** Read the benchmark's shell-style env file without executing it. Official
 * benchmark env files use ordinary KEY=value assignments. Command substitution
 * is rejected so availability checks cannot turn configuration into code. */
export function loadBenchmarkEnvironment(plan: RunPlan): NodeJS.ProcessEnv {
  return loadEnvironmentFile(plan.envFile, plan.environment);
}

function enabled(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Cache hits can survive a dead provider, so successful cached rows do not
 * prove that a benchmark is healthy. Probe the configured provider before the
 * official runner starts; cache-only execution must be an explicit choice. */
export async function preflightEmbeddingProvider(
  environment: NodeJS.ProcessEnv,
  createClient: EmbeddingClientFactory = (current) =>
    createEmbeddingClientFromEnv(current, { required: false }),
): Promise<void> {
  if (enabled(environment.NMG_EMBED_CACHE_ONLY)) return;
  if (!configuredProvider(environment)) return;
  const client = createClient(environment);
  if (!client) throw new Error("embedding provider preflight failed: provider is not configured");
  try {
    const vectors = await client.embedQueries(["NMG benchmark embedding readiness probe"]);
    if (vectors.length !== 1 || vectors[0]!.length === 0) {
      throw new Error("provider returned no vector");
    }
  } catch (error) {
    throw new Error(
      `embedding provider preflight failed: ${errorMessage(error)}. Cached vectors are only an acceleration layer; restore the provider and resume, or explicitly enable NMG_EMBED_CACHE_ONLY=1 for a known-complete cache.`,
      { cause: error },
    );
  }
}

function suiteForResultDir(omniRoot: string, resultDir: string): BenchmarkSuite {
  const resultsRoot = resolve(omniRoot, "results");
  const relativePath = relative(resultsRoot, resultDir);
  if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
    throw new Error(`Resume directory must be inside ${resultsRoot}`);
  }
  const resultFolder = relativePath.split(sep)[0];
  const suite = (Object.keys(SUITES) as BenchmarkSuite[]).find(
    (candidate) => SUITES[candidate].resultFolder === resultFolder,
  );
  if (!suite) throw new Error(`Cannot infer benchmark suite from ${resultDir}`);
  return suite;
}

function withoutResumeUnsafeArgs(args: string[]): string[] {
  const safe: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (RESUME_UNSAFE_OPTIONS.has(option)) continue;
    if (RESUME_UNSAFE_VALUE_OPTIONS.has(option)) {
      index += 1;
      continue;
    }
    safe.push(option);
  }
  return safe;
}

function optionConfigKey(option: string): string {
  const key = option.slice(2).replaceAll("-", "_").toUpperCase();
  return key === "TOP_K" ? "TOPK" : key;
}

function assertResumeConfigMatches(config: string, args: string[], envFile: string): void {
  const recordedEnv = configValue(config, "ENV_FILE_BASENAME");
  if (recordedEnv && recordedEnv !== basename(envFile)) {
    throw new Error(`Resume config drift: envFile was ${recordedEnv}, now ${basename(envFile)}`);
  }
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!option.startsWith("--")) throw new Error(`Invalid configured argument: ${option}`);
    const next = args[index + 1];
    const hasValue = Boolean(next && !next.startsWith("--"));
    const expected = hasValue ? next : "1";
    if (hasValue) index += 1;
    const key = optionConfigKey(option);
    const recorded = configValue(config, key);
    if (recorded !== undefined && recorded !== expected) {
      throw new Error(`Resume config drift: ${option} was ${recorded}, now ${expected}`);
    }
  }
}

function findBash(): string {
  if (process.env.NMG_BASH) return process.env.NMG_BASH;
  if (process.platform === "win32") {
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    if (existsSync(gitBash)) return gitBash;
  }
  return "bash";
}

export function createRunPlan(
  options: RunOptions,
  overrides: { repoRoot?: string; now?: Date } = {},
): RunPlan {
  const repoRoot = resolve(
    overrides.repoRoot ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
  );
  const omniRoot = resolve(repoRoot, ".benchmarks", "official", "OmniMemEval");
  const configPath = resolve(
    repoRoot,
    options.configPath ?? "evals/omnimemeval/benchmark.config.json",
  );
  const config = loadBenchmarkConfig(configPath);
  const envFile = resolveEnvFile(repoRoot, omniRoot, config.envFile);

  let suite = options.suite;
  let version: string;
  let configuredArgs: string[];
  if (options.resumeDir) {
    const resultDir = resolve(repoRoot, options.resumeDir);
    suite = suiteForResultDir(omniRoot, resultDir);
    const experimentConfigPath = join(resultDir, "experiment_config.sh");
    if (!existsSync(experimentConfigPath)) {
      throw new Error(`Resume directory has no experiment_config.sh: ${resultDir}`);
    }
    const experimentConfig = readFileSync(experimentConfigPath, "utf8");
    if (configValue(experimentConfig, "LIB") !== "nmg") {
      throw new Error("Resume directory was not produced by the NMG adapter");
    }
    version = configValue(experimentConfig, "VERSION") ?? "";
    if (!version) throw new Error("Resume directory does not record VERSION");
    configuredArgs = withoutResumeUnsafeArgs([...config.commonArgs, ...config.suites[suite]]);
    assertResumeConfigMatches(experimentConfig, configuredArgs, envFile);
  } else {
    suite = suite!;
    version = generatedVersion(suite, overrides.now ?? new Date());
    configuredArgs = [...config.commonArgs, ...config.suites[suite]];
  }

  const definition = SUITES[suite];
  const runner = join(omniRoot, "scripts", definition.runner);
  if (!existsSync(runner)) {
    throw new Error(`OmniMemEval runner not found: ${runner}. Run npm run benchmark:setup first.`);
  }
  const args = [
    `./scripts/${definition.runner}`,
    "--lib",
    "nmg",
    "--env",
    envFile.replaceAll("\\", "/"),
    "--version",
    version,
    ...configuredArgs,
  ];

  const environment = { ...process.env };
  environment.NMG_ROOT = repoRoot;
  environment.NMG_NODE ??= process.execPath;
  environment.PYTHONUTF8 = "1";
  environment.PYTHONIOENCODING = "utf-8";
  const venvFolder = process.platform === "win32" ? "Scripts" : "bin";
  const venvPath = join(repoRoot, ".benchmarks", "omni-venv", venvFolder);
  if (existsSync(venvPath)) {
    environment.PATH = `${venvPath}${process.platform === "win32" ? ";" : ":"}${environment.PATH ?? ""}`;
  }

  return {
    suite,
    version,
    configPath,
    repoRoot,
    omniRoot,
    envFile,
    runner,
    bash: findBash(),
    args,
    environment,
  };
}

export async function runPlan(plan: RunPlan): Promise<number> {
  await preflightEmbeddingProvider(loadBenchmarkEnvironment(plan));
  const result = spawnSync(plan.bash, plan.args, {
    cwd: plan.omniRoot,
    env: plan.environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  if (process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h")) {
    console.log(usage());
  } else try {
    const options = parseRunOptions(process.argv.slice(2));
    const plan = createRunPlan(options);
    console.log(
      JSON.stringify(
        {
          suite: plan.suite,
          version: plan.version,
          config: plan.configPath,
          envFile: plan.envFile,
          command: [plan.bash, ...plan.args],
        },
        null,
        2,
      ),
    );
    if (!options.dryRun) process.exitCode = await runPlan(plan);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
