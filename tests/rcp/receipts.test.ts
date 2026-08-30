import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { FileReceiptSink } from "../../src/rcp/providers.ts";
import type { RepositoryReceipt } from "../../src/rcp/types.ts";
import { receiptId } from "../../src/rcp/receipt.ts";
import { repositoryFixture } from "./fixture.ts";

test("receipt scan reports valid and malformed append-only entries", async () => {
  const root = repositoryFixture();
  const directory = join(root, ".rcp", "receipts");
  const sink = new FileReceiptSink(directory);
  const receipt = fixtureReceipt();
  await sink.append(receipt);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "malformed.json"), "{not-json\n");

  const entries = await sink.scan();
  assert.equal(entries.length, 2);
  assert.equal(entries.filter((entry) => entry.valid).length, 1);
  assert.ok(entries.some((entry) => entry.errors.some((error) => /JSON|parse/i.test(error))));
});

function fixtureReceipt(): RepositoryReceipt {
  const partial: Omit<RepositoryReceipt, "receiptId"> = {
    receiptSchema: "repository.receipt/v1alpha1",
    operationIdentity: "sha256:operation",
    contractId: "fixture",
    contractDigest: "sha256:contract",
    observedRevisionBefore: "sha256:before",
    observedRevisionAfter: "sha256:after",
    invocationId: "invocation",
    startedAt: "2026-08-30T00:00:00.000Z",
    finishedAt: "2026-08-30T00:00:01.000Z",
    harness: { id: "fixture", version: "1", status: "completed", summary: "done" },
    verifier: { id: "fixture", version: "1", digest: "sha256:verifier" },
    workOrder: {
      id: "wo-fixture",
      routeDigest: "sha256:routes",
      routes: ["source"],
      verificationChecks: ["check"],
      budget: { maxAttempts: 1, timeoutMs: 30_000 },
    },
    scope: { declared: ["src/**"], excluded: [], actual: [], matched: true },
    checks: [{ name: "check", status: "passed", durationMs: 1 }],
    decision: "verified",
    diagnostics: [],
  };
  return { ...partial, receiptId: receiptId(partial) };
}
