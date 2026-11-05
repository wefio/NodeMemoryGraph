// Which layer of the pyramid a test file belongs to, derived from what it crosses.
//
// The pyramid is about cost and isolation, not folder names, so the layer is read from the
// test's own source: a test that spawns the product binary pays for a process boundary, a
// test that opens a real SQLite file or a temp directory pays for the filesystem, and what
// remains runs in process with nothing to fake. A folder-based table would be a second copy
// of that fact, and `tests/core` alone holds all three (a pure ranking test, a store test on
// a real database file, and a test that starts the CLI).
//
// Measured 2026-11-05 on the product suite (8-way concurrency). Case time is the sum of the
// per-test durations, so it is bigger than the wall clock the suite actually takes:
//
//   unit         154 files   16 s    median file 0.12 s, 172 of 243 files under 0.5 s
//   integration  122 files  154 s    real SQLite, temp dirs, local servers
//   e2e           30 files  166 s    spawns a child process; five files are 40% of the suite
//
// Modes:
//   --list <layer>   print that layer's files, one per line
//   --stats          files, cases and case time per layer
//   --run <layer>    run the layer through `node --test`; other flags after the layer are
//                    forwarded, so `--run unit --watch` is the inner loop
//   --run <layer> --coverage
//                    the same run under c8, reported over the modules that layer loads
//   --coverage       all three layers, then each module assigned to the cheapest layer that
//                    reaches 90% of its lines, so a tier is judged on its own surface
//   --check          fail when a file falls outside every layer, when an override points at
//                    a file that moved, or when an override stopped mattering
import { globSync, existsSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

export type TestLayer = "unit" | "integration" | "e2e";

/** Cheapest first: this is the order the pyramid asks a developer to run. */
export const LAYERS: readonly TestLayer[] = ["unit", "integration", "e2e"];

/**
 * A child process is the boundary that makes a test end-to-end. Everything the test asserts
 * about the product now travels through argv, stdio and an exit code, so a failure there is
 * a claim about the assembled product, not about a function.
 *
 * The daemon client is the same boundary reached indirectly: it starts the built CLI from
 * `dist/`, so a test that never calls `spawn` itself still fails for want of a build. That
 * reference lives in an import path, which is a string, so it is matched on the raw source
 * rather than on the executable code below.
 */
const SPAWNS_PROCESS =
  /\b(?:spawn|spawnSync|execFile|execFileSync|execSync|fork|connectDaemon)\s*\(/;

/** Paths that mean "this test starts the product": the daemon client and the built CLI. */
const STARTS_PRODUCT = /daemon-client|dist\/cli\/main\.js|bin\/nmg\.mjs/;

/**
 * A real dependency the test neither owns nor mocks: a database file, a temp directory, a
 * listening socket. The assertions are still in process, which keeps the failure readable,
 * but the setup can fail for reasons the code under test did not cause.
 */
const REAL_DEPENDENCY =
  /(?:DatabaseSync|node:sqlite|mkdtemp|tmpdir\(\)|createServer|\.listen\(|writeFileSync|mkdirSync|rmSync)/;

/**
 * Deliberate exceptions, keyed by repository-relative path. Each one must say why the marker
 * is wrong, because the alternative is a reviewer guessing whether the exception is load
 * bearing. `--check` fails on a path that no longer exists, so the list cannot rot silently.
 */
export const OVERRIDES: ReadonlyMap<string, { layer: TestLayer; reason: string }> = new Map([
  // Example of the shape, kept empty until a real disagreement shows up:
  // ["tests/core/example.test.ts", { layer: "integration", reason: "..." }],
] as const);

/** `tests/**\/*.test.ts`, repository-relative and forward-slashed on every platform. */
export function collectTestFiles(root = process.cwd()): string[] {
  return globSync("tests/**/*.test.ts", { cwd: root })
    .map((file) => file.split("\\").join("/"))
    .sort();
}

/**
 * The layer of one test file. `path` is only consulted for the override table and the
 * diagnostics; the decision itself comes from `source`.
 */
export function classifyTest(
  path: string,
  source: string,
  overrides: ReadonlyMap<string, { layer: TestLayer; reason: string }> = OVERRIDES,
): TestLayer {
  const override = overrides.get(path);
  if (override) return override.layer;
  return derivedLayer(source);
}

/**
 * What the test runs, minus what it merely mentions. A file that quotes `spawn(...)` in a
 * comment or a fixture string is describing the boundary, not crossing it, and the guard test
 * for this classifier does exactly that.
 */
function executedCode(source: string): string {
  return source
    .replace(/'(?:[^'\\\n]|\\.)*'/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

/** What the source itself says, before any override has a say. */
function derivedLayer(source: string): TestLayer {
  if (STARTS_PRODUCT.test(source) || SPAWNS_PROCESS.test(executedCode(source))) return "e2e";
  if (REAL_DEPENDENCY.test(executedCode(source))) return "integration";
  return "unit";
}

export interface LayerReport {
  files: string[];
  /** How the decision was reached, for `--why`. */
  evidence: Map<string, string>;
}

/** Classify every test file under `root`. */
export function partitionTests(
  root = process.cwd(),
  overrides: ReadonlyMap<string, { layer: TestLayer; reason: string }> = OVERRIDES,
): Map<TestLayer, LayerReport> {
  const report = new Map<TestLayer, LayerReport>(
    LAYERS.map((layer) => [layer, { files: [], evidence: new Map() }]),
  );
  for (const file of collectTestFiles(root)) {
    const source = readFileSync(join(root, file), "utf8");
    const layer = classifyTest(file, source, overrides);
    const bucket = report.get(layer)!;
    bucket.files.push(file);
    const override = overrides.get(file);
    bucket.evidence.set(
      file,
      override
        ? `override: ${override.reason}`
        : layer === "e2e"
          ? "spawns a child process or starts the built daemon"
          : layer === "integration"
            ? "opens a real database, temp directory or socket"
            : "no process, database or socket",
    );
  }
  return report;
}

/** Problems worth failing on. Empty means the classification still describes the suite. */
export function checkLayers(
  root = process.cwd(),
  overrides: ReadonlyMap<string, { layer: TestLayer; reason: string }> = OVERRIDES,
): string[] {
  const errors: string[] = [];
  const report = partitionTests(root, overrides);
  const files = collectTestFiles(root);
  const classified = LAYERS.reduce((sum, layer) => sum + report.get(layer)!.files.length, 0);
  if (classified !== files.length) {
    errors.push(`partition covers ${classified} of ${files.length} test files`);
  }

  for (const [file, override] of overrides) {
    if (!files.includes(file)) {
      errors.push(`override for ${file} points at a file that no longer exists`);
      continue;
    }
    const derived = derivedLayer(readFileSync(join(root, file), "utf8"));
    if (derived === override.layer) {
      errors.push(`override for ${file} is redundant: the source already reads as ${derived}`);
    }
  }
  return errors;
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;
}

function printStats(root: string): void {
  const report = partitionTests(root);
  const total = LAYERS.reduce((sum, layer) => sum + report.get(layer)!.files.length, 0);
  console.log(`layer        files  share`);
  for (const layer of LAYERS) {
    const files = report.get(layer)!.files.length;
    console.log(`${layer.padEnd(12)} ${String(files).padStart(5)}  ${percent(files, total)}`);
  }
  console.log(`${"total".padEnd(12)} ${String(total).padStart(5)}`);
}

function runLayer(root: string, layer: TestLayer, forwarded: string[]): Promise<number> {
  const report = partitionTests(root);
  const files = report.get(layer)!.files;
  if (files.length === 0) {
    console.error(`no test files classified as ${layer}`);
    return Promise.resolve(1);
  }
  const child = spawn(process.execPath, testArgs(forwarded, files), {
    cwd: root,
    stdio: "inherit",
  });
  return new Promise((done) => {
    child.on("close", (code, signal) => {
      if (signal) console.error(`${layer} interrupted by ${signal}`);
      done(code ?? 1);
    });
  });
}

function testArgs(forwarded: string[], files: string[]): string[] {
  return ["--experimental-strip-types", "--test", "--test-concurrency=8", ...forwarded, ...files];
}

/** One file's line coverage, as c8 writes it into `coverage-summary.json`. */
interface FileCoverage {
  lines: { total: number; covered: number; pct: number };
}

type CoverageSummary = Record<string, FileCoverage>;

/** c8's own entry point, resolved so the script does not depend on a shell shim. */
function c8Entry(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("c8/package.json")), "bin", "c8.js");
}

/** `src/...`, whatever the worktree path in front of it happens to be. */
function moduleName(file: string): string {
  const normal = file.split("\\").join("/");
  const at = normal.indexOf("/src/");
  return at >= 0 ? normal.slice(at + 1) : normal;
}

/** Modules with at least one instrumented line, keyed by repository-relative name. */
function readSummary(directory: string): Map<string, FileCoverage> {
  const file = join(directory, "coverage-summary.json");
  if (!existsSync(file)) return new Map();
  const parsed = JSON.parse(readFileSync(file, "utf8")) as CoverageSummary;
  const modules = new Map<string, FileCoverage>();
  for (const [path, coverage] of Object.entries(parsed)) {
    if (path === "total" || coverage.lines.total === 0) continue;
    const name = moduleName(path);
    if (!name.startsWith("src/")) continue;
    modules.set(name, coverage);
  }
  return modules;
}

interface TierCoverage {
  layer: TestLayer;
  modules: Map<string, FileCoverage>;
  durationSeconds: number;
  exitCode: number;
}

/** Run one layer under c8 and keep its per-module line counts. */
async function coverLayer(
  root: string,
  layer: TestLayer,
  forwarded: string[],
  reportRoot: string,
): Promise<TierCoverage> {
  const report = partitionTests(root);
  const files = report.get(layer)!.files;
  const directory = join(root, reportRoot, layer);
  rmSync(directory, { recursive: true, force: true });
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [
      c8Entry(),
      "--reporter=json-summary",
      `--report-dir=${directory}`,
      process.execPath,
      ...testArgs(forwarded, files),
    ],
    { cwd: root, stdio: "inherit" },
  );
  const exitCode = await new Promise<number>((done) =>
    child.on("close", (code) => done(code ?? 1)),
  );
  return {
    layer,
    modules: readSummary(directory),
    durationSeconds: (Date.now() - started) / 1000,
    exitCode,
  };
}

