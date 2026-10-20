import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NmgService } from "../../src/cli/service.ts";
import { SessionTaskWindow } from "../../src/integration/session-task-window.ts";
import { RECALL_VOCABULARY, RECALL_POOL_CAPACITY } from "../../src/core/recall-vocabulary.ts";
import { SessionRecallTrial } from "../../src/core/session-recall.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";
stripProviderEnv();

test("daemon exposes seed vocabulary and removing a seed controls the host entry, not just the list", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-recall-pool-"));
  const service = new NmgService({
    databasePath: join(directory, "memory.sqlite"),
    environment: {},
  });
  try {
    await service.invoke("lab", {
      action: "enable",
      capability: "recall_gate",
      sessionId: "s",
      requester: "agent:test",
      reason: "fixture",
    });
    const turn = async () => {
      const result = await service.invoke("sessionActiveGraph", {
        action: "beginDisclosureTurn",
        sessionId: "s",
        projectDir: directory,
        recall: { prompt: "previously", projectDir: directory, scheduled: false },
      });
      assert.equal(result.action, "beginDisclosureTurn");
      if (result.action !== "beginDisclosureTurn") throw Error("unexpected result");
      return result;
    };
    assert.equal((await turn()).sessionRecall?.decision.mode, "retrieve");
    const list = await service.invoke("lab", {
      action: "invoke",
      capability: "recall_gate",
      sessionId: "s",
      operation: "list",
    });
    assert.equal(list.action, "invoke");
    if (list.action === "invoke")
      assert.equal((list.output as unknown[]).length, RECALL_VOCABULARY.length);
    await service.invoke("lab", {
      action: "invoke",
      capability: "recall_gate",
      sessionId: "s",
      operation: "remove",
      input: { phrase: "previously" },
    });
    const removed = await turn();
    assert.equal(removed.sessionRecall?.decision.mode, "none");
    const host = new SessionTaskWindow();
    assert.equal(host.prepare("s", "previously", removed.sessionRecall?.decision), null);
    assert.equal((await turn()).sessionRecall?.decision.mode, "none");
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("natural admission pressure evicts seed entries and keeps the one shared capacity", () => {
  const trial = new SessionRecallTrial();
  trial.snapshot("s", "/project");
  assert.equal(trial.list("s").length, RECALL_VOCABULARY.length);
  for (let i = 0; i <= RECALL_POOL_CAPACITY - RECALL_VOCABULARY.length; i++) {
    assert.equal(
      trial.offerFromSearch("s", "/project", `Use work item ${i}`, `work item ${i}`, i + 1),
      true,
    );
  }
  assert.equal(trial.list("s").length, RECALL_POOL_CAPACITY);
  assert.equal(
    trial.list("s").some((term) => term.phrase === "之前"),
    false,
  );
  assert.equal(trial.prepare("s", "/project", "之前").decision.mode, "none");
});
