import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { compileContract } from "../../src/rcp/contract.ts";
import { attemptKey, readRouteDeclarations } from "../../src/rcp/planner.ts";
import {
  DefaultPolicyProvider,
  ExternalWorkspaceHarnessProvider,
  FileReceiptSink,
  LocalNpmVerifierProvider,
  NmgMemoryProvider,
  ProcessHarnessProvider,
  type ForgeProvider,
  type HarnessProvider,
  type ReceiptSink,
} from "../../src/rcp/providers.ts";
import { validateReceipt } from "../../src/rcp/receipt.ts";
import { reconcileOnce } from "../../src/rcp/reconcile.ts";
import { LocalRepositoryProvider } from "../../src/rcp/repository.ts";
import type { RepositoryProvider } from "../../src/rcp/repository.ts";
import type { VerifierProvider } from "../../src/rcp/providers.ts";
import { contractText, repositoryFixture } from "./fixture.ts";

function setup() {
  const root = repositoryFixture();
  const compiled = compileContract({ text: contractText(), path: join(root, "contract.yaml") });
  assert.ok(compiled.contract);
  return { root, contract: compiled.contract, routes: readRouteDeclarations(root) };
}

function providers(
  root: string,
  harness: HarnessProvider = new ExternalWorkspaceHarnessProvider(),
) {
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
  assert.equal(
    result.conditions.find((condition) => condition.type === "Executed")?.status,
    "unknown",
  );
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
  assert.equal(
    JSON.parse(readFileSync(first.receiptPath!, "utf8")).receiptId,
    first.receipt?.receiptId,
  );

  const second = await reconcileOnce(
    { ...value, requestedMode: "apply", invocationId: "apply-2" },
    providers(value.root),
  );
  assert.equal(second.status, "reused");
  assert.equal(second.receipt?.receiptId, first.receipt?.receiptId);
});

test("tampered verified receipt is rejected instead of reused", async () => {
  const value = setup();
  const first = await reconcileOnce(
    { ...value, requestedMode: "apply", invocationId: "tamper-1", now: fixedClock() },
    providers(value.root),
  );
  assert.equal(first.status, "verified");
  const tampered = JSON.parse(readFileSync(first.receiptPath!, "utf8")) as Record<string, unknown>;
  tampered.commit = "attacker-controlled";
  writeFileSync(first.receiptPath!, `${JSON.stringify(tampered, null, 2)}\n`);

  const second = await reconcileOnce(
    { ...value, requestedMode: "apply", invocationId: "tamper-2" },
    providers(value.root),
  );
  assert.equal(second.status, "blocked");
  assert.match(second.conditions.at(-1)?.reason ?? "", /invalid receipt/i);
});

test("receipt reuse is bound to the current verifier definition", async () => {
  const value = setup();
  const base = providers(value.root);
  const first = await reconcileOnce(
    { ...value, requestedMode: "apply", invocationId: "verifier-v1", now: fixedClock() },
    base,
  );
  assert.equal(first.status, "verified");
  const verifierV2: VerifierProvider = {
    ...base.verifier,
    descriptor: { ...base.verifier.descriptor, version: "2" },
    definitionDigest: async () => "sha256:verifier-v2",
    verify: async (request) => ({
      ...(await base.verifier.verify(request)),
      provider: { ...base.verifier.descriptor, version: "2" },
      verifierDigest: "sha256:verifier-v2",
    }),
  };
  const second = await reconcileOnce(
    { ...value, requestedMode: "apply", invocationId: "verifier-v2", now: fixedClock() },
    { ...base, verifier: verifierV2 },
  );
  assert.equal(second.status, "verified");
  assert.notEqual(second.receipt?.operationIdentity, first.receipt?.operationIdentity);
  assert.equal(receiptFileCount(value.root), 2);
});