/** Covered and total lines across a set of modules. */
function lineTotals(modules: Iterable<FileCoverage>): { covered: number; total: number } {
  let covered = 0;
  let total = 0;
  for (const module of modules) {
    covered += module.lines.covered;
    total += module.lines.total;
  }
  return { covered, total };
}

function sortedGaps(modules: Map<string, FileCoverage>, below: number): Array<[string, number]> {
  return [...modules.entries()]
    .filter(([, coverage]) => coverage.lines.pct < below)
    .map(([name, coverage]): [string, number] => [name, coverage.lines.pct])
    .sort((a, b) => a[1] - b[1]);
}

/** How much of a module a tier must reach before the module counts as that tier's own. */
const OWNERSHIP_TARGET = 90;

function reportSingleTier(tier: TierCoverage): void {
  const totals = lineTotals(tier.modules.values());
  console.log(
    `${tier.layer} coverage: ${percent(totals.covered, totals.total)} of ${totals.total} lines ` +
      `in ${tier.modules.size} modules (${tier.durationSeconds.toFixed(0)}s, exit ${tier.exitCode})`,
  );
  const gaps = sortedGaps(tier.modules, OWNERSHIP_TARGET);
  if (gaps.length > 0) {
    console.log(`  below ${OWNERSHIP_TARGET}%:`);
    for (const [name, pct] of gaps.slice(0, 8))
      console.log(`    ${pct.toFixed(1).padStart(5)}%  ${name}`);
    if (gaps.length > 8) console.log(`    ... ${gaps.length - 8} more`);
  }
}

