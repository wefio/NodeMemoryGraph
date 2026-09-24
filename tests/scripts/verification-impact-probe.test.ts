import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { planImpact } from "../../scripts/verification-impact-probe.ts";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nmg-impact-probe-"));
  for (const path of ["src", "tests"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { "test:product": 'node --test "tests/**/*.test.ts"' } }),
  );
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  writeFileSync(join(root, "src", "pure.ts"), "export const value = 1;\n");
  writeFileSync(
    join(root, "src", "consumer.ts"),
    'import { value } from "./pure.ts";\nexport { value };\n',
  );
  writeFileSync(join(root, "tests", "direct.test.ts"), 'import "../src/pure.ts";\n');
  writeFileSync(join(root, "tests", "consumer.test.ts"), 'import "../src/consumer.ts";\n');
  writeFileSync(
    join(root, "tests", "unrelated.test.ts"),
    'import test from "node:test";\ntest("unrelated", () => {});\n',
  );
  const git = spawnSync("git", ["init", "--quiet"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(git.status, 0, git.stderr);
  return root;
}

test("impact probe follows direct and transitive imports without calling the subset sufficient", () => {
  const root = fixture();
  const plan = planImpact(root, "src/pure.ts");
  assert.deepEqual(plan.candidateTests, ["tests/consumer.test.ts", "tests/direct.test.ts"]);
  assert.equal(plan.productTests, 3);
  assert.equal(plan.fullGateRequired, true);
  assert.equal(plan.verdict, "candidate-only");
});

test("impact probe includes literal dynamic imports and reports computed paths", () => {
  const root = fixture();
  writeFileSync(join(root, "tests", "dynamic.test.ts"), 'await import("../src/pure.ts");\n');
  writeFileSync(
    join(root, "tests", "computed.test.ts"),
    'const path = "../src/pure.ts";\nawait import(path);\n',
  );
  const plan = planImpact(root, "src/pure.ts");
  assert.ok(plan.candidateTests.includes("tests/dynamic.test.ts"));
  assert.ok(plan.unresolvedImports.some((item) => item.includes("tests/computed.test.ts")));
  assert.equal(plan.fullGateRequired, true);
});

test("impact probe exposes a file-read counterexample instead of claiming coverage", () => {
  const root = fixture();
  writeFileSync(
    join(root, "tests", "text.test.ts"),
    'import { readFileSync } from "node:fs";\nreadFileSync("src/pure.ts", "utf8");\n',
  );
  const plan = planImpact(root, "src/pure.ts");
  assert.equal(plan.candidateTests.includes("tests/text.test.ts"), false);
  assert.equal(plan.fullGateRequired, true);
  assert.ok(plan.limitations.some((item) => item.includes("Filesystem reads")));
});

test("impact probe changes its snapshot key when an input changes", () => {
  const root = fixture();
  const before = planImpact(root, "src/pure.ts");
  writeFileSync(join(root, "src", "pure.ts"), "export const value = 2;\n");
  const after = planImpact(root, "src/pure.ts");
  assert.notEqual(before.snapshotDigest, after.snapshotDigest);
  assert.deepEqual(before.candidateTests, after.candidateTests);
});

test("impact probe refuses an absent source instead of treating zero matches as clean", () => {
  const root = fixture();
  assert.throws(() => planImpact(root, "src/missing.ts"), /not a present repository file/);
});

test("CLI reports candidates with a nonpassing exit status", () => {
  const root = fixture();
  const script = fileURLToPath(
    new URL("../../scripts/verification-impact-probe.ts", import.meta.url),
  );
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "--root", root, "--source", "src/pure.ts"],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  assert.equal(run.status, 2, run.stderr);
  const output = JSON.parse(run.stdout) as { verdict: string; fullGateRequired: boolean };
  assert.equal(output.verdict, "candidate-only");
  assert.equal(output.fullGateRequired, true);
});