test("apply fails closed when Git observation is unavailable", async () => {
  const value = setup();
  let executed = false;
  const base = providers(value.root, {
    descriptor: new ExternalWorkspaceHarnessProvider("must-not-run").descriptor,
    execute: async () => {
      executed = true;
      throw new Error("must not execute");
    },
  });
  const repository: RepositoryProvider = {
    descriptor: base.repository.descriptor,
    observe: async (request) => {
      const observed = await base.repository.observe(request);
      return {
        ...observed,
        git: { available: false, dirtyFiles: [], error: "git unavailable for test" },
      };
    },
  };
  const result = await reconcileOnce(
    { ...value, requestedMode: "apply", invocationId: "git-unavailable" },
    { ...base, repository },
  );
  assert.equal(result.status, "blocked");
  assert.equal(executed, false);
  assert.match(result.conditions.at(-1)?.reason ?? "", /Git.*required/i);
});

test("external workspace scope verification includes changes present before apply starts", async () => {
  const value = setup();
  writeFileSync(join(value.root, "src", "value.ts"), "export const value = 2;\n");
  const result = await reconcileOnce(
    { ...value, requestedMode: "apply", invocationId: "existing-workspace" },
    providers(value.root),
  );
  assert.equal(result.status, "verified", JSON.stringify(result.receipt?.diagnostics));
  assert.deepEqual(result.receipt?.scope.actual, ["src/value.ts"]);
});

