import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
