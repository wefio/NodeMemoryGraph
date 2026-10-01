import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse as parseYaml } from "yaml";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const preCommitHook = readFileSync(new URL("../../.githooks/pre-commit", import.meta.url), "utf8");

test("product and coverage tests exclude research and chaos suites", () => {
  for (const name of ["test:product", "test:coverage"]) {
    const script = packageJson.scripts[name];
    assert.ok(script.includes("tests/core/**/*.test.ts"));
    assert.ok(script.includes("tests/guardrails/**/*.test.ts"));
    assert.doesNotMatch(script, /tests\/(benchmarks|evals|official|chaos)/);
  }
});

test("research and chaos suites remain explicit execution groups", () => {
  assert.match(packageJson.scripts["test:research"], /tests\/benchmarks/);
  assert.match(packageJson.scripts["test:research"], /tests\/evals/);
  assert.match(packageJson.scripts["test:research"], /tests\/official/);
  assert.match(packageJson.scripts["test:chaos"], /tests\/chaos/);
});

test("format and format:check cover the same declared developer TypeScript surfaces", () => {
  const expected = ["src", ".pi", "workbuddy-plugin", "tests", "evals", "scripts", "tools"].sort();
  for (const name of ["format", "format:check"]) {
    const surfaces = [...packageJson.scripts[name]!.matchAll(/"([^"]+)\/\*\*\/\*\.ts"/gu)]
      .map((match) => match[1]!)
      .sort();
    assert.deepEqual(surfaces, expected, `${name} must cover the declared surface`);
  }
});

test("the pre-commit formatter surface is the format:check surface", () => {
  // Two surfaces decide which TypeScript Prettier rewrites: the commit hook (staged
  // files, so drift cannot land) and `format:check` (the whole tree, so CI can report
  // it). They disagreed once — the hook took every staged `.ts` while the check took
  // three directories — and the hook then reformatted files CI could never report on
  // again. This asserts they are the same set, instead of a comment claiming so.
  const strip = (value: string) => value.replaceAll("\\", "");
  const fromCheck = [
    ...packageJson.scripts["format:check"]!.matchAll(/"([^"]+)\/\*\*\/\*\.ts"/gu),
  ].map((match) => match[1]!);
  assert.ok(fromCheck.length > 0, "format:check names no TypeScript surface");
  const alternation = /grep -E '\^\(([^']+)\)\/'/u.exec(preCommitHook)?.[1];
  assert.ok(alternation, "the pre-commit hook has no top-level path filter to compare");
  assert.deepEqual(
    alternation.split("|").map(strip).sort(),
    fromCheck.map(strip).sort(),
    "the pre-commit hook and format:check must cover the same top-level directories",
  );
  assert.match(preCommitHook, /--diff-filter=ACM/u);
  assert.match(preCommitHook, /'\*\.ts'/u, "the hook must stay limited to TypeScript");
});

test("local and CI verification groups share named package contracts", () => {
  const contracts = [
    "verify:static",
    "verify:product-ci",
    "verify:research",
    "verify:node-compat",
    "verify:chaos",
  ];
  for (const name of contracts) {
    assert.ok(packageJson.scripts[name], `missing package script ${name}`);
    assert.match(workflow, new RegExp(`npm run ${name.replace(":", "\\:")}`));
  }
  assert.match(packageJson.scripts["verify:static"], /agent:context:check/);
  assert.match(packageJson.scripts["verify:product-ci"], /test:coverage/);
});

test("tests-surface type checking is blocking in the shared static contract", () => {
  const checks = [...packageJson.scripts["verify:static"]!.matchAll(/npm run ([\w:-]+)/gu)].map(
    (match) => match[1]!,
  );
  assert.equal(checks.filter((name) => name === "check:tests").length, 1);
  const ci = parseYaml(workflow) as {
    jobs: { static: { steps: { run?: string; "continue-on-error"?: boolean }[] } };
  };
  const staticStep = ci.jobs.static.steps.find((step) => step.run === "npm run verify:static");
  assert.ok(staticStep);
  assert.notEqual(staticStep["continue-on-error"], true);
  assert.ok(
    !ci.jobs.static.steps.some((step) => step.run === "npm run check:tests"),
    "CI uses the shared contract, not a duplicate advisory type-check step",
  );
});

test("the maintained policy-word check blocks the shared static contract exactly once", () => {
  const checks = [...packageJson.scripts["verify:static"]!.matchAll(/npm run ([\w:-]+)/gu)].map(
    (match) => match[1]!,
  );
  assert.equal(checks.filter((name) => name === "check:policy-words").length, 1);
  assert.equal(
    packageJson.scripts["check:policy-words"],
    "node --experimental-strip-types tools/policy-word-check.ts",
  );
});

test("agent static checks match the CI contract without nested duplicate execution", () => {
  const context = parseYaml(
    readFileSync(new URL("../../agent-context.yaml", import.meta.url), "utf8"),
  ) as { routes: { id: string; verify: { blocking: string[] } }[] };
  const route = context.routes.find(({ id }) => id === "ci-and-tests");
  assert.ok(route);
  const staticChecks = [
    ...packageJson.scripts["verify:static"]!.matchAll(/npm run ([\w:-]+)/gu),
  ].map((match) => match[1]!);
  assert.deepEqual(route.verify.blocking, [...staticChecks, "test:product"]);
  assert.equal(new Set(route.verify.blocking).size, route.verify.blocking.length);
});
