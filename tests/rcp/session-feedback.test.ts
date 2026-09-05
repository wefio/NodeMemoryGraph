import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { httpCall } from "../../src/cli/http-client.ts";
import { serverStatePath } from "../../src/cli/lifecycle.ts";
import type { NmgSessionActiveGraphResult } from "../../src/cli/protocol.ts";
import { SessionActiveGraphRuntime } from "../../src/core/session-active-graph.ts";
import { runRcpCli } from "../../src/rcp/cli/main.ts";
import {
  testWorkspace,
  testDatabase,
  testDaemon,
  withTestRuntime,
} from "../support/test-runtime.ts";
import { compileContract } from "../../src/rcp/contract.ts";
import { readRouteDeclarations } from "../../src/rcp/planner.ts";
import {
  DefaultPolicyProvider,
  ExternalWorkspaceHarnessProvider,
  FileReceiptSink,
  LocalNpmVerifierProvider,
} from "../../src/rcp/providers.ts";
import { reconcileOnce } from "../../src/rcp/reconcile.ts";
import { receiptId, validateReceipt } from "../../src/rcp/receipt.ts";
import { LocalRepositoryProvider } from "../../src/rcp/repository.ts";
import { SessionFeedbackProvider } from "../../src/rcp/session-feedback.ts";
import { contractText, repositoryFixture } from "./fixture.ts";

function fixture(t: test.TestContext, failing = false) {
  const root = repositoryFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const text = failing
    ? contractText().replace("checks: [check]", "checks: [failing]")
    : contractText();
  const contract = compileContract({ text, path: join(root, "contract.yaml") }).contract!;
  const runtime = new SessionActiveGraphRuntime();
  const target = {
    sessionId: "owner",
    taskFrameId: "quest-A",
    contractId: contract.id,
    contractDigest: contract.contractDigest,
  };
  const memory = new SessionFeedbackProvider(target, async (observation) =>
    runtime.observe(observation),
  );
  const providers = {
    repository: new LocalRepositoryProvider(),
    policy: new DefaultPolicyProvider(),
    harness: new ExternalWorkspaceHarnessProvider(),
    verifier: new LocalNpmVerifierProvider(30_000),
    receipts: new FileReceiptSink(join(root, ".rcp", "receipts")),
    memory,
  };
  const request = {
    root,
    contract,
    routes: readRouteDeclarations(root),
    requestedMode: "apply" as const,
  };
  return { root, contract, runtime, target, memory, providers, request };
}

test("real failing verification feeds bounded, attributed feedback into only its target AG", async (t) => {
  const f = fixture(t, true);
  const result = await reconcileOnce(f.request, f.providers);
  assert.equal(result.status, "failed");
  assert.ok(result.receipt);
  assert.deepEqual(result.memoryDiagnostics, []);
  const snapshot = f.runtime.activateTemporaryProjection("owner");
  assert.ok(snapshot);
  assert.equal(snapshot.items.length, 1);
  const item = snapshot.items[0]!;
  assert.equal(item.kind, "tool_observation");
  assert.equal(item.taskFrameId, "quest-A");
  assert.equal(item.sourceId, `rcp-receipt:${result.receipt.receiptId}`);
  const event = JSON.parse(item.statement);
  assert.equal(event.observedRevision, result.receipt.observedRevisionAfter);
  assert.ok(event.checks.some((check: { status: string }) => check.status === "failed"));
  assert.match(event.interpretation, /not proof of overall task completion/);
  assert.equal(f.runtime.snapshot("other-session"), null);
  await f.memory.notify({ receipt: result.receipt });
  assert.equal(f.runtime.snapshot("owner")!.items.length, 1, "retry deduplicates the same receipt");
  f.runtime.release("owner");
  assert.equal(f.runtime.snapshot("owner"), null);
});

test("scope violations remain visible feedback, not admissible success receipts", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "outside.txt"), "out-of-scope change");
  const result = await reconcileOnce(f.request, f.providers);
  assert.equal(result.status, "failed");
  assert.equal(result.receipt?.scope.matched, false);
  assert.ok(result.receiptPath, "a valid failure receipt must be recorded");
  assert.ok(result.receipt);
  assert.equal(validateReceipt(result.receipt).valid, true);
  assert.equal(
    await f.providers.receipts.find(result.receipt.operationIdentity),
    null,
    "failed receipts cannot certify a successful retry",
  );
  const forgedSuccess = { ...result.receipt, decision: "verified" as const };
  forgedSuccess.receiptId = receiptId(forgedSuccess);
  assert.equal(
    validateReceipt(forgedSuccess).valid,
    false,
    "a fresh hash does not authorize scope violations",
  );
  assert.deepEqual(result.memoryDiagnostics, []);
  const snapshot = f.runtime.activateTemporaryProjection("owner");
  const event = JSON.parse(snapshot!.items[0]!.statement);
  assert.equal(event.scopeMatched, false);
});

