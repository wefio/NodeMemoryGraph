import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { compileContract } from "../../src/rcp/contract.ts";
import { planWorkOrder, readRouteDeclarations } from "../../src/rcp/planner.ts";
import {
  changedPaths,
  globMatches,
  observeRepository,
  scopeDirectoryReachable,
} from "../../src/rcp/repository.ts";
import { contractText, repositoryFixture } from "./fixture.ts";

function contract() {
  const result = compileContract({ text: contractText(), path: "contract.yaml" });
  assert.ok(result.contract);
  return result.contract;
}

test("scope directory pruning stays safe for anchored and catch-all includes", () => {
  // src/rcp/** reaches src and src/rcp but not a sibling or deeper other root.
  const anchored = ["src/rcp/**"];
  assert.equal(scopeDirectoryReachable("src", anchored), true);
  assert.equal(scopeDirectoryReachable("src/rcp", anchored), true);
  assert.equal(scopeDirectoryReachable("src/lab", anchored), false);
  assert.equal(scopeDirectoryReachable("evals", anchored), false);
  assert.equal(scopeDirectoryReachable("", anchored), true); // root always traversed
  // A glob in the first segment can match anywhere: never prune.
  assert.equal(scopeDirectoryReachable("anywhere", ["**/guardrail.yaml"]), true);
  assert.equal(scopeDirectoryReachable("anywhere", ["*.md"]), true);
  // Bare root-level file reaches nothing below a subdirectory.
  assert.equal(scopeDirectoryReachable("docs", ["package.json"]), false);
  // Literal deep file reaches only its ancestor directories.
  assert.equal(scopeDirectoryReachable("docs", ["docs/design/a.md"]), true);
  assert.equal(scopeDirectoryReachable("docs/design", ["docs/design/a.md"]), true);
  assert.equal(scopeDirectoryReachable("docs/experiments", ["docs/design/a.md"]), false);
  // A single wildcard segment anchors at its literal prefix (safe over-approximation).
  assert.equal(scopeDirectoryReachable("src", ["src/*.ts"]), true);
  // Mixed includes use any reaching pattern.
  assert.equal(scopeDirectoryReachable("evals", ["src/**", "evals/controller/**"]), true);
});

test("observation ignores an entire out-of-scope subtree and never reads a reachable sibling", () => {
  const root = repositoryFixture();
  const compiled = compileContract({
    text: contractText().replace("include: [src/**]", "include: [src/rcp/**]"),
    path: "contract.yaml",
  });
  assert.ok(compiled.contract);
  // src/value.ts lies outside src/rcp/**, so nothing in src is allowed.
  const observation = observeRepository(root, compiled.contract);
  assert.equal(scopeDirectoryReachable("src", compiled.contract.scope.include), true);
  assert.equal(scopeDirectoryReachable("outside", compiled.contract.scope.include), false);
  assert.deepEqual(
    observation.files.map((file) => file.path),
    [],
  );
  assert.equal(observation.diagnostics.length, 0);
});

test("wide scope reports a non-blocking soft size diagnostic instead of skipping", () => {
  const root = repositoryFixture();
  const compiled = compileContract({
    text: contractText().replace("include: [src/**]", "include: ['**']"),
    path: "contract.yaml",
  });
  assert.ok(compiled.contract);
  // A tiny soft bound forces the warning on this small fixture.
  const observation = observeRepository(root, compiled.contract, { softBytes: 4 });
  assert.ok(observation.observedBytes && observation.observedBytes > 4);
  assert.ok(observation.diagnostics.some((message) => message.includes("declared scope reaches")));
  // Non-blocking: allowed content is still fully observed (every fixture file).
  assert.deepEqual(observation.files.map((file) => file.path).sort(), [
    "agent-context.yaml",
    "docs/design.md",
    "outside.txt",
    "package.json",
    "src/value.ts",
  ]);
  // A generous soft bound adds no diagnostic.
  const quiet = observeRepository(root, compiled.contract);
  assert.equal(
    quiet.diagnostics.some((message) => message.includes("declared scope reaches")),
    false,
  );
});

test("glob matching and observation stay within declared scope", () => {
  assert.equal(globMatches("src/**", "src/value.ts"), true);
  assert.equal(globMatches("src/*.ts", "src/nested/value.ts"), false);
  const root = repositoryFixture();
  const observation = observeRepository(root, contract());
  assert.deepEqual(
    observation.files.map((file) => file.path),
    ["src/value.ts"],
  );
  assert.equal(observation.git.available, true);
  assert.equal(observation.git.dirtyFiles.length, 0);
});

test("observed revision changes with scoped content and reports exact changed paths", () => {
  const root = repositoryFixture();
  const before = observeRepository(root, contract());
  writeFileSync(join(root, "src", "value.ts"), "export const value = 2;\n");
  const after = observeRepository(root, contract());
  assert.notEqual(after.observedRevision, before.observedRevision);
  assert.deepEqual(changedPaths(before, after), ["src/value.ts"]);
});

test("receipt output never changes a broad repository observation", () => {
  const root = repositoryFixture();
  const compiled = compileContract({
    text: contractText().replace("include: [src/**]", "include: ['**']"),
    path: "contract.yaml",
  });
  assert.ok(compiled.contract);
  const before = observeRepository(root, compiled.contract);
  mkdirSync(join(root, ".rcp", "receipts"), { recursive: true });
  writeFileSync(join(root, ".rcp", "receipts", "result.json"), "{}\n");
  const after = observeRepository(root, compiled.contract);
  assert.equal(after.observedRevision, before.observedRevision);
  assert.equal(
    after.files.some((file) => file.path.startsWith(".rcp/receipts/")),
    false,
  );
});

test("planner maps Contract scope to repository routes and a bounded WorkOrder", () => {
  const root = repositoryFixture();
  const value = contract();
  const observation = observeRepository(root, value);
  const order = planWorkOrder({
    contract: value,
    observation,
    routes: readRouteDeclarations(root),
  });
  assert.equal(order.contractDigest, value.contractDigest);
  assert.deepEqual(order.routes, ["source"]);
  assert.deepEqual(order.owners, ["docs/design.md"]);
  assert.deepEqual(order.verificationChecks, ["check"]);
  assert.deepEqual(order.allowedPaths, ["src/**"]);
  assert.deepEqual(order.budget, { maxAttempts: 1, timeoutMs: 30 * 60 * 1_000 });
});
