// Which test suites does CI actually run?
//
// The sets are hand-maintained glob lists inside npm scripts, so a new suite can quietly land
// outside every job and nobody is told. This derives the answer instead: it reads the scripts the
// CI jobs call, expands their globs, and reports every test file no job reaches.
//
// Two modes:
//   --list   print runnable unreached suites, one per line (the on-demand workflow runs them)
//   --check  fail when an unreached file sits outside an acknowledged root
//
// The acknowledged root is a deliberate decision, not an accident of naming: research harnesses
// under `evals/` drive real worktrees, real child processes and (for live rounds) a paid provider,
// which is why they are opt-in rather than required checks. Archived run directories are the
// second case: a finished run's candidate tree holds the `.test.ts` files it was judged on as
// evidence of that run, not as suites anyone maintains, so scanning them is a false positive.
// Anything *else* that falls out of CI has to be acknowledged here on purpose.
import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The entry points of the CI jobs, in .github/workflows/ci.yml. */
const CI_ENTRY_POINTS = ["verify:product-ci", "verify:research", "verify:chaos", "verify:onlion"];

/** A second manifest whose suites live in its own script set. Service tests are
 *  `scripts/test-*.mjs` invoked by name rather than globbed `.test.ts` files, so both
 *  the universe and the resolution need to know about them - otherwise a whole
 *  production surface sits outside every CI job and outside this gate, which is
 *  exactly how six defects reached a green commit. */
const SERVICE_ROOT = "onlion";

/** Specific roots precede their parent. Acknowledgement does not imply standalone execution. */
const ACKNOWLEDGED_ROOTS = [
  {
    prefix: "evals/ooo-execution/fixtures/",
    onDemand: false,
    reason: "fixture checks run through their harness",
  },
  { prefix: "evals/", onDemand: true, reason: "on-demand only" },
  {
    prefix: "onlion/scripts/test-cos-bucket.mjs",
    onDemand: true,
    reason: "needs a real COS bucket and credentials",
  },
  {
    prefix: "onlion/scripts/test-edgeone-worker.mjs",
    onDemand: true,
    reason: "needs a deployed endpoint and credentials",
  },
  {
    prefix: "onlion/scripts/test-capacity.mjs",
    onDemand: true,
    reason: "asserts the synchronous accept path; not yet ported to the log default",
  },
  {
    prefix: "onlion/scripts/test-request-resume.mjs",
    onDemand: true,
    reason: "asserts the synchronous accept path; not yet ported to the log default",
  },
  {
    prefix: "docs/experiments/execution/archive/",
    onDemand: false,
    reason: "archived candidate evidence",
  },
];

function acknowledgedRoot(file: string) {
  return ACKNOWLEDGED_ROOTS.find(({ prefix }) => file.startsWith(prefix));
}

type Scripts = Record<string, string>;

/** Follows `npm run <name>` chains so a job's script can be read for its own globs.
 *  A `cd onlion && ...` segment switches to that manifest; a `node <file>` segment
 *  names the file it runs, which is how the service suites are invoked. */
function scriptGlobs(
  name: string,
  scripts: Scripts,
  manifests: Record<string, Scripts>,
  prefix = "",
  seen = new Set<string>(),
): string[] {
  const key = prefix + name;
  if (seen.has(key)) return [];
  seen.add(key);
  const command = scripts[name];
  if (command === undefined) {
    // A root entry point that names a script nobody defines is drift and must be loud. A
    // subpackage script that is absent contributes nothing: the job that runs that package
    // would fail at `npm run <name>` on its own, so this gate does not duplicate it.
    if (prefix) return [];
    throw new Error(`no such script: ${key}`);
  }
  const globs: string[] = [];
  for (const segment of command.split("&&")) {
    const part = segment.trim();
    const nested = /^cd\s+([\w./-]+)$/.exec(part);
    if (nested) {
      prefix = nested[1]!.replace(/\/$/u, "") + "/";
      continue;
    }
    const run = /^npm run ([a-zA-Z0-9:_-]+)$/.exec(part);
    if (run) {
      globs.push(...scriptGlobs(run[1]!, manifests[prefix] ?? {}, manifests, prefix, seen));
      continue;
    }
    const node = /^node\s+(?:--\S+\s+)*(\S+\.(?:mjs|cjs|js|ts|mts))$/.exec(part);
    if (node) globs.push(prefix + node[1]!);
  }
  for (const match of command.matchAll(/"([^"]*\*[^"]*)"/g)) globs.push(prefix + match[1]!);
  return globs;
}

