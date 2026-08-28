import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type BenchmarkSuite =
  | "longmemeval"
  | "locomo"
  | "beam"
  | "personamem-v2"
  | "halumem";

type SuiteDefinition = {
  runner: string;
  resultFolder: string;
  searchArtifact: string;
  responseArtifact: string;
  suiteOptions: Readonly<Record<string, "flag" | "value">>;
};

export const SUITES: Readonly<Record<BenchmarkSuite, SuiteDefinition>> = {
  longmemeval: {
    runner: "run_lme_eval.sh",
    resultFolder: "lme",
    searchArtifact: "nmg_lme_search_results.json",
    responseArtifact: "nmg_lme_responses.json",
    suiteOptions: {
      "--streaming": "flag",
      "--start-idx": "value",
      "--end-idx": "value",
      "--restart-unit": "value",
      "--skip-failed-streaming": "flag",
      "--skip-failed-judge": "flag",
    },
  },
  locomo: {
    runner: "run_locomo_eval.sh",
    resultFolder: "locomo",
    searchArtifact: "nmg_locomo_search_results.json",
    responseArtifact: "nmg_locomo_responses.json",
    suiteOptions: {
      "--skip-failed-judge": "flag",
    },
  },
  beam: {
    runner: "run_beam_eval.sh",
    resultFolder: "beam",
    searchArtifact: "nmg_beam_search_results.json",
    responseArtifact: "nmg_beam_responses.json",
    suiteOptions: {
      "--scale": "value",
      "--llm-workers-min": "value",
      "--judge-batch-size": "value",
      "--streaming": "flag",
      "--start-idx": "value",
      "--end-idx": "value",
      "--restart-unit": "value",
      "--no-resume": "flag",
      "--skip-failed-streaming": "flag",
      "--skip-failed-judge": "flag",
    },
  },
  "personamem-v2": {
    runner: "run_pmv2_eval.sh",
    resultFolder: "pmv2",
    searchArtifact: "nmg_pm_search_results.json",
    responseArtifact: "nmg_pm_responses.json",
    suiteOptions: {
      "--allow-missing-data": "flag",
    },
  },
  halumem: {
    runner: "run_halumem_eval.sh",
    resultFolder: "halumem",
    searchArtifact: "nmg_hm_search_results.json",
    responseArtifact: "nmg_hm_responses.json",
    suiteOptions: {
      "--variant": "value",
      "--users": "value",
      "--start-user": "value",
      "--streaming": "flag",
      "--start-idx": "value",
      "--end-idx": "value",
      "--restart-unit": "value",
      "--skip-failed-streaming": "flag",
      "--skip-failed-judge": "flag",
    },
  },
};

export type RunOptions = {
  suite: BenchmarkSuite;
  envFile: string;
  version?: string;
  workers: number;
  llmWorkers: number;
  topK: number;
  numRuns: number;
  fromStep: number;
  toStep?: number;
  resumeDir?: string;
  replayDir?: string;
  clear: boolean;
  dryRun: boolean;
  sharedFlags: string[];
  suiteArgs: string[];
};

export type RunPlan = {
  suite: BenchmarkSuite;
  version?: string;
  repoRoot: string;
  omniRoot: string;
  envFile: string;
  runner: string;
  bash: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
};

const INTEGER_OPTIONS = new Map<string, keyof RunOptions>([
  ["--workers", "workers"],
  ["--llm-workers", "llmWorkers"],
  ["--top-k", "topK"],
  ["--num-runs", "numRuns"],
  ["--from-step", "fromStep"],
  ["--to-step", "toStep"],
]);

const SHARED_BOOLEAN_FLAGS = new Set([
  "--save-model-input",
  "--allow-empty-search",
  "--skip-failed-search",
  "--skip-failed-answer",
  "--notify",
  "--wait-after-ingest",
]);

