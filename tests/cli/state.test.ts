import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgService } from "../../src/cli/service.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

async function withService(run: (service: NmgService) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "nmg-state-"));
  const service = new NmgService({ dataDirectory: directory });
  try {
    await run(service);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function enable(service: NmgService, sessionId = "owner") {
  const value = await service.invoke("state", {
    action: "write",
    space: "ag",
    operation: "enable",
    sessionId,
    requester: "agent:test",
    reason: "maintain current provisional state",
  });
  assert.equal(value.result.action, "enable");
  if (value.result.action !== "enable") throw new Error("wrong result");
  assert.ok(value.result.activation?.workingStateBinding);
  return value.result.activation.workingStateBinding;
}

const board = { space: "board", taskId: "test", agentId: "author" } as const;

test("state is an advertised additive RPC with AG and board operations", async () => {
  await withService(async (service) => {
    const hello = await service.invoke("hello");
    assert.ok(hello.methods?.includes("state"));
    assert.ok(hello.capabilities.includes("state-spaces"));
  });
});

test("state AG writes retain explicit leases and read the existing source-bound view", async () => {
  await withService(async (service) => {
    const write = {
      action: "write",
      space: "ag",
      operation: "replace",
      sessionId: "owner",
      text: "Current constraint.",
    } as const;
    await assert.rejects(service.invoke("state", write), /not enabled|binding/u);
    const workingStateBinding = await enable(service);
    const updated = await service.invoke("state", {
      ...write,
      workingStateBinding,
    });
    assert.equal(updated.result.action === "invoke" && updated.result.output, "updated");
    const unchanged = await service.invoke("state", {
      ...write,
      workingStateBinding,
    });
    assert.equal(unchanged.result.action === "invoke" && unchanged.result.output, "unchanged");
    const read = await service.invoke("state", {
      action: "read",
      space: "ag",
      sessionId: "owner",
    });
    assert.equal(read.information?.text, "[temporary] Current constraint.");
    assert.equal(read.information?.included[0]?.source.kind, "ag");
    assert.equal(read.information?.included[0]?.disclosure, "full");
    assert.equal(
      read.result.action === "snapshot" && read.result.snapshot?.items[0]?.statement,
      write.text,
    );
    const other = await service.invoke("state", {
      action: "read",
      space: "ag",
      sessionId: "other",
    });
    assert.equal(other.information?.text, "");
  });
});

test("state AG refuses stale, foreign and forged operation input without changing old text", async () => {
  await withService(async (service) => {
    const binding = await enable(service);
    const write = {
      action: "write",
      space: "ag",
      operation: "replace",
      sessionId: "owner",
      text: "Keep current state.",
      workingStateBinding: binding,
    } as const;
    await service.invoke("state", write);
    await assert.rejects(
      service.invoke("state", { ...write, sessionId: "other" }),
      /binding|not enabled/u,
    );
    await assert.rejects(service.invoke("state", { ...write, taskFrameId: "foreign" }), /field/u);
    await assert.rejects(service.invoke("state", { ...write, text: "x".repeat(8001) }), /budget/u);
    await service.invoke("state", {
      action: "write",
      space: "ag",
      operation: "disable",
      sessionId: "owner",
    });
    const disabled = await service.invoke("state", {
      action: "read",
      space: "ag",
      sessionId: "owner",
    });
    assert.match(disabled.information?.text ?? "", /Keep current state/u);
    await enable(service);
    await assert.rejects(service.invoke("state", write), /binding/u);
  });
});

test("state rejects unknown spaces, operations and mismatched read/write directions", async () => {
  await withService(async (service) => {
    for (const params of [
      { action: "read", space: "unknown" },
      { action: "read", space: "ag", operation: "replace", sessionId: "owner" },
      { action: "write", space: "ag", operation: "read", sessionId: "owner" },
      {
        action: "read",
        ...board,
        operation: "put",
        content: "Must not publish.",
      },
      { action: "write", ...board, operation: "read" },
      { action: "write", ...board, operation: "set" },
    ])
      await assert.rejects(service.invoke("state", params), /space|operation|direction/u);
    const read = await service.invoke("taskBoard", {
      ...board,
      action: "read",
    });
    assert.equal(read.action === "read" && read.entries.length, 0);
  });
});

test("state board uses existing owner data and typed output without publishing private AG", async () => {
  await withService(async (service) => {
    const workingStateBinding = await enable(service);
    await service.invoke("state", {
      action: "write",
      space: "ag",
      operation: "replace",
      sessionId: "owner",
      text: "Private current state.",
      workingStateBinding,
    });
    const put = await service.invoke("state", {
      action: "write",
      ...board,
      operation: "put",
      content: "Shared coordination.",
      kind: "note",
    });
    assert.equal(put.result.action, "put");
    const read = await service.invoke("state", { action: "read", ...board });
    assert.match(read.information?.text ?? "", /Shared coordination/u);
    assert.doesNotMatch(read.information?.text ?? "", /Private current state/u);
    assert.equal(read.information?.included[0]?.source.kind, "board");
    const legacy = await service.invoke("taskBoard", {
      ...board,
      action: "read",
    });
    assert.deepEqual(read.result, legacy, "the façade preserves the original board result");
  });
});

test("state board preserves claim, digest and independent judgement rules", async () => {
  await withService(async (service) => {
    const put = await service.invoke("state", {
      action: "write",
      ...board,
      operation: "put",
      content: "Review this artifact.",
      kind: "handoff",
    });
    if (put.result.action !== "put") throw new Error("wrong result");
    const entryId = put.result.entry.id;
    const worker = { ...board, agentId: "worker", entryId };
    await service.invoke("state", {
      action: "write",
      ...worker,
      operation: "claim",
    });
    await service.invoke("state", {
      action: "write",
      ...worker,
      operation: "deliver",
      digest: "a".repeat(64),
      ref: "artifact.txt",
    });
    await assert.rejects(
      service.invoke("state", {
        action: "write",
        ...worker,
        operation: "judge",
        verdict: "accepted",
        reason: "self judgement",
      }),
      /deliver|judge|independent/u,
    );
    const judged = await service.invoke("state", {
      action: "write",
      ...worker,
      agentId: "reviewer",
      operation: "judge",
      verdict: "accepted",
      reason: "artifact verified",
    });
    assert.equal(judged.result.action === "judge" && judged.result.entry.verdict, "accepted");
    assert.match(judged.information?.text ?? "", /accepted/u);
  });
});
