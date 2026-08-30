import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { forgeBindingBody, GitHubForgeProvider } from "../../src/rcp/providers.ts";
import { contractText, repositoryFixture } from "./fixture.ts";

const cli = fileURLToPath(new URL("../../src/rcp/cli/main.ts", import.meta.url));

test("CLI compiles and plans a Contract without mutating the repository", () => {
  const root = repositoryFixture();
  const contract = join(root, "change.yaml");
  writeFileSync(contract, contractText());
  const compile = run(root, ["compile", contract, "--json"]);
  assert.equal(compile.status, 0, compile.stderr);
  const compiled = JSON.parse(compile.stdout) as { contract: { id: string; contractDigest: string } };
  assert.equal(compiled.contract.id, "fixture-change");
  assert.match(compiled.contract.contractDigest, /^sha256:/);

  const plan = run(root, ["plan", contract, "--json"]);
  assert.equal(plan.status, 0, plan.stderr);
  const planned = JSON.parse(plan.stdout) as {
    workOrder: { schema: string; verificationChecks: string[] };
  };
  assert.equal(planned.workOrder.schema, "repository.work-order/v1alpha1");
  assert.deepEqual(planned.workOrder.verificationChecks, ["check"]);
});

test("CLI apply is fail-closed without an explicit harness boundary", () => {
  const root = repositoryFixture();
  const contract = join(root, "change.yaml");
  writeFileSync(contract, contractText());
  const result = run(root, ["reconcile", contract, "--apply"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--workspace-ready or --harness-command/);
});

test("CLI reconcile records and validates a receipt with NMG disabled", () => {
  const root = repositoryFixture();
  const contract = join(root, "change.yaml");
  writeFileSync(contract, contractText());
  const result = run(root, [
    "reconcile",
    contract,
    "--apply",
    "--workspace-ready",
    "--nmg",
    "disabled",
    "--json",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const reconciled = JSON.parse(result.stdout) as {
    status: string;
    receiptPath: string;
    receipt: { decision: string };
  };
  assert.equal(reconciled.status, "verified");
  assert.equal(reconciled.receipt.decision, "verified");

  const validation = run(root, ["receipt-verify", reconciled.receiptPath, "--json"]);
  assert.equal(validation.status, 0, validation.stderr);
  assert.equal((JSON.parse(validation.stdout) as { valid: boolean }).valid, true);
});

test("GitHub provider normalizes forge state through an injected runner", async () => {
  const provider = new GitHubForgeProvider((_root, args) => {
    assert.equal(args[0], "pr");
    return JSON.stringify({
      number: 42,
      url: "https://example.invalid/pull/42",
      state: "OPEN",
      isDraft: true,
      headRefName: "feature",
      baseRefName: "main",
      headRefOid: "abc123",
      body: forgeBindingBody("change-42", "sha256:abc123"),
      statusCheckRollup: [
        { name: "product", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
    });
  });
  const observation = await provider.observePullRequest({ root: ".", number: 42 });
  assert.equal(observation.headCommit, "abc123");
  assert.equal(observation.contractId, "change-42");
  assert.equal(observation.contractDigest, "sha256:abc123");
  assert.deepEqual(observation.checks, [
    { name: "product", status: "COMPLETED", conclusion: "SUCCESS" },
  ]);
});

test("GitHub provider creates a Draft PR with a machine-readable Contract binding", async () => {
  const calls: string[][] = [];
  const provider = new GitHubForgeProvider((_root, args) => {
    calls.push(args);
    if (args[1] === "create") return "https://example.invalid/pull/43\n";
    const body = args[2] === "https://example.invalid/pull/43"
      ? forgeBindingBody("change-43", "sha256:def456", "implementation")
      : "";
    return JSON.stringify({
      number: 43,
      url: "https://example.invalid/pull/43",
      state: "OPEN",
      isDraft: true,
      headRefName: "feature",
      baseRefName: "main",
      headRefOid: "def456",
      body,
      statusCheckRollup: [],
    });
  });
  const observation = await provider.createDraftPullRequest!({
    root: ".",
    base: "main",
    head: "feature",
    title: "change",
    contractId: "change-43",
    contractDigest: "sha256:def456",
    body: "implementation",
  });
  assert.equal(observation.contractId, "change-43");
  assert.ok(calls[0]?.includes("--draft"));
  const submittedBody = calls[0]?.[calls[0].indexOf("--body") + 1] ?? "";
  assert.match(submittedBody, /contract-id: change-43/);
  assert.match(submittedBody, /contract-digest: sha256:def456/);
});

function run(root: string, args: string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args, "--root", root], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}
