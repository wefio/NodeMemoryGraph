/** Research probe: find test files that can import a changed module. Its output is
 * a candidate set, never a verification verdict: imports alone miss file reads,
 * computed module paths, and behavioral obligations. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import ts from "typescript";

import { testOutputPassed } from "../src/rcp/trusted.ts";

interface ImpactPlan {
  source: string;
  verdict: "candidate-only";
  fullGateRequired: true;
  snapshotDigest: string;
  scannedFiles: number;
  productTests: number;
  candidateTests: string[];
  affectedOutsideProduct: string[];
  unresolvedImports: string[];
  limitations: string[];
}

const MODULE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".cts", "/index.ts"];

function repositoryFiles(root: string): string[] {
  const git = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (git.error || git.status !== 0) throw new Error(`Git file inventory failed: ${git.stderr}`);
  return [
    ...new Set(
      git.stdout
        .split("\0")
        .filter(Boolean)
        .map((path) => path.replaceAll("\\", "/")),
    ),
  ].sort();
}

function sourceFiles(files: string[]): string[] {
  return files.filter((path) => /\.(?:c|m)?tsx?$/.test(path));
}

function productTestFiles(root: string, files: Set<string>): Set<string> {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const script = packageJson.scripts?.["test:product"];
  if (!script) throw new Error("test:product script is missing");
  const patterns = [...script.matchAll(/"(tests\/[^"\s]+\.test\.ts)"/g)].map((match) => match[1]!);
  if (!patterns.length) throw new Error("test:product has no parseable test globs");
  const tests = new Set<string>();
  for (const pattern of patterns) {
    for (const match of globSync(pattern, { cwd: root })) {
      const path = match.replaceAll("\\", "/");
      if (files.has(path)) tests.add(path);
    }
  }
  if (!tests.size) throw new Error("test:product matched no tracked tests");
  return tests;
}

function resolveLocalImport(
  from: string,
  specifier: string,
  files: Set<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier);
  for (const suffix of MODULE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (files.has(candidate)) return candidate;
  }
  if (base.endsWith(".js")) {
    const candidate = `${base.slice(0, -3)}.ts`;
    if (files.has(candidate)) return candidate;
  }
  return undefined;
}

function moduleSpecifiers(
  path: string,
  source: string,
): { specifiers: string[]; unknown: string[] } {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const unknown: string[] = [];
  const add = (value: ts.Expression | undefined, kind: string) => {
    if (value && ts.isStringLiteralLike(value)) specifiers.push(value.text);
    else unknown.push(`${path}: ${kind} has a computed path`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node.moduleSpecifier, "module declaration");
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression, "import equals");
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0], "import()");
      if (ts.isIdentifier(node.expression) && node.expression.text === "require")
        add(node.arguments[0], "require()");
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { specifiers, unknown };
}

function scanImports(
  root: string,
  sources: string[],
  sourceSet: Set<string>,
  digest: ReturnType<typeof createHash>,
): { reverse: Map<string, Set<string>>; unresolved: string[] } {
  const reverse = new Map<string, Set<string>>();
  const unresolved: string[] = [];
  for (const path of sources) {
    const absolute = resolve(root, path);
    const content = readFileSync(absolute, "utf8");
    digest.update(path).update("\0").update(content).update("\0");
    const imports = moduleSpecifiers(path, content);
    unresolved.push(...imports.unknown);
    for (const specifier of imports.specifiers) {
      if (!specifier.startsWith(".")) continue;
      const dependency = resolveLocalImport(absolute, specifier, sourceSet);
      if (!dependency) {
        unresolved.push(`${path}: unresolved ${specifier}`);
        continue;
      }
      const consumers = reverse.get(dependency) ?? new Set<string>();
      consumers.add(absolute);
      reverse.set(dependency, consumers);
    }
  }
  return { reverse, unresolved };
}

export function planImpact(root: string, source: string): ImpactPlan {
  const absoluteRoot = resolve(root);
  const absoluteSource = isAbsolute(source) ? resolve(source) : resolve(absoluteRoot, source);
  const inventory = repositoryFiles(absoluteRoot);
  const allFiles = new Set(inventory.map((path) => resolve(absoluteRoot, path)));
  if (!allFiles.has(absoluteSource) || !existsSync(absoluteSource))
    throw new Error(`source is not a present repository file: ${source}`);
  const sources = sourceFiles(inventory);
  if (!sources.length) throw new Error("repository has no TypeScript source files");
  const sourceSet = new Set(sources.map((path) => resolve(absoluteRoot, path)));
  const productTests = productTestFiles(absoluteRoot, new Set(inventory));
  const digest = createHash("sha256");
  const { reverse, unresolved } = scanImports(absoluteRoot, sources, sourceSet, digest);
  for (const path of ["package.json", "package-lock.json", "tsconfig.json"]) {
    const absolute = join(absoluteRoot, path);
    if (!existsSync(absolute)) throw new Error(`missing verification input: ${path}`);
    digest.update(path).update("\0").update(readFileSync(absolute)).update("\0");
  }
  digest.update(process.version).update(process.platform).update(process.arch);

  const affected = new Set<string>([absoluteSource]);
  const queue = [absoluteSource];
  for (const current of queue) {
    for (const consumer of reverse.get(current) ?? []) {
      if (affected.has(consumer)) continue;
      affected.add(consumer);
      queue.push(consumer);
    }
  }
  const relativeAffected = [...affected].map((path) =>
    relative(absoluteRoot, path).replaceAll("\\", "/"),
  );
  const candidateTests = relativeAffected.filter((path) => productTests.has(path)).sort();
  const affectedOutsideProduct = relativeAffected
    .filter((path) => /\.test\.[cm]?tsx?$/.test(path) && !productTests.has(path))
    .sort();
  if (!candidateTests.length) throw new Error("impact graph found no product test consumers");
  if (candidateTests.some((path) => !productTests.has(path)))
    throw new Error("impact graph selected a test outside test:product");
  return {
    source: relative(absoluteRoot, absoluteSource).replaceAll("\\", "/"),
    verdict: "candidate-only",
    fullGateRequired: true,
    snapshotDigest: digest.digest("hex"),
    scannedFiles: sources.length,
    productTests: productTests.size,
    candidateTests,
    affectedOutsideProduct,
    unresolvedImports: [...new Set(unresolved)].sort(),
    limitations: [
      "Import reachability does not prove behavioral test sufficiency.",
      "Filesystem reads, generated inputs, and environment dependencies are not mapped.",
      "This candidate set is not a passing verification or an authorized replacement for agent:verify.",
    ],
  };
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        root: { type: "string" },
        source: { type: "string" },
        execute: { type: "boolean" },
      },
    });
    if (!values.source)
      throw new Error("usage: --source <repository path> [--root <dir>] [--execute]");
    const root = resolve(values.root ?? process.cwd());
    const started = performance.now();
    const plan = planImpact(root, values.source);
    const planningMs = Math.round(performance.now() - started);
    let execution:
      | { candidateTestsPassed: boolean; durationMs: number; exitCode?: number; reason?: string }
      | undefined;
    if (values.execute) {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const before = plan.snapshotDigest;
      const run = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--test",
          "--test-reporter=tap",
          "--test-concurrency=4",
          ...plan.candidateTests,
        ],
        {
          cwd: root,
          encoding: "utf8",
          windowsHide: true,
          timeout: 150_000,
          maxBuffer: 16 * 1024 * 1024,
          env,
        },
      );
      const after = planImpact(root, values.source).snapshotDigest;
      const candidateTestsPassed =
        !run.error && run.status === 0 && testOutputPassed(run.stdout ?? "") && before === after;
      execution = {
        candidateTestsPassed,
        durationMs: Math.round(performance.now() - started - planningMs),
        exitCode: run.status ?? undefined,
        reason:
          before !== after ? "repository inputs changed during execution" : run.error?.message,
      };
    }
    process.stdout.write(
      `${JSON.stringify({ measuredAt: new Date().toISOString(), root, planningMs, ...plan, execution }, null, 2)}\n`,
    );
    // Exit 2 means the candidate set was measured, but it is not an admissible gate.
    process.exitCode = execution?.candidateTestsPassed === false ? 1 : 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