export interface Coverage {
  globs: string[];
  covered: Set<string>;
  unreached: string[];
  onDemand: string[];
  unacknowledged: string[];
}

/** Every test file in the repository, and which of them the CI jobs reach. */
export function testCoverage(root: string): Coverage {
  // A manifest that is not there contributes no scripts: this gate is also run against
  // synthetic repositories in its own tests, which carry a root manifest and nothing else.
  const read = (dir: string) => {
    const file = join(root, dir, "package.json");
    if (!existsSync(file)) return {};
    return (JSON.parse(readFileSync(file, "utf8")) as { scripts: Scripts }).scripts;
  };
  const manifests: Record<string, Scripts> = {
    "": read(""),
    [`${SERVICE_ROOT}/`]: read(SERVICE_ROOT),
  };
  const globs = [
    ...new Set(CI_ENTRY_POINTS.flatMap((name) => scriptGlobs(name, manifests[""]!, manifests))),
  ];
  const covered = new Set<string>();
  for (const glob of globs)
    for (const file of globSync(glob, { cwd: root })) covered.add(file.replaceAll("\\", "/"));
  // Only files the repository actually contains: another agent's untracked work in progress is
  // not part of it yet, and judging it here would report a gap nobody has committed.
  // The service suites are `scripts/test-*.mjs`, invoked by name rather than globbed, so
  // they are part of the universe too - otherwise a whole production surface sits outside
  // every CI job and outside this gate.
  const all = execFileSync("git", ["ls-files", "*.test.ts", `${SERVICE_ROOT}/scripts/test-*.mjs`], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
  const unreached = all.filter((file) => !covered.has(file)).sort();
  return {
    globs,
    covered,
    unreached,
    onDemand: unreached.filter((file) => acknowledgedRoot(file)?.onDemand !== false),
    unacknowledged: unreached.filter((file) => !acknowledgedRoot(file)),
  };
}

function main(argv: readonly string[], root: string): number {
  const mode = argv[0] ?? "--check";
  const coverage = testCoverage(root);
  // `process.stdout.write`, not `console.log`: this is a tool that pipes its output (the
  // on-demand workflow runs the listed files), and the repository's lint warns on console.
  if (mode === "--list") {
    for (const file of coverage.onDemand) process.stdout.write(`${file}\n`);
    return 0;
  }
  if (mode !== "--check") throw new Error(`unknown mode: ${mode} (use --check or --list)`);
  // State the basis on success as well as failure: a gate that only speaks when it fails cannot
  // be told apart from one that never looked.
  process.stdout.write(
    `ci coverage: ${coverage.globs.length} glob(s) from ${CI_ENTRY_POINTS.join(", ")}, ` +
      `${coverage.covered.size} test file(s) reached, ${coverage.unreached.length} unreached, ` +
      `${coverage.onDemand.length} runnable on demand\n`,
  );
  for (const file of coverage.unreached) {
    const root = acknowledgedRoot(file);
    process.stdout.write(
      `  unreached: ${file}` +
        (root
          ? ` (acknowledged: ${root.reason})\n`
          : " (NOT acknowledged: add it to a CI job or to ACKNOWLEDGED_ROOTS with a reason)\n"),
    );
  }
  if (coverage.unacknowledged.length) {
    process.stderr.write(
      `ci coverage FAILED: ${coverage.unacknowledged.length} test file(s) are in no CI job and not acknowledged\n`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1]?.endsWith("ci-uncovered-tests.ts") ?? false)
  process.exitCode = main(process.argv.slice(2), process.cwd());
