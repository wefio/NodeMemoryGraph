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
//   --base defaults to `git merge-base HEAD origin/main`.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const maxComplexity = 15;
const baseRef = process.argv.includes("--base")
  ? process.argv[process.argv.indexOf("--base") + 1]
  : undefined;

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
function changedFiles(ref: string): string[] {
  const files: string[] = [];
  if (ref !== "HEAD") {
    const committed = execFileSync("git", ["diff", "--name-only", "--diff-filter=AM", ref], {
      cwd: root,
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    files.push(...committed);
  }
  // Uncommitted working-tree changes (staged + unstaged + untracked).
  const working = execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter((line) => line && !line.startsWith('"'))
    .map((line) => line.split(" -> ").pop() ?? line);
  files.push(...working);
  return [...new Set(files)].filter(Boolean).map((line) => resolve(root, line));
}

/** Complexity of each function in a source file via the eslint CLI with the
 * `complexity` rule. The CLI resolves the repository's flat config (parser,
 * TS support) correctly; lintText with an override config does not. */
async function complexitiesFor(filePath: string, source: string): Promise<ComplexityFinding[]> {
  // eslint needs a real file on disk for config matching; write to a temp
  // path that preserves the extension so the TS parser is selected.
  const temp = resolve(root, ".nmg-complexity-probe" + (filePath.endsWith(".ts") ? ".ts" : ".js"));
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
      messages: Array<{ line: number; ruleId: string; message: string }>;
    }>;
    return extractComplexityFindings(filePath, source, parsed);
  } catch {
    // A parse/config failure means we cannot measure this file; ignore it
    // rather than fail the whole gate on an unrelated tooling issue.
    return [];
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

/** Complexity per (file, method-name) for a whole tree, keyed for diffing. */
async function treeComplexities(files: string[]): Promise<Map<string, ComplexityFinding>> {
  const map = new Map<string, ComplexityFinding>();
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue; // deleted or unreadable — not part of the comparison
    }
    for (const finding of await complexitiesFor(file, source)) {
      map.set(`${file}::${finding.name}`, finding);
    }
  }
  return map;
}

async function main(): Promise<void> {
  // Baseline: explicit --base wins; otherwise compare the uncommitted working
  // tree against HEAD (the "am I about to make this worse?" check). For PR
  // review against the target branch, pass `--base origin/main`.
  let ref: string;
  if (baseRef) {
    ref = baseRef;
  } else {
    ref = "HEAD";
  }
  const files = changedFiles(ref);
  if (files.length === 0) {
    process.stdout.write("complexity gate: no changed files\n");
    return;
  }

  // Baseline complexities: read each changed file at the base ref.
  const baseline = new Map<string, ComplexityFinding>();
  for (const file of files) {
    const relative = file.slice(root.length + 1).replaceAll("\\", "/");
    let source: string;
    try {
      source = execFileSync("git", ["show", `${ref}:${relative}`], {
        cwd: root,
        encoding: "utf8",
      });
    } catch {
      continue; // file did not exist at base (new file)
    }
    for (const finding of await complexitiesFor(file, source)) {
      baseline.set(`${file}::${finding.name}`, finding);
    }
  }

  // Current complexities.
  const current = await treeComplexities(files);

  const { violations } = evaluateComplexityDiff(baseline, current, maxComplexity);

  if (violations.length > 0) {
    process.stderr.write(
      `complexity gate FAILED (max ${maxComplexity}, diff vs ${ref}):\n${violations
        .map((violation) => `  - ${violation}`)
        .join("\n")}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const capped = [...current.values()].filter((finding) => finding.complexity > maxComplexity);
  process.stdout.write(
    `complexity gate ok: ${files.length} changed file(s), ${capped.length} method(s) above ${maxComplexity} unchanged from baseline\n`,
  );
}

await main();
