// Which test suites does CI actually run?
//
// The sets are hand-maintained glob lists inside npm scripts, so a new suite can quietly land
// outside every job and nobody is told. This derives the answer instead: it reads the scripts the
// CI jobs call, expands their globs, and reports every test file no job reaches.
//
// Two modes:
//   --list   print the unreached files, one per line (the on-demand workflow runs them)
//   --check  fail when an unreached file sits outside an acknowledged root
//
// The acknowledged root is a deliberate decision, not an accident of naming: research harnesses
// under `evals/` drive real worktrees, real child processes and (for live rounds) a paid provider,
// which is why they are opt-in rather than required checks. Anything *else* that falls out of CI
// has to be acknowledged here on purpose.
import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The entry points of the CI jobs, in .github/workflows/ci.yml. */
const CI_ENTRY_POINTS = ["verify:product-ci", "verify:research", "verify:chaos"];

/** Unreached suites that may stay out of the required checks, with the reason they may. */
const ACKNOWLEDGED_ROOTS = ["evals/"];

type Scripts = Record<string, string>;

/** Follows `npm run <name>` chains so a job's script can be read for its own globs. */
function scriptGlobs(name: string, scripts: Scripts, seen = new Set<string>()): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const command = scripts[name];
  if (command === undefined) throw new Error(`no such script: ${name}`);
  const globs: string[] = [];
  for (const match of command.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g))
    globs.push(...scriptGlobs(match[1]!, scripts, seen));
  for (const match of command.matchAll(/"([^"]*\*[^"]*)"/g)) globs.push(match[1]!);
  return globs;
}

export interface Coverage {
  globs: string[];
  covered: Set<string>;
  unreached: string[];
  unacknowledged: string[];
}

/** Every test file in the repository, and which of them the CI jobs reach. */
export function testCoverage(root: string): Coverage {
  const scripts = (
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Scripts }
  ).scripts;
  const globs = [...new Set(CI_ENTRY_POINTS.flatMap((name) => scriptGlobs(name, scripts)))];
  const covered = new Set<string>();
  for (const glob of globs)
    for (const file of globSync(glob, { cwd: root })) covered.add(file.replaceAll("\\", "/"));
  // Only files the repository actually contains: another agent's untracked work in progress is
  // not part of it yet, and judging it here would report a gap nobody has committed.
  const all = execFileSync("git", ["ls-files", "*.test.ts"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
  const unreached = all.filter((file) => !covered.has(file)).sort();
  return {
    globs,
    covered,
    unreached,
    unacknowledged: unreached.filter(
      (file) => !ACKNOWLEDGED_ROOTS.some((prefix) => file.startsWith(prefix)),
    ),
  };
}

function main(argv: readonly string[], root: string): number {
  const mode = argv[0] ?? "--check";
  const coverage = testCoverage(root);
  // `process.stdout.write`, not `console.log`: this is a tool that pipes its output (the
  // on-demand workflow runs the listed files), and the repository's lint warns on console.
  if (mode === "--list") {
    for (const file of coverage.unreached) process.stdout.write(`${file}\n`);
    return 0;
  }
  if (mode !== "--check") throw new Error(`unknown mode: ${mode} (use --check or --list)`);
  // State the basis on success as well as failure: a gate that only speaks when it fails cannot
  // be told apart from one that never looked.
  process.stdout.write(
    `ci coverage: ${coverage.globs.length} glob(s) from ${CI_ENTRY_POINTS.join(", ")}, ` +
      `${coverage.covered.size} test file(s) reached, ${coverage.unreached.length} unreached\n`,
  );
  for (const file of coverage.unreached)
    process.stdout.write(
      `  unreached: ${file}` +
        (ACKNOWLEDGED_ROOTS.some((prefix) => file.startsWith(prefix))
          ? " (acknowledged: on-demand only)\n"
          : " (NOT acknowledged: add it to a CI job or to ACKNOWLEDGED_ROOTS with a reason)\n"),
    );
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
