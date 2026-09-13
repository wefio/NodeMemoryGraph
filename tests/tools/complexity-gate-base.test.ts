// Two false greens motivated this file, and both were invisible in the output rather
// than wrong in the logic:
//   1. the gate defaulted to comparing the working tree against HEAD, which skips
//      committed changes by design — on CI's clean checkout it reported "no changed
//      files" for every pull request it was supposed to check;
//   2. a file the linter will not lint produced no findings, which was reported as
//      "0 methods above the limit" — the same output as a file that was measured and is
//      clean.
// The tests below pin the decision (which revision is the baseline), the consequence
// (committed work is in the diff), and the two sentences that make the difference
// observable.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import {
  LINTABLE,
  changedFiles,
  complexitiesFor,
  complexitiesForMany,
  describeBasis,
  describeUnmeasured,
  evaluateComplexityDiff,
  probeDirectory,
  probeExtension,
  resolveBaseRef,
} from "../../tools/complexity-gate.ts";

const root = resolve(import.meta.dirname, "..", "..");
/** Where `complexitiesFor` is asked to put its probe file; it makes the real temp name
 *  unique per call, so one path is enough here. */
const probePath = join(root, "probe-cleanup-check.ts");

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A function far above the gate's limit, so a measured file cannot be clean by accident. */
function complexSource(branches: number): string {
  return (
    "export function tangled(value: number): number {\n" +
    Array.from(
      { length: branches },
      (_, index) => `  if (value === ${index}) return ${index};\n`,
    ).join("") +
    "  return -1;\n}\n"
  );
}

/** A self-contained repository: one commit on main, a remote-tracking ref for it, then a
 *  second commit on a branch. No part of the shared checkout is touched. */
function probeRepository(): { path: string; baseCommit: string } {
  const path = mkdtempSync(join(tmpdir(), "nmg-complexity-basis-"));
  git(["init", "-q", "-b", "main"], path);
  git(["config", "user.email", "probe@example.invalid"], path);
  git(["config", "user.name", "probe"], path);
  writeFileSync(join(path, "base.ts"), "export const base = 1;\n", "utf8");
  git(["add", "."], path);
  git(["commit", "-qm", "base"], path);
  const baseCommit = git(["rev-parse", "HEAD"], path);
  // What a pushed main looks like to the branch that is about to be reviewed.
  git(["update-ref", "refs/remotes/origin/main", baseCommit], path);
  git(["checkout", "-q", "-b", "feature"], path);
  writeFileSync(join(path, "probe-tangled.ts"), complexSource(20), "utf8");
  git(["add", "."], path);
  git(["commit", "-qm", "probe"], path);
  return { path, baseCommit };
}

test("the default baseline is the merge base, so committed branch work is judged", (t) => {
  const { path, baseCommit } = probeRepository();
  t.after(() => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  // The defect: HEAD as the baseline sees only uncommitted work, and this branch is
  // clean, so the gate would have judged nothing at all.
  assert.deepEqual(changedFiles("HEAD", path), []);

  const basis = resolveBaseRef([], path);
  assert.equal(basis.source, "merge-base");
  assert.equal(basis.ref, baseCommit);
  assert.deepEqual(
    changedFiles(basis.ref, path).map((file) => basename(file)),
    ["probe-tangled.ts"],
  );

  // Explicit wins, and a checkout with no merge base to use degrades to the working
  // tree — visibly, which is what `source` is for.
  assert.deepEqual(resolveBaseRef(["--base", "origin/main"], path), {
    ref: "origin/main",
    source: "explicit",
  });
  git(["update-ref", "-d", "refs/remotes/origin/main"], path);
  assert.deepEqual(resolveBaseRef([], path), { ref: "HEAD", source: "head" });
});

test("a measured file above the limit fails the gate; an unmeasured one is named", () => {
  // The comparison half of the same story: once the committed file is in the diff and
  // measured, its complexity is what decides the verdict.
  const finding = { file: "probe-tangled.ts", line: 1, name: "tangled", complexity: 21 };
  const { violations } = evaluateComplexityDiff(
    new Map(),
    new Map([["probe::tangled", finding]]),
    15,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]!, /tangled/);

  // The baseline the gate used is stated in every outcome, success included.
  assert.match(describeBasis({ ref: "origin/main", source: "explicit" }), /--base origin\/main/);
  assert.match(
    describeBasis({ ref: "abc123def4567890", source: "merge-base" }),
    /merge-base origin\/main \(abc123def456\)/,
  );
  assert.match(describeBasis({ ref: "HEAD", source: "head" }), /working-tree changes only/);

  // Files the linter will not measure are named instead of counting as clean.
  assert.equal(describeUnmeasured([], "/cwd"), "");
  assert.match(
    describeUnmeasured(["/cwd/evals/x.ts"], "/cwd"),
    /could not measure 1 changed code file\(s\).*evals\/x\.ts/,
  );
  assert.match(
    describeUnmeasured(["/cwd/evals/x.ts"], "/cwd", "baseline "),
    /1 baseline changed code file/,
  );
});

