import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgService } from "../../src/cli/service.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

async function withService(run: (service: NmgService) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "nmg-working-state-"));
  const service = new NmgService({ dataDirectory: directory });
  try {
    await run(service);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function enable(service: NmgService) {
  const result = await service.invoke("lab", {
    action: "enable",
    capability: "working_state",
    sessionId: "owner",
    requester: "agent:test",
    reason: "maintain current provisional state",
  });
  assert.equal(result.action, "enable");
  if (result.action !== "enable") throw new Error("wrong result");
  assert.ok(result.activation?.workingStateBinding);
  return result.activation.workingStateBinding;
}

test("working-state Lab discovery, opt-in and short acknowledgements use the existing private AG", async () => {
  await withService(async (service) => {
    const catalog = await service.invoke("lab", { action: "list" });
    assert.equal(catalog.action, "list");
    if (catalog.action === "list")
      assert.deepEqual(catalog.capabilities.find((c) => c.id === "working_state")?.operations, [
        "replace",
        "clear",
      ]);
    await assert.rejects(
      service.invoke("lab", {
        action: "invoke",
        capability: "working_state",
        sessionId: "owner",
        operation: "replace",
        input: { text: "No lease." },
      }),
      /not enabled/u,
    );
    const workingStateBinding = await enable(service);
    const invoke = (text: string) =>
      service.invoke("lab", {
        action: "invoke",
        capability: "working_state",
        sessionId: "owner",
        workingStateBinding,
        operation: "replace",
        input: { text },
      });
    const updated = await invoke("Current constraint.");
    assert.equal(updated.action === "invoke" && updated.output, "updated");
    const unchanged = await invoke("Current constraint.");
    assert.equal(unchanged.action === "invoke" && unchanged.output, "unchanged");
    const snapshot = await service.invoke("sessionActiveGraph", {
      action: "snapshot",
      sessionId: "owner",
    });
    assert.equal(
      snapshot.action === "snapshot" && snapshot.snapshot?.items[0]?.statement,
      "Current constraint.",
    );
    const cleared = await service.invoke("lab", {
      action: "invoke",
      capability: "working_state",
      sessionId: "owner",
      workingStateBinding,
      operation: "clear",
      input: {},
    });
    assert.equal(cleared.action === "invoke" && cleared.output, "cleared");
  });
});

test("model input cannot select frames, omit trusted binding or overwrite state after re-enable", async () => {
  await withService(async (service) => {
    const old = await enable(service);
    const good = {
      action: "invoke" as const,
      capability: "working_state" as const,
      sessionId: "owner",
      workingStateBinding: old,
      operation: "replace",
      input: { text: "Keep old state." },
    };
    await service.invoke("lab", good);
    await assert.rejects(
      service.invoke("lab", { ...good, workingStateBinding: undefined }),
      /binding/u,
    );
    await assert.rejects(
      service.invoke("lab", {
        ...good,
        input: { text: "Select another frame.", taskFrameId: "other" },
      }),
      /input/u,
    );
    await service.invoke("lab", {
      action: "disable",
      capability: "working_state",
      sessionId: "owner",
    });
    await enable(service);
    await assert.rejects(service.invoke("lab", good), /binding/u);
    const snapshot = await service.invoke("sessionActiveGraph", {
      action: "snapshot",
      sessionId: "owner",
    });
    assert.equal(
      snapshot.action === "snapshot" && snapshot.snapshot?.items[0]?.statement,
      "Keep old state.",
    );
  });
});

test("enabled session-frame fallback survives query changes without migrating current state", async () => {
  await withService(async (service) => {
    const workingStateBinding = await enable(service);
    await service.invoke("lab", {
      action: "invoke",
      capability: "working_state",
      sessionId: "owner",
      workingStateBinding,
      operation: "replace",
      input: { text: "Stable working frame." },
    });
    const first = await service.invoke("search", {
      query: "parser",
      sessionId: "owner",
      persistTrace: false,
    });
    const second = await service.invoke("search", {
      query: "serializer",
      sessionId: "owner",
      persistTrace: false,
    });
    assert.equal(first.activeGraph?.taskFrameId, "session");
    assert.equal(second.activeGraph?.taskFrameId, "session");
    const updated = await service.invoke("lab", {
      action: "invoke",
      capability: "working_state",
      sessionId: "owner",
      workingStateBinding,
      operation: "replace",
      input: { text: "Updated after both queries." },
    });
    assert.equal(updated.action === "invoke" && updated.output, "updated");
    const other = await service.invoke("sessionActiveGraph", {
      action: "snapshot",
      sessionId: "other",
    });
    assert.equal(other.action === "snapshot" && other.snapshot, null);
  });
});