/**
 * A module belongs to the cheapest tier that reaches `OWNERSHIP_TARGET` of its lines; when no
 * tier does, it belongs to the tier that reaches furthest. Judging the unit tier by lines only
 * a daemon can reach would push it toward faking I/O, and judging it by the whole of `src`
 * would make the number move whenever an unrelated e2e test changed.
 */
export function assignOwnership(
  tiers: ReadonlyArray<{ layer: TestLayer; modules: Map<string, FileCoverage> }>,
): Map<TestLayer, Map<string, FileCoverage>> {
  const owned = new Map<TestLayer, Map<string, FileCoverage>>(LAYERS.map((l) => [l, new Map()]));
  const everyModule = new Set<string>();
  for (const tier of tiers) for (const name of tier.modules.keys()) everyModule.add(name);

  for (const name of everyModule) {
    const reached = tiers.map((tier) => ({ tier, coverage: tier.modules.get(name) }));
    const eligible = reached.find(
      (r) => r.coverage !== undefined && r.coverage.lines.pct >= OWNERSHIP_TARGET,
    );
    const chosen =
      eligible ??
      reached.reduce((best, current) =>
        (current.coverage?.lines.pct ?? -1) > (best.coverage?.lines.pct ?? -1) ? current : best,
      );
    if (chosen.coverage) owned.get(chosen.tier.layer)!.set(name, chosen.coverage);
  }
  return owned;
}

