import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ControllerPolicyChannel,
  type ControllerActivationReceipt,
} from "../../src/integration/controller-channel.ts";
import { CONTROLLER_FEATURE_PROTOCOL_VERSION } from "../../src/lab/controller-protocol.ts";
import { ControllerRuntime } from "../../src/lab/controller-runtime.ts";
import { NmgStore } from "../../src/core/store.ts";

test("controller channel keeps a trained candidate shadow-only without approval", () => {
  const fixture = trainedFixture();
  try {
    const channel = new ControllerPolicyChannel({ mode: "shadow", statePath: fixture.statePath });
    assert.equal(channel.descriptor.trainingSteps, 1);
    assert.equal(channel.descriptor.canActuate, false);
    assert.ok(channel.shadow(fixture.context));
    assert.equal(
      channel.allocate(
        fixture.context,
        fixture.context.activeGraph!.budget,
        fixture.context.activeGraph!.budget,
        fixture.context.activeGraph!.budget,
      ),
      null,
    );
  } finally {
    fixture.close();
  }
});

test("off controller mode performs no scoring or actuation", () => {
  const fixture = trainedFixture();
  try {
    const channel = new ControllerPolicyChannel({ mode: "off", statePath: fixture.statePath });
    assert.equal(channel.descriptor.canActuate, false);
    assert.equal(channel.shadow(fixture.context), null);
    assert.equal(channel.fold(fixture.context, 0.98), null);
  } finally {
    fixture.close();
  }
});

test("controlled controller actuation requires controlled provenance", () => {
  const fixture = trainedFixture();
  try {
    assert.throws(
      () =>
        new ControllerPolicyChannel({
          mode: "controlled",
          statePath: fixture.statePath,
          collectionOrigin: "natural",
        }),
      /requires NMG_SHADOW_COLLECTION_ORIGIN=controlled/u,
    );
    assert.equal(
      new ControllerPolicyChannel({
        mode: "controlled",
        statePath: fixture.statePath,
        collectionOrigin: "controlled",
      }).descriptor.canActuate,
      true,
    );
  } finally {
    fixture.close();
  }
});

test("active controller binds candidate, three gate artifacts, and rollback", () => {
  const fixture = trainedFixture();
  try {
    const receiptPath = join(fixture.directory, "activation.json");
    const gatePaths = ["retrieval.json", "controller.json", "product.json"];
    for (const path of gatePaths) writeFileSync(join(fixture.directory, path), `{\"gate\":\"${path}\"}`);
    const rollbackPath = join(fixture.directory, "rollback.json");
    new ControllerRuntime(rollbackPath).save();
    const reference = (path: string) => ({ path, sha256: fingerprint(join(fixture.directory, path)) });
    const receipt: ControllerActivationReceipt = {
      version: 1,
      status: "approved",
      approvedAt: "2026-08-24T00:00:00.000Z",
      approvedBy: "operator:test",
      featureProtocolVersion: CONTROLLER_FEATURE_PROTOCOL_VERSION,
      candidateSha256: fingerprint(fixture.statePath),
      gates: {
        retrieval: reference(gatePaths[0]!),
        controller: reference(gatePaths[1]!),
        product: reference(gatePaths[2]!),
      },
      rollbackTarget: reference("rollback.json"),
    };
    writeFileSync(receiptPath, JSON.stringify(receipt));

    const active = new ControllerPolicyChannel({
      mode: "active",
      statePath: fixture.statePath,
      activationReceiptPath: receiptPath,
    });
    assert.equal(active.descriptor.canActuate, true);
    assert.equal(active.descriptor.candidateSha256, receipt.candidateSha256);

    writeFileSync(join(fixture.directory, gatePaths[2]!), "tampered");
    assert.throws(
      () =>
        new ControllerPolicyChannel({
          mode: "active",
          statePath: fixture.statePath,
          activationReceiptPath: receiptPath,
        }),
      /product artifact fingerprint mismatch/u,
    );

    writeFileSync(join(fixture.directory, gatePaths[2]!), `{\"gate\":\"${gatePaths[2]}\"}`);
    receipt.gates.product = reference(gatePaths[2]!);
    receipt.rollbackTarget = {
      path: "candidate.json",
      sha256: receipt.candidateSha256,
    };
    writeFileSync(receiptPath, JSON.stringify(receipt));
    assert.throws(
      () =>
        new ControllerPolicyChannel({
          mode: "active",
          statePath: fixture.statePath,
          activationReceiptPath: receiptPath,
        }),
      /rollback target must differ/u,
    );
  } finally {
    fixture.close();
  }
});

function trainedFixture() {
  const directory = mkdtempSync(join(tmpdir(), "nmg-controller-channel-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  const saved = store.remember({ statement: "Atlas uses SQLite", nodeName: "Atlas" });
  const context = store.searchContext("Atlas database", {
    sessionId: "session-a",
    persistTrace: false,
  });
  const statePath = join(directory, "candidate.json");
  const runtime = new ControllerRuntime(statePath);
  assert.equal(runtime.observeVerifiedEvidence(context, [saved.memory.id]), true);
  return {
    directory,
    statePath,
    context,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function fingerprint(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
