// Complexity gate: fail when a changed method's cyclomatic complexity rises
// above the baseline, or when a new method exceeds the configured threshold.
//
// CodeFactor enforces complexity on the PR diff; this script reproduces that
// diff-aware semantics locally so `npm run check`/CI catches it before push.
//
// Rules (matching CodeFactor's default cyclomatic-complexity gate):
//   1. A method present in both the baseline and the change may NOT have its
//      complexity increased.
//   2. A method added by the change must stay at or below `maxComplexity`.
//   3. Unchanged methods and files outside the diff are ignored entirely —
//      pre-existing complexity debt is not this PR's responsibility.
//
// Usage:
//   node --experimental-strip-types tools/complexity-gate.ts [--base <ref>]
//   --base defaults to `git merge-base HEAD origin/main`, so work already committed on a
//   branch is part of the diff. A checkout with no merge base to use falls back to the
//   working tree against HEAD.
//
// Every run states which baseline it used, and names any changed file it could not
// measure. Both sentences exist because their absence produced false greens: a gate that
// compares against the working tree on CI's clean checkout sees no files at all, and a
// file the linter cannot parse yields no findings, which is indistinguishable from a file
// that was measured and is clean.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
/** Distinguishes concurrent runs' temp probe files. */
let probeCounter = 0;
/** The gate judges code. A changed document, schema or lockfile is out of scope rather
 *  than unmeasured: reporting it as "could not measure" would bury the one case that
 *  matters, which is source the linter refused to look at. */
export const LINTABLE = /\.(?:[cm]?[jt]sx?)$/u;
const maxComplexity = 15;

interface ComplexityFinding {
  file: string;
  line: number;
  name: string;
  complexity: number;
}

export interface ComplexityGateResult {
  ok: boolean;
  violations: string[];
  changedFiles: number;
  aboveThresholdUnchanged: number;
}

/** Diff-aware verdict: a changed method may not rise above its baseline, and a
 * new method must respect the cap. Pure and unit-testable. */
export function evaluateComplexityDiff(
  baseline: ReadonlyMap<string, ComplexityFinding>,
  current: ReadonlyMap<string, ComplexityFinding>,
  maxComplexity: number,
): { violations: string[] } {
  const violations: string[] = [];
  for (const [key, finding] of current) {
    const base = baseline.get(key);
    if (!base) {
      // New method: must respect the cap.
      if (finding.complexity > maxComplexity) {
        violations.push(
          `${finding.file}:${finding.line} new method '${finding.name}' has complexity ${finding.complexity} (> ${maxComplexity})`,
        );
      }
    } else if (finding.complexity > base.complexity) {
      violations.push(
        `${finding.file}:${finding.line} '${finding.name}' complexity grew ${base.complexity} -> ${finding.complexity}`,
      );
    }
  }
  return { violations };
}

/** Parse `git status --porcelain` into changed-file paths (tracked modified,
 * staged, and untracked — i.e. every working-tree change). When `ref` is not
 * HEAD, committed differences vs the ref are added too (PR review mode). */