test("out-of-scope files are not reported as unmeasured", () => {
  // A changed document or lockfile is not a trust hole; only source the linter refused
  // is. Conflating them buries the case that matters in 14 lines of markdown paths.
  for (const file of ["a.ts", "a.tsx", "a.js", "a.mjs", "a.cjs"])
    assert.equal(LINTABLE.test(file), true, file);
  for (const file of ["a.md", "a.json", "a.yaml", "a.py", "a.sql", "a.js.map"])
    assert.equal(LINTABLE.test(file), false, file);
});

test("a file that cannot be parsed is unmeasured, not clean", async (t) => {
  // A syntax error comes back from ESLint as one fatal message and no rule, so a naive
  // "no complexity findings means fine" reading would report a broken file as clean.
  const broken = await complexitiesFor(probePath, "export function broken( { return 1\n");
  assert.equal(broken.measured, false);
  assert.deepEqual(broken.findings, []);

  const clean = await complexitiesFor(probePath, "export const one = 1;\n");
  assert.equal(clean.measured, true);
  assert.deepEqual(clean.findings, []);
  t.diagnostic("complexitiesFor leaves no probe file behind");
});

test("a probe keeps the source extension, so a .mts file is measured", async () => {
  // The probe used to be written as `.js` whenever the path did not end in `.ts`, and
  // `.mts` does not end in `.ts`. The linter then parsed TypeScript as JavaScript, hit a
  // syntax error, and reported the file as "could not measure" — never complexity-checked
  // at all, while the output still looked like an honest unmeasured-file notice. Generic
  // syntax is the tell: `const counts = new Map<string, { name: string }>()` parses as
  // TypeScript and not as JavaScript.
  const measure = await complexitiesFor(join(root, "probe-module.mts"), complexSource(20));
  assert.equal(measure.measured, true);
  assert.equal(measure.findings.length, 1);
  assert.equal(measure.findings[0]!.name, "tangled");

  // The probe name follows the source, not a guess about which extensions matter.
  assert.equal(probeExtension("probe-module.mts"), ".mts");
  assert.equal(probeExtension("probe-module.cts"), ".cts");
  assert.equal(probeExtension("probe-module.jsx"), ".jsx");
  assert.equal(probeExtension("probe-module.tsx"), ".tsx");
  assert.equal(probeExtension("probe-module.mjs"), ".mjs");
  assert.equal(probeExtension("probe-module.js"), ".js");
  assert.equal(probeExtension("probe-module.txt"), ".ts");
});

test("one unparseable file in a batch leaves the others' verdicts alone", async () => {
  // Batching puts many files into one linter run, so the per-file verdict has to survive a
  // neighbour's fatal parse error. If it leaked, the batch would report a healthy file as
  // unmeasured (loud but wrong) or as measured and clean (the false green the gate exists
  // to prevent).
  const [broken, tangled, clean] = await complexitiesForMany([
    { file: join(root, "probe-broken.mts"), source: "export function broken( { return 1\n" },
    { file: join(root, "probe-tangled.mts"), source: complexSource(20) },
    { file: join(root, "probe-clean.mts"), source: "export const one = 1;\n" },
  ]);
  assert.equal(broken!.measured, false);
  assert.deepEqual(broken!.findings, []);
  assert.equal(tangled!.measured, true);
  assert.equal(tangled!.findings.length, 1);
  assert.equal(tangled!.findings[0]!.name, "tangled");
  assert.equal(clean!.measured, true);
  assert.deepEqual(clean!.findings, []);
});

test("probes are written where git cannot see them", () => {
  // `git status --porcelain` is how the gate decides which files are changed, and probes
  // are many now: a run interrupted after three batches left 42 of them in the repository
  // root, each one looking to the next run like a changed code file to measure. The
  // scratch directory has to stay ignored for the gate to keep measuring the diff and
  // nothing else.
  const probe = join(probeDirectory(), "probe-1-1-0.ts");
  assert.doesNotThrow(() =>
    execFileSync("git", ["check-ignore", "-q", relative(root, probe).replaceAll("\\", "/")], {
      cwd: root,
      stdio: "ignore",
    }),
  );
  assert.equal(changedFiles("HEAD", root).includes(probe), false);
});