test("external workspace fails closed for pre-existing out-of-scope changes", async () => {
  const value = setup();
  writeFileSync(join(value.root, "outside.txt"), "already dirty\n");
  const result = await reconcileOnce(
    { ...value, requestedMode: "apply", invocationId: "existing-outside" },
    providers(value.root),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.receipt?.scope.matched, false);
  assert.ok(result.receipt?.scope.actual.includes("outside.txt"));
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
      packageJson.scripts.check = "node -e \"console.log('weakened')\"";
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
  assert.ok(
    result.receipt?.diagnostics.includes(
      "verification definitions changed during harness execution",
    ),
  );
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

test("process harness terminates after its configured timeout", async () => {
  const value = setup();
  const plan = await reconcileOnce(
    {
      ...value,
      operationKey: "timeout",
      requestedMode: "plan",
      executionTimeoutMs: 50,
    },
    providers(value.root),
  );
  const script = join(value.root, "hanging-harness.mjs");
  writeFileSync(script, "process.stdin.resume(); setInterval(() => {}, 1000);\n");
  const result = await new ProcessHarnessProvider(
    process.execPath,
    [script],
    "bounded-process",
    "1",
    1_000,
  ).execute(plan.workOrder);
  assert.equal(result.status, "failed");
  assert.match(result.summary, /timed out after 50ms/i);
});

test("harness exceptions become failed terminal receipts", async () => {
  const value = setup();
  const harness: HarnessProvider = {
    descriptor: new ExternalWorkspaceHarnessProvider("throwing-harness").descriptor,
    execute: async () => {
      throw new Error("provider exploded");
    },
  };
  const result = await reconcileOnce(
    { ...value, requestedMode: "apply", invocationId: "throwing", now: fixedClock() },
    providers(value.root, harness),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.receipt?.decision, "failed");
  assert.match(result.receipt?.harness.summary ?? "", /provider exploded/);
  assert.ok(result.receiptPath);
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
  assert.equal(receiptFileCount(value.root), 2);
});

test("an interrupted mutation blocks replay until explicit recovery verifies the workspace", async () => {
  const value = setup();
  const durable = providers(value.root);
  let executions = 0;
  const harness: HarnessProvider = {
    descriptor: new ExternalWorkspaceHarnessProvider("mutating-harness").descriptor,
    execute: async () => {
      executions += 1;
      writeFileSync(join(value.root, "src", "value.ts"), "export const value = 2;\n");
      return {
        provider: new ExternalWorkspaceHarnessProvider("mutating-harness").descriptor,
        status: "completed",
        summary: "workspace changed",
      };
    },
  };
  const interruptedReceipts: ReceiptSink = {
    ...durable.receipts,
    descriptor: durable.receipts.descriptor,
    find: (identity) => durable.receipts.find(identity),
    scan: () => durable.receipts.scan(),
    findIncomplete: (key) => durable.receipts.findIncomplete(key),
    beginAttempt: (attempt) => durable.receipts.beginAttempt(attempt),
    completeAttempt: (key) => durable.receipts.completeAttempt(key),
    append: async () => {
      throw new Error("simulated crash before receipt persistence");
    },
  };
  const first = await reconcileOnce(
    { ...value, requestedMode: "apply", invocationId: "interrupted", now: fixedClock() },
    { ...durable, harness, receipts: interruptedReceipts },
  );
  assert.equal(first.status, "failed");
  assert.equal(executions, 1);

  const replay = await reconcileOnce(
    { ...value, requestedMode: "apply", invocationId: "replay" },
    { ...durable, harness },
  );
  assert.equal(replay.status, "blocked");
  assert.equal(executions, 1);
  assert.match(replay.conditions.at(-1)?.reason ?? "", /incomplete.*recover/i);

  const recovered = await reconcileOnce(
    {
      ...value,
      requestedMode: "apply",
      invocationId: "recover",
      recoverIncomplete: true,
      now: fixedClock(),
    },
    { ...durable, harness },
  );
  assert.equal(recovered.status, "verified", JSON.stringify(recovered, null, 2));
  assert.equal(executions, 1);
  assert.match(recovered.receipt?.harness.summary ?? "", /recover/i);
  assert.equal(await durable.receipts.findIncomplete(attemptKey(recovered.workOrder)), null);
});

test("forge verification binds Contract, commit and successful CI checks", async () => {
  const value = setup();
  const headCommit = new LocalRepositoryProvider();
  const observed = await headCommit.observe({ root: value.root, contract: value.contract });
  const forge = forgeProvider({
    contractId: value.contract.id,
    contractDigest: value.contract.contractDigest,
    headCommit: observed.git.commit!,
    checks: [
      { name: "product", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "CodeFactor", status: "COMPLETED", conclusion: "FAILURE" },
    ],
  });
  const result = await reconcileOnce(
    { ...value, requestedMode: "apply", pullRequestNumber: 42, operationKey: "pr-ci" },
    { ...providers(value.root), forge },
  );
  assert.equal(result.status, "verified", JSON.stringify(result.receipt?.diagnostics));
  assert.equal(result.receipt?.forge?.contractDigest, value.contract.contractDigest);
  assert.deepEqual(result.receipt?.forge?.requiredChecks, ["product"]);
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
  assert.ok(result.receipt?.diagnostics.some((entry) => /missing|pending/.test(entry)));
});

test("forge verification refuses to bind dirty workspace bytes to the PR head", async () => {
  const value = setup();
  writeFileSync(join(value.root, "src", "value.ts"), "export const value = 2;\n");
  const observed = await new LocalRepositoryProvider().observe({
    root: value.root,
    contract: value.contract,
  });
  const result = await reconcileOnce(
    { ...value, requestedMode: "apply", pullRequestNumber: 42, operationKey: "dirty-pr" },
    {
      ...providers(value.root),
      forge: forgeProvider({
        contractId: value.contract.id,
        contractDigest: value.contract.contractDigest,
        headCommit: observed.git.commit!,
        checks: [{ name: "product", status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.receipt?.commit, undefined);
  assert.ok(result.receipt?.diagnostics.some((entry) => /uncommitted workspace/i.test(entry)));
});

function fixedClock() {
  const values = [new Date("2026-08-29T00:00:00.000Z"), new Date("2026-08-29T00:00:01.000Z")];
  return () => values.shift() ?? new Date("2026-08-29T00:00:01.000Z");
}

function receiptFileCount(root: string): number {
  return readdirSync(join(root, ".rcp", "receipts")).filter((name) => name.endsWith(".json"))
    .length;
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