export function changedFiles(ref: string, cwd: string = root): string[] {
  const files: string[] = [];
  if (ref !== "HEAD") {
    const committed = execFileSync("git", ["diff", "--name-only", "--diff-filter=AM", ref], {
      cwd,
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    files.push(...committed);
  }
  // Uncommitted working-tree changes (staged + unstaged + untracked).
  const working = execFileSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter((line) => line && !line.startsWith('"'))
    .map((line) => line.split(" -> ").pop() ?? line);
  files.push(...working);
  return [...new Set(files)].filter(Boolean).map((line) => resolve(cwd, line));
}

/** Complexity of each function in a source file via the eslint CLI with the
 * `complexity` rule. The CLI resolves the repository's flat config (parser,
 * TS support) correctly; lintText with an override config does not. */
export async function complexitiesFor(
  filePath: string,
  source: string,
): Promise<{ findings: ComplexityFinding[]; measured: boolean }> {
  // eslint needs a real file on disk for config matching; write to a temp path that
  // preserves the extension so the TS parser is selected, and make the name unique so
  // concurrent gate runs (the test suite runs files in parallel) cannot collide.
  probeCounter += 1;
  const temp = resolve(
    root,
    `.nmg-complexity-probe-${process.pid}-${probeCounter}` +
      (filePath.endsWith(".ts") ? ".ts" : ".js"),
  );
  const { writeFileSync, rmSync } = await import("node:fs");
  try {
    writeFileSync(temp, source, "utf8");
    // Run eslint through node directly (npx.cmd does not spawn reliably from
    // Node on Windows). eslint exits non-zero when it finds errors, so use
    // spawnSync and read stdout regardless of status.
    const eslintEntry = resolve(root, "node_modules", "eslint", "bin", "eslint.js");
    const result = spawnSync(
      process.execPath,
      [
        eslintEntry,
        "--no-warn-ignored",
        "--format",
        "json",
        "--rule",
        `complexity: ["error", ${maxComplexity}]`,
        temp,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    const output = result.stdout ?? "";
    const parsed = JSON.parse(output) as Array<{
      messages: Array<{ line: number; ruleId: string; message: string; fatal?: boolean }>;
    }>;
    // Three outcomes have to be told apart, because only one of them is evidence: linted
    // with findings, linted with none, and never really linted. ESLint emits no entry at
    // all when it refuses a path, and a file it cannot parse comes back as a single fatal
    // message with no rule. Both are "not measured", and reporting either as "measured
    // and clean" is how this gate produced false greens before.
    const linted = parsed.length > 0 && !parsed.some((r) => r.messages.some((m) => m.fatal));
    return {
      findings: extractComplexityFindings(filePath, source, parsed),
      measured: linted,
    };
  } catch {
    return { findings: [], measured: false };
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

function extractComplexityFindings(
  filePath: string,
  source: string,
  reports: Array<{ messages: Array<{ line: number; ruleId: string; message: string }> }>,
): ComplexityFinding[] {
  const findings: ComplexityFinding[] = [];
  for (const report of reports) {
    for (const message of report.messages) {
      if (message.ruleId !== "complexity") continue;
      const count = Number(/complexity of (\d+)/u.exec(message.message)?.[1] ?? 0);
      const nameMatch =
        /(?:Function|Method|Async arrow function|Async function|Async method|Arrow function|Private method)\s+'([^']+)'/u.exec(
          message.message,
        );
      findings.push({
        file: filePath,
        line: message.line,
        name: nameMatch?.[1] ?? functionIdentityAtLine(filePath, source, message.line),
        complexity: count,
      });
    }
  }
  return findings;
}

/** Stable identity for anonymous callbacks. Line numbers are not identities:
 * inserting code above a callback must not make existing complexity debt look
 * like a newly added function. */
export function functionIdentityAtLine(filePath: string, source: string, line: number): string {
  const scriptKind = filePath.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  let best: ts.FunctionLikeDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && containsLine(sourceFile, node, line)) {
      if (!best || node.getWidth(sourceFile) < best.getWidth(sourceFile)) best = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return best ? functionIdentity(best, sourceFile) : `<line ${line}>`;
}

function containsLine(sourceFile: ts.SourceFile, node: ts.Node, line: number): boolean {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return line >= start && line <= end;
}

function functionIdentity(node: ts.FunctionLikeDeclaration, sourceFile: ts.SourceFile): string {
  if (node.name) return node.name.getText(sourceFile);
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent)) return parent.name.getText(sourceFile);
  if (ts.isPropertyAssignment(parent)) return parent.name.getText(sourceFile);
  if (ts.isCallExpression(parent)) {
    const label = parent.arguments[0];
    const suffix = label && ts.isStringLiteralLike(label) ? `:${label.text}` : "";
    const argumentIndex = parent.arguments.findIndex((argument) => argument === node);
    return `${parent.expression.getText(sourceFile)}${suffix}#${argumentIndex}`;
  }
  return `<anonymous:${node.kind}>`;
}

/** Complexity per (file, method-name) for a whole tree, keyed for diffing, plus the
 *  files the linter would not measure: a gate that cannot say which files it skipped
 *  cannot distinguish a clean tree from one it never looked at. */
async function treeComplexities(
  files: string[],
): Promise<{ findings: Map<string, ComplexityFinding>; unmeasured: string[] }> {
  const findings = new Map<string, ComplexityFinding>();
  const unmeasured: string[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue; // deleted or unreadable — not part of the comparison
    }
    const measured = await complexitiesFor(file, source);
    if (!measured.measured) unmeasured.push(file);
    for (const finding of measured.findings) findings.set(`${file}::${finding.name}`, finding);
  }
  return { findings, unmeasured };
}