test("escaped diagnostic content stays bounded without emitting truncated JSON", async (t) => {
  const f = fixture(t);
  const result = await reconcileOnce(f.request, { ...f.providers, memory: undefined });
  assert.ok(result.receipt);
  const receipt = structuredClone(result.receipt);
  receipt.checks = Array.from({ length: 8 }, () => ({
    name: "check",
    status: "passed" as const,
    durationMs: 0,
    evidence: "\u0001".repeat(800),
    reason: "\u0001".repeat(800),
  }));
  receipt.receiptId = receiptId(receipt);
  await f.memory.notify({ receipt });
  const item = f.runtime.activateTemporaryProjection("owner")!.items[0]!;
  assert.ok(item.statement.length <= 12_000);
  assert.ok(JSON.parse(item.statement).omittedChecks > 0);
});

test("receipt mismatch or tampering cannot enter the target working set", async (t) => {
  const f = fixture(t);
  const result = await reconcileOnce(f.request, { ...f.providers, memory: undefined });
  assert.ok(result.receipt);
  const other = new SessionFeedbackProvider(
    { ...f.target, contractDigest: "another-revision" },
    async (input) => f.runtime.observe(input),
  );
  await assert.rejects(other.notify({ receipt: result.receipt }), /another contract revision/);
  await assert.rejects(
    f.memory.notify({ receipt: { ...result.receipt, decision: "failed" } }),
    /invalid feedback receipt/,
  );
  assert.equal(f.runtime.snapshot("owner"), null);
});

test("feedback outage is diagnostic and cannot veto independently verified work", async (t) => {
  const f = fixture(t);
  const memory = new SessionFeedbackProvider(f.target, async () => {
    throw new Error("feedback unavailable");
  });
  const result = await reconcileOnce(f.request, { ...f.providers, memory });
  assert.equal(result.status, "verified");
  assert.match(result.memoryDiagnostics.join(" "), /feedback unavailable/);
  assert.ok(result.receiptPath);
});

test("CLI sends real receipt feedback through authenticated HTTP without owning daemon lifecycle", async (t) => {
  const f = fixture(t, true);
  const contractPath = join(f.root, "contract.yaml");
  writeFileSync(contractPath, contractText().replace("checks: [check]", "checks: [failing]"));
  await withTestRuntime([testWorkspace(), testDatabase(), testDaemon()], async (runtime) => {
    const state = runtime.daemon().state;
    writeFileSync(serverStatePath(runtime.database().path), JSON.stringify(state));
    const previous = process.env.NMG_DATA_DIR;
    process.env.NMG_DATA_DIR = runtime.workspace().path;
    try {
      // Run an actual failing check; its receipt must reach the real HTTP AG.
      const code = await runRcpCli([
        "reconcile",
        contractPath,
        "--root",
        f.root,
        "--apply",
        "--workspace-ready",
        "--nmg",
        "optional",
        "--session-id",
        "http-owner",
        "--task-frame-id",
        "quest-http",
      ]);
      assert.equal(code, 1);
      const result = (await httpCall(state, "sessionActiveGraph", {
        action: "activate",
        sessionId: "http-owner",
      })) as NmgSessionActiveGraphResult;
      assert.equal(result.action, "activate");
      if (result.action !== "activate") throw new Error("unexpected result");
      assert.equal(result.snapshot?.items.length, 1);
      assert.equal(result.snapshot?.items[0]?.taskFrameId, "quest-http");
      assert.match(result.snapshot?.items[0]?.statement ?? "", /repository-verification-feedback/);
      // It remains available; neither shutdown nor release is implicit in RCP.
      assert.ok(await httpCall(state, "hello"));
    } finally {
      if (previous === undefined) delete process.env.NMG_DATA_DIR;
      else process.env.NMG_DATA_DIR = previous;
    }
  });
});

test("plan mode never emits feedback or an invented completion label", async (t) => {
  const f = fixture(t);
  const result = await reconcileOnce({ ...f.request, requestedMode: "plan" }, f.providers);
  assert.equal(result.status, "planned");
  assert.equal(f.runtime.snapshot("owner"), null);
});
