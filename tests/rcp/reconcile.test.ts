import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { compileContract } from "../../src/rcp/contract.ts";
import { readRouteDeclarations } from "../../src/rcp/planner.ts";
import {
  DefaultPolicyProvider,
  ExternalWorkspaceHarnessProvider,
  FileReceiptSink,
  LocalNpmVerifierProvider,
  NmgMemoryProvider,
  ProcessHarnessProvider,
  type ForgeProvider,
  type HarnessProvider,
} from "../../src/rcp/providers.ts";
import { validateReceipt } from "../../src/rcp/receipt.ts";
import { reconcileOnce } from "../../src/rcp/reconcile.ts";
import { LocalRepositoryProvider } from "../../src/rcp/repository.ts";
import { contractText, repositoryFixture } from "./fixture.ts";

function setup() {
  const root = repositoryFixture();
  const compiled = compileContract({ text: contractText(), path: join(root, "contract.yaml") });
  assert.ok(compiled.contract);
  return { root, contract: compiled.contract, routes: readRouteDeclarations(root) };
}

function providers(root: string, harness: HarnessProvider = new ExternalWorkspaceHarnessProvider()) {
  return {
    repository: new LocalRepositoryProvider(),
    policy: new DefaultPolicyProvider(),
    harness,
    verifier: new LocalNpmVerifierProvider(30_000),
    receipts: new FileReceiptSink(join(root, ".rcp", "receipts")),
  };
}

test("plan mode emits a WorkOrder without executing or recording", async () => {
  const value = setup();
  const result = await reconcileOnce(
    { ...value, requestedMode: "plan", invocationId: "plan" },
    providers(value.root),
  );
  assert.equal(result.status, "planned");
  assert.equal(result.receipt, undefined);
  assert.equal(result.conditions.find((condition) => condition.type === "Executed")?.status, "unknown");
});

test("apply independently verifies, records an immutable receipt, and reuses identity", async () => {
  const value = setup();
  const first = await reconcileOnce(
    {
      ...value,
      requestedMode: "apply",
      invocationId: "apply-1",
      now: fixedClock(),
    },
    providers(value.root),
  );
  assert.equal(first.status, "verified", JSON.stringify(first, null, 2));
  assert.ok(first.receiptPath);
  assert.equal(validateReceipt(first.receipt!).valid, true);
  assert.equal(JSON.parse(readFileSync(first.receiptPath!, "utf8")).receiptId, first.receipt?.receiptId);

  const second = await reconcileOnce(
    { ...value, requestedMode: "apply", invocationId: "apply-2" },
    providers(value.root),
  );
  assert.equal(second.status, "reused");
  assert.equal(second.receipt?.receiptId, first.receipt?.receiptId);
});

test("out-of-scope workspace mutation fails independent scope verification", async () => {
  const value = setup();
  const harness: HarnessProvider = {
    descriptor: new ExternalWorkspaceHarnessProvider("scope-breaker").descriptor,
    execute: async (order) => {
      writeFileSync(join(value.root, "outside.txt"), "mutated\n");
      return {
        provider: new ExternalWorkspaceHarnessProvider("scope-breaker").descriptor,
        status: "completed",
        summary: `changed workspace for ${order.id}`,
      };
    },
  };
  const result = await reconcileOnce(
    { ...value, requestedMode: "apply", invocationId: "scope" },
    providers(value.root, harness),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.receipt?.scope.matched, false);
  assert.ok(result.receipt?.scope.actual.includes("outside.txt"));
});

test("an implementing harness cannot weaken its verifier during execution", async () => {
  const value = setup();
  const harness: HarnessProvider = {
    descriptor: new ExternalWorkspaceHarnessProvider("check-weakener").descriptor,
    execute: async () => {
      const path = join(value.root, "package.json");
      const packageJson = JSON.parse(readFileSync(path, "utf8")) as {
        scripts: Record<string, string>;
      };
      packageJson.scripts.check = 'node -e "console.log(\'weakened\')"';
      writeFileSync(path, JSON.stringify(packageJson));
      return {
        provider: new ExternalWorkspaceHarnessProvider("check-weakener").descriptor,
        status: "completed",
        summary: "weakened check",
      };
    },
  };
  const result = await reconcileOnce(
    { ...value, requestedMode: "apply", invocationId: "weakener" },
    providers(value.root, harness),
  );
  assert.equal(result.status, "failed");
  assert.ok(result.receipt?.diagnostics.includes("verification definitions changed during harness execution"));
});

