// The arms' checks, as data.
//
// A fixture's own test file is the declaration of what its unit must do, and the arms run it against
// the candidate's files. Doing that used to mean materialising a candidate workspace and spawning
// `node --test` in it: a directory, a git worktree, a `node_modules` link, and a cleanup, per unit.
// The decision behind the alternative is
// `docs/decisions/implemented/2026-09-20-tests-need-no-filesystem.md`.
//
// Here the test file and the candidate's modules are evaluated in this process, with a module system
// that resolves the fixture's own relative imports against the candidate's file set. Nothing is
// created, nothing is written, and two candidates cannot see each other's leftovers because there is
// nothing to leave behind. One check's run is one closure: two unit checks running at once share no
// state here, which is what lets the slot arms dispatch several units in one process.
//
// What this trades away is the process boundary: the fixture tests here are pure functions over data,
// and this runner is only for that kind of check. A check that must execute candidate code under a
// timeout stays a command check, and its caller prepares its workspace.
import assert from "node:assert/strict";
import vm from "node:vm";
import ts from "typescript";
import type { DataCheck, DataCheckResult } from "../../src/integration/ooo-candidate.ts";

interface TestCase {
  name: string;
  run: () => unknown;
}

function transpile(source: string, fileName: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      isolatedModules: true,
      sourceMap: false,
    },
    fileName,
  }).outputText;
}

/** `./normalize.ts` seen from a test file, as a key in the candidate's file set. The fixture's own
 *  directory is the only namespace it may reach into. */
function resolveRelative(from: string, specifier: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/** The module system one check runs in: the candidate's file set is the whole world, and every module
 *  in it is evaluated at most once. */
function loadModules(
  fileSet: Readonly<Record<string, string>>,
  hostModule: (specifier: string) => unknown,
) {
  const loaded = new Map<string, Record<string, unknown>>();
  const load = (id: string): Record<string, unknown> => {
    const done = loaded.get(id);
    if (done) return done;
    const source = fileSet[id];
    if (source === undefined)
      throw new Error(`${id} is not in the candidate's view, so the check cannot run`);
    const exports: Record<string, unknown> = {};
    // Registered before evaluation so that a cycle sees the partial module, as Node does.
    loaded.set(id, exports);
    const require = (specifier: string): unknown =>
      specifier.startsWith(".") ? load(resolveRelative(id, specifier)) : hostModule(specifier);
    vm.compileFunction(transpile(source, id), ["exports", "require", "module"], {
      filename: id,
    })(exports, require, { exports });
    return exports;
  };
  return load;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs one fixture test file over a candidate's files: the test file and the modules it imports are
 *  all read from the file set, and the verdict is what the assertions did. */
export async function runTestFile(
  path: string,
  fileSet: Readonly<Record<string, string>>,
): Promise<DataCheckResult> {
  if (fileSet[path] === undefined)
    return { status: "undecidable", log: `${path} is not in the candidate's view` };
  const cases: TestCase[] = [];
  const hostTest = (name: string, run: () => unknown): void => {
    cases.push({ name, run });
  };
  const hostModule = (specifier: string): unknown => {
    if (specifier === "node:test" || specifier === "test")
      return { __esModule: true, default: hostTest, test: hostTest };
    if (specifier === "node:assert" || specifier === "node:assert/strict" || specifier === "assert")
      return assert;
    throw new Error(`a fixture test may only import its own files, not ${specifier}`);
  };
  try {
    loadModules(fileSet, hostModule)(path);
  } catch (error) {
    // The candidate's own files are what the test file loads, so a load or evaluation failure is the
    // candidate's failure, not an inconclusive measurement.
    return { status: "failed", log: `${path}: ${message(error)}` };
  }
  if (!cases.length)
    return { status: "undecidable", log: `${path} declares no tests, so it checks nothing` };
  const failures: string[] = [];
  for (const one of cases) {
    try {
      await one.run();
    } catch (error) {
      failures.push(`${one.name}: ${message(error)}`);
    }
  }
  return failures.length
    ? { status: "failed", log: failures.join("\n") }
    : { status: "passed", log: `${cases.length} test(s) passed` };
}

/** A unit's acceptance as data: the fixture's own test file, run against the candidate's files. */
export function testFileCheck(label: string, path: string): DataCheck {
  return {
    label,
    verify: ({ files, frozen }) => runTestFile(path, { ...frozen, ...files }),
  };
}
