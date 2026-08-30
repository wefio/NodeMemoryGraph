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
} from "../../src/rcp/repository.ts";
import { contractText, repositoryFixture } from "./fixture.ts";

function contract() {
  const result = compileContract({ text: contractText(), path: "contract.yaml" });
  assert.ok(result.contract);
  return result.contract;
}

test("glob matching and observation stay within declared scope", () => {
  assert.equal(globMatches("src/**", "src/value.ts"), true);
  assert.equal(globMatches("src/*.ts", "src/nested/value.ts"), false);
  const root = repositoryFixture();
  const observation = observeRepository(root, contract());
  assert.deepEqual(observation.files.map((file) => file.path), ["src/value.ts"]);
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
  assert.equal(after.files.some((file) => file.path.startsWith(".rcp/receipts/")), false);
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
});