function reportOwnership(tiers: TierCoverage[]): void {
  const owned = assignOwnership(tiers);
  console.log(`\nlayer        modules  lines   coverage  gaps below ${OWNERSHIP_TARGET}%`);
  for (const layer of LAYERS) {
    const modules = owned.get(layer)!;
    const totals = lineTotals(modules.values());
    const gaps = sortedGaps(modules, OWNERSHIP_TARGET);
    console.log(
      `${layer.padEnd(12)} ${String(modules.size).padStart(6)}  ${String(totals.total).padStart(6)}  ` +
        `${percent(totals.covered, totals.total).padStart(8)}  ${gaps.length === 0 ? "-" : gaps.length}`,
    );
    for (const [name, pct] of gaps.slice(0, 5))
      console.log(`    ${pct.toFixed(1).padStart(5)}%  ${name}`);
    if (gaps.length > 5) console.log(`    ... ${gaps.length - 5} more`);
  }
}

async function main(argv: string[]): Promise<number> {
  const root = resolve(process.cwd());
  const [flag, argument, ...rest] = argv;

  if (flag === "--stats") {
    printStats(root);
    return 0;
  }
  if (flag === "--check") {
    const errors = checkLayers(root);
    for (const error of errors) console.error(error);
    return errors.length === 0 ? 0 : 1;
  }
  if (flag === "--list") {
    if (!LAYERS.includes(argument as TestLayer)) {
      console.error(`--list needs one of: ${LAYERS.join(", ")}`);
      return 1;
    }
    const report = partitionTests(root).get(argument as TestLayer)!;
    for (const file of report.files) console.log(file);
    return 0;
  }
  if (flag === "--why") {
    const report = partitionTests(root);
    for (const layer of LAYERS) {
      const evidence = report.get(layer)!.evidence.get(argument);
      if (evidence) {
        console.log(`${argument}: ${layer} (${evidence})`);
        return 0;
      }
    }
    console.error(`${argument} is not a test file under tests/`);
    return 1;
  }
  if (flag === "--run") {
    if (!LAYERS.includes(argument as TestLayer)) {
      console.error(`--run needs one of: ${LAYERS.join(", ")}`);
      return 1;
    }
    const layer = argument as TestLayer;
    if (!rest.includes("--coverage")) return runLayer(root, layer, rest);
    const forwarded = rest.filter((value) => value !== "--coverage");
    const tier = await coverLayer(root, layer, forwarded, "coverage/layers");
    reportSingleTier(tier);
    return tier.exitCode;
  }
  if (flag === "--coverage") {
    const tiers: TierCoverage[] = [];
    for (const layer of LAYERS) {
      const tier = await coverLayer(root, layer, rest, "coverage/layers");
      tiers.push(tier);
      reportSingleTier(tier);
    }
    reportOwnership(tiers);
    return tiers.some((tier) => tier.exitCode !== 0) ? 1 : 0;
  }
  console.error(
    "usage: test-layers.ts --list <layer> | --run <layer> [--coverage] [node --test flags] | " +
      "--coverage | --stats | --check | --why <file>",
  );
  return 1;
}

// Only run when invoked as a program, so the guard test can import the classifier.
if (process.argv[1]?.replace(/\\/g, "/").endsWith("tools/test-layers.ts")) {
  process.exit(await main(process.argv.slice(2)));
}