function usage(): string {
  return `Usage:
  npm run benchmark:omni -- <suite> --env <file> [options] [-- suite-options]

Suites:
  longmemeval | locomo | beam | personamem-v2 | halumem

Common options:
  --version <label>        Reproducible run/store identity (generated if omitted)
  --workers <n>            Ingestion/search workers (default: 1)
  --llm-workers <n>        Shared answer/judge concurrency (default: 16)
  --top-k <n>              Retrieval budget (default: 20)
  --num-runs <n>           Answer repetitions (default: 1)
  --from-step <n>          Official pipeline start step (default: 1)
  --to-step <n>            Official pipeline end step
  --resume-dir <path>      Required when --from-step is greater than 1
  --replay <path>          Use the official interactive replay flow
  --clear                  Ask the official runner to clear benchmark state
  --dry-run                Validate and print the exact invocation only

Dataset-specific options must follow --. Example:
  npm run benchmark:omni -- beam --env .env.nmg-opencode -- --scale 100k
`;
}

function parsePositiveInteger(option: string, value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${option} requires a positive integer`);
  }
  return Number(value);
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function validateSuiteArgs(suite: BenchmarkSuite, args: string[]): void {
  const allowed = SUITES[suite].suiteOptions;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const kind = allowed[option];
    if (!kind) {
      throw new Error(`${option} is not a supported ${suite} option`);
    }
    if (kind === "value") {
      requireValue(args, index, option);
      index += 1;
    }
  }
}

export function parseRunOptions(argv: string[]): RunOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    throw new Error(usage());
  }
  const separator = argv.indexOf("--");
  const commonArgs = separator < 0 ? argv : argv.slice(0, separator);
  const suiteArgs = separator < 0 ? [] : argv.slice(separator + 1);
  const suite = commonArgs[0] as BenchmarkSuite | undefined;
  if (!suite || !(suite in SUITES)) {
    throw new Error(`A supported suite is required.\n\n${usage()}`);
  }

  const options: RunOptions = {
    suite,
    envFile: "",
    workers: 1,
    llmWorkers: 16,
    topK: 20,
    numRuns: 1,
    fromStep: 1,
    clear: false,
    dryRun: false,
    sharedFlags: [],
    suiteArgs,
  };

  for (let index = 1; index < commonArgs.length; index += 1) {
    const option = commonArgs[index];
    if (option === "--env") {
      options.envFile = requireValue(commonArgs, index, option);
      index += 1;
    } else if (option === "--version") {
      options.version = requireValue(commonArgs, index, option);
      index += 1;
    } else if (option === "--resume-dir") {
      options.resumeDir = requireValue(commonArgs, index, option);
      index += 1;
    } else if (option === "--replay") {
      options.replayDir = requireValue(commonArgs, index, option);
      index += 1;
    } else if (option === "--clear") {
      options.clear = true;
    } else if (option === "--dry-run") {
      options.dryRun = true;
    } else if (INTEGER_OPTIONS.has(option)) {
      const value = parsePositiveInteger(option, commonArgs[index + 1]);
      const key = INTEGER_OPTIONS.get(option)!;
      (options as unknown as Record<string, unknown>)[key] = value;
      index += 1;
    } else if (SHARED_BOOLEAN_FLAGS.has(option)) {
      options.sharedFlags.push(option);
    } else {
      throw new Error(`${option} is not a common option; put suite-specific options after --`);
    }
  }

  if (!options.envFile) {
    throw new Error("--env is required");
  }
  if (options.toStep !== undefined && options.toStep < options.fromStep) {
    throw new Error("--to-step cannot be lower than --from-step");
  }
  if (options.replayDir) {
    if (options.resumeDir || options.fromStep !== 1 || options.toStep !== undefined) {
      throw new Error("--replay cannot be combined with step or resume options");
    }
  } else if (options.fromStep > 1 && (!options.version || !options.resumeDir)) {
    throw new Error("Resuming requires both --version and --resume-dir");
  } else if (options.resumeDir && options.fromStep === 1) {
    throw new Error("--resume-dir is only valid with --from-step greater than 1");
  }
  validateSuiteArgs(suite, suiteArgs);
  return options;
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
  if (!selected) {
    throw new Error(`Environment file not found: ${input}`);
  }
  return selected;
}

function fileHasContent(path: string, format: "json" | "text" = "json"): boolean {
  if (!existsSync(path) || !statSync(path).isFile()) return false;
  const content = readFileSync(path, "utf8").trim();
  if (format === "text") return content.length > 0;
  return content.length > 2 && content !== "{}" && content !== "[]";
}

function configValue(config: string, key: string): string | undefined {
  const match = config.match(new RegExp(`^${key}=(?:\"([^\"]*)\"|'([^']*)'|([^\\s#]+))`, "m"));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function validateResume(
  options: RunOptions,
  omniRoot: string,
  resumeDir: string,
): void {
  const definition = SUITES[options.suite];
  const expectedRoot = resolve(omniRoot, "results", definition.resultFolder);
  const resolvedResume = resolve(resumeDir);
  const relativePath = relative(expectedRoot, resolvedResume);
  if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
    throw new Error(`Resume directory must be inside ${expectedRoot}`);
  }

  const configPath = join(resolvedResume, "experiment_config.sh");
  if (!existsSync(configPath)) {
    throw new Error(`Resume directory has no experiment_config.sh: ${resolvedResume}`);
  }
  const config = readFileSync(configPath, "utf8");
  if (configValue(config, "LIB") !== "nmg") {
    throw new Error("Resume directory was not produced by the NMG adapter");
  }
  if (configValue(config, "VERSION") !== options.version) {
    throw new Error(
      `Resume version mismatch: expected ${options.version}, found ${configValue(config, "VERSION") ?? "none"}`,
    );
  }
  if (
    options.fromStep >= 2 &&
    !fileHasContent(join(resolvedResume, "success_records.txt"), "text")
  ) {
    throw new Error("Cannot resume after ingestion: success_records.txt is missing or empty");
  }
  if (options.fromStep >= 3 && !fileHasContent(join(resolvedResume, definition.searchArtifact))) {
    throw new Error(`Cannot resume after search: ${definition.searchArtifact} is missing or empty`);
  }
  if (options.fromStep >= 4 && !fileHasContent(join(resolvedResume, definition.responseArtifact))) {
    throw new Error(`Cannot resume after answering: ${definition.responseArtifact} is missing or empty`);
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
  const definition = SUITES[options.suite];
  const runner = join(omniRoot, "scripts", definition.runner);
  if (!existsSync(runner)) {
    throw new Error(`OmniMemEval runner not found: ${runner}. Run npm run benchmark:setup first.`);
  }
  const envFile = resolveEnvFile(repoRoot, omniRoot, options.envFile);
  const version = options.replayDir
    ? undefined
    : options.version ?? generatedVersion(options.suite, overrides.now ?? new Date());

  if (options.resumeDir) {
    validateResume({ ...options, version }, omniRoot, resolve(repoRoot, options.resumeDir));
  }

  const args = [`./scripts/${definition.runner}`, "--lib", "nmg", "--env", envFile.replaceAll("\\", "/")];
  if (options.replayDir) {
    args.push("--replay", resolve(repoRoot, options.replayDir).replaceAll("\\", "/"));
  } else {
    args.push(
      "--version",
      version!,
      "--workers",
      String(options.workers),
      "--llm-workers",
      String(options.llmWorkers),
      "--top-k",
      String(options.topK),
      "--num-runs",
      String(options.numRuns),
      "--from-step",
      String(options.fromStep),
    );
    if (options.toStep !== undefined) args.push("--to-step", String(options.toStep));
    if (options.clear) args.push("--clear");
    args.push(...options.sharedFlags, ...options.suiteArgs);
  }

  const environment = { ...process.env };
  environment.NMG_ROOT = repoRoot;
  environment.PYTHONUTF8 = "1";
  environment.PYTHONIOENCODING = "utf-8";
  const venvFolder = process.platform === "win32" ? "Scripts" : "bin";
  const venvPath = join(repoRoot, ".benchmarks", "omni-venv", venvFolder);
  if (existsSync(venvPath)) {
    environment.PATH = `${venvPath}${process.platform === "win32" ? ";" : ":"}${environment.PATH ?? ""}`;
  }

  return {
    suite: options.suite,
    version,
    repoRoot,
    omniRoot,
    envFile,
    runner,
    bash: findBash(),
    args,
    environment,
  };
}

export function runPlan(plan: RunPlan): number {
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
          runner: plan.runner,
          envFile: plan.envFile,
          command: [plan.bash, ...plan.args],
          note: options.replayDir ? "Official replay is interactive." : undefined,
        },
        null,
        2,
      ),
    );
    if (!options.dryRun) process.exitCode = runPlan(plan);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