/** Which revision the gate compares against, and why. The "why" is printed on every
 *  run: a gate that silently picks a different baseline than the reader assumes produces
 *  exactly one observable outcome — a green line nobody can interpret. */
export interface BaseChoice {
  readonly ref: string;
  readonly source: "explicit" | "merge-base" | "head";
}

/** `--base <ref>` wins. Otherwise the merge base with `origin/main`, so work already
 *  committed on a branch is part of the diff. A checkout with no merge base to use
 *  (shallow, or no `origin/main`) falls back to the working tree against HEAD, and says
 *  so instead of degrading silently. */
export function resolveBaseRef(argv: readonly string[], cwd: string): BaseChoice {
  const flag = argv.indexOf("--base");
  if (flag !== -1) return { ref: argv[flag + 1] ?? "HEAD", source: "explicit" };
  try {
    const mergeBase = execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
      cwd,
      encoding: "utf8",
    }).trim();
    return mergeBase ? { ref: mergeBase, source: "merge-base" } : { ref: "HEAD", source: "head" };
  } catch {
    return { ref: "HEAD", source: "head" };
  }
}

/** The baseline as one readable phrase, on the success line as well as on failure. */
export function describeBasis(choice: BaseChoice): string {
  if (choice.source === "explicit") return `--base ${choice.ref}`;
  if (choice.source === "merge-base")
    return `merge-base origin/main (${choice.ref.slice(0, 12)}): committed and working-tree changes`;
  return "HEAD: working-tree changes only (no merge base with origin/main)";
}

/** Files the gate was asked to judge but could not measure. Empty means it measured
 *  every changed file it read. */
export function describeUnmeasured(
  unmeasured: readonly string[],
  cwd: string = root,
  label = "",
): string {
  if (!unmeasured.length) return "";
  const named = unmeasured.map((file) => file.slice(cwd.length + 1).replaceAll("\\", "/"));
  return `complexity gate: could not measure ${named.length} ${label}changed code file(s) (the linter refused it or could not parse it): ${named.join(", ")}\n`;
}

async function main(): Promise<void> {
  const basis = resolveBaseRef(process.argv.slice(2), root);
  const files = changedFiles(basis.ref, root).filter((file) => LINTABLE.test(file));
  if (files.length === 0) {
    process.stdout.write(`complexity gate: no changed files (${describeBasis(basis)})\n`);
    return;
  }

  // Baseline complexities: read each changed file at the base ref. A file that is absent
  // there is new, which is not the same as a file that could not be read.
  const baseline = new Map<string, ComplexityFinding>();
  const unmeasuredBaseline: string[] = [];
  for (const file of files) {
    const relative = file.slice(root.length + 1).replaceAll("\\", "/");
    let source: string;
    try {
      source = execFileSync("git", ["show", `${basis.ref}:${relative}`], {
        cwd: root,
        encoding: "utf8",
      });
    } catch {
      continue; // file did not exist at base (new file)
    }
    const measured = await complexitiesFor(file, source);
    if (!measured.measured) unmeasuredBaseline.push(file);
    for (const finding of measured.findings) baseline.set(`${file}::${finding.name}`, finding);
  }

  // Current complexities.
  const { findings: current, unmeasured } = await treeComplexities(files);
  const { violations } = evaluateComplexityDiff(baseline, current, maxComplexity);
  // Printed on both outcomes: the reader has to know which files this verdict covers.
  const notes =
    describeUnmeasured(unmeasured, root) +
    describeUnmeasured(unmeasuredBaseline, root, "baseline ");

  if (violations.length > 0) {
    process.stderr.write(
      `complexity gate FAILED (max ${maxComplexity}, ${describeBasis(basis)}):\n${violations
        .map((violation) => `  - ${violation}`)
        .join("\n")}\n${notes}`,
    );
    process.exitCode = 1;
    return;
  }
  const capped = [...current.values()].filter((finding) => finding.complexity > maxComplexity);
  process.stdout.write(
    notes +
      `complexity gate ok: ${files.length} changed code file(s) vs ${describeBasis(basis)}, ` +
      `${capped.length} method(s) above ${maxComplexity} unchanged from baseline\n`,
  );
}

// Only run when this file IS the entry point. Imported by
// tests/tools/complexity-gate.test.ts, an unguarded `main()` re-runs the whole
// gate inside the test process, where `process.argv` is the test runner's and
// the ref argument is not a revision — the verdict then depends on which files
// the bogus ref happens to select.
const isEntryPoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) await main();