test("optional NMG failure degrades without changing authority or verified decision", async () => {
  const value = setup();
  const base = providers(value.root);
  const result = await reconcileOnce(
    { ...value, requestedMode: "apply", invocationId: "memory", now: fixedClock() },
    {
      ...base,
      memory: new NmgMemoryProvider({
        recall: async () => {
          throw new Error("daemon unavailable");
        },
        notify: async () => {
          throw new Error("daemon unavailable");
        },
      }),
    },
  );
  assert.equal(result.status, "verified");
  assert.equal(result.memoryDiagnostics.length, 2);
});

test("external and process harnesses consume the same WorkOrder contract", async () => {
  const value = setup();
  const external = await reconcileOnce(
    { ...value, operationKey: "external", requestedMode: "plan" },
    providers(value.root, new ExternalWorkspaceHarnessProvider("codex")),
  );
  const script = join(value.root, "harness.mjs");
  writeFileSync(
    script,
    "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const o=JSON.parse(data); process.stdout.write(o.schema); });\n",
  );
  const processResult = await new ProcessHarnessProvider(process.execPath, [script], "pi").execute(
    external.workOrder,
  );
  assert.equal(processResult.status, "completed");
  assert.equal(processResult.summary, "repository.work-order/v1alpha1");
  assert.equal(external.workOrder.schema, "repository.work-order/v1alpha1");
});

test("failed attempts remain append-only without preventing a later retry", async () => {
  const value = setup();
  const failingHarness: HarnessProvider = {
    descriptor: new ExternalWorkspaceHarnessProvider("first-attempt").descriptor,
    execute: async () => ({
      provider: new ExternalWorkspaceHarnessProvider("first-attempt").descriptor,
      status: "failed",
      summary: "transient harness failure",
    }),
  };
  const first = await reconcileOnce(
    { ...value, requestedMode: "apply", invocationId: "attempt-1", now: fixedClock() },
    providers(value.root, failingHarness),
  );
  assert.equal(first.status, "failed");
  const second = await reconcileOnce(
    { ...value, requestedMode: "apply", invocationId: "attempt-2", now: fixedClock() },
    providers(value.root),
  );
  assert.equal(second.status, "verified");
  assert.equal(readdirSync(join(value.root, ".rcp", "receipts")).length, 2);
});

test("forge verification binds Contract, commit and successful CI checks", async () => {
  const value = setup();
  const headCommit = new LocalRepositoryProvider();
  const observed = await headCommit.observe({ root: value.root, contract: value.contract });
  const forge = forgeProvider({
    contractId: value.contract.id,
    contractDigest: value.contract.contractDigest,
    headCommit: observed.git.commit!,
    checks: [{ name: "product", status: "COMPLETED", conclusion: "SUCCESS" }],
  });
  const result = await reconcileOnce(
    { ...value, requestedMode: "apply", pullRequestNumber: 42, operationKey: "pr-ci" },
    { ...providers(value.root), forge },
  );
  assert.equal(result.status, "verified", JSON.stringify(result.receipt?.diagnostics));
  assert.equal(result.receipt?.forge?.contractDigest, value.contract.contractDigest);
});

test("forge verification fails closed for an unbound or pending PR", async () => {
  const value = setup();
  const result = await reconcileOnce(
    { ...value, requestedMode: "apply", pullRequestNumber: 42, operationKey: "pr-pending" },
    {
      ...providers(value.root),
      forge: forgeProvider({ headCommit: "different", checks: [] }),
    },
  );
  assert.equal(result.status, "failed");
  assert.ok(result.receipt?.diagnostics.some((entry) => entry.includes("Contract identity")));
  assert.ok(result.receipt?.diagnostics.some((entry) => entry.includes("pending")));
});

function fixedClock() {
  const values = [new Date("2026-08-29T00:00:00.000Z"), new Date("2026-08-29T00:00:01.000Z")];
  return () => values.shift() ?? new Date("2026-08-29T00:00:01.000Z");
}

function forgeProvider(
  overrides: Partial<Awaited<ReturnType<ForgeProvider["observePullRequest"]>>>,
): ForgeProvider {
  return {
    descriptor: {
      id: "fixture-forge",
      version: "1",
      capabilities: ["pull-request-observation"],
      operations: ["observePullRequest"],
      authority: ["apply"],
    },
    observePullRequest: async () => ({
      provider: {
        id: "fixture-forge",
        version: "1",
        capabilities: ["pull-request-observation"],
        operations: ["observePullRequest"],
        authority: ["apply"],
      },
      number: 42,
      url: "https://example.invalid/pull/42",
      state: "OPEN",
      isDraft: true,
      headRef: "feature",
      baseRef: "main",
      headCommit: "unknown",
      checks: [],
      ...overrides,
    }),
  };
}
