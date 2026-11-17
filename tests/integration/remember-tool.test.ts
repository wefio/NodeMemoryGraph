import assert from "node:assert/strict";
import test from "node:test";
import type { AdapterToolSession } from "../../src/integration/adapter-tool-session.ts";
import { createRememberTool } from "../../src/integration/remember-tool.ts";

test("remember rejects incomplete actions before invoking the owner", async () => {
  const session: AdapterToolSession = {
    sessionId: "native-session",
    requester: "agent:fixture",
    async invoke() {
      assert.fail("incomplete action reached the owner");
    },
  };
  const tool = createRememberTool();
  for (const [action, missing] of [
    ["save", "statement and nodeName"],
    ["forget", "memoryId"],
    ["resolve", "memoryId"],
    ["reopen", "memoryId"],
    ["supersede", "newMemoryId and supersededMemoryId"],
    ["relate", "newMemoryId and relatedMemoryId and relationJudgement"],
    ["feedback", "at least one label or feedbackNote"],
    ["claim_outcome", "memoryId, claimOutcome, and semanticTaskId"],
  ] as const) {
    await assert.rejects(async () => tool.execute({ action }, session), {
      message: `action=${action} requires ${missing}`,
    });
  }
  await assert.rejects(
    async () => createRememberTool(["remember"]).execute({ action: "feedback" }, session),
    /Unsupported remember action: feedback/u,
  );
});

test("remember binds task feedback and reports no-op resolution accurately", async () => {
  let calls = 0;
  const session: AdapterToolSession = {
    sessionId: "native-session",
    requester: "agent:fixture",
    memory: { projectDir: "C:/native-project" },
    async invoke(method, params, cliFallback) {
      calls += 1;
      assert.equal(cliFallback, undefined);
      assert.equal(params.sessionId, "native-session");
      if (method === "recordFeedback") {
        assert.equal(params.activeGraphId, "bound-graph");
        assert.equal(params.taskSuccess, false);
        return { trained: false, activeGraphId: "bound-graph" };
      }
      assert.equal(method, "resolveRemember");
      assert.equal(params.projectDir, "C:/native-project");
      return { action: "forget", memoryId: "old-memory", deleted: false };
    },
  };
  const tool = createRememberTool();
  const feedback = await tool.execute(
    { action: "feedback", activeGraphId: "bound-graph", taskSuccess: false },
    session,
  );
  assert.match(feedback.text, /No staged decision or usable label was found/u);
  const forget = await tool.execute(
    { action: "forget", memoryId: "old-memory", sessionId: "forged" },
    session,
  );
  assert.equal(forget.text, "Memory is already withdrawn or unavailable.");
  assert.equal(calls, 2);
});

test("remember retains source clock in HTTP and CLI, and requires HTTP for scoped provenance", async () => {
  const tool = createRememberTool();
  const saved = {
    statement: "The detached checkpoint uses SQLite.",
    nodeName: "Checkpoints",
    eventTime: "昨天",
    referenceTime: "2025-05-10T00:30:00+08:00",
    timeZone: "Asia/Shanghai",
  };
  const session: AdapterToolSession = {
    sessionId: "native-session",
    requester: "agent:fixture",
    memory: { projectDir: "C:/native-project" },
    async invoke(method, params, cliFallback) {
      assert.equal(method, "remember");
      assert.equal(params.timeZone, saved.timeZone);
      assert.equal(params.referenceTime, saved.referenceTime);
      assert.equal(params.sessionId, "native-session");
      if (params.markers) {
        assert.deepEqual(params.markers, [
          {
            kind: "board_origin",
            attributes: { taskId: "fixture", entryId: "message" },
          },
        ]);
        assert.equal(cliFallback, undefined);
      } else {
        assert.deepEqual(cliFallback?.slice(-6), [
          "--event-time",
          saved.eventTime,
          "--reference-time",
          saved.referenceTime,
          "--time-zone",
          saved.timeZone,
        ]);
      }
      throw new Error("fixture transport stopped before persistence");
    },
  };
  for (const args of [
    saved,
    { ...saved, boardSource: { taskId: "fixture", entryId: "message" } },
  ]) {
    await assert.rejects(
      async () => tool.execute(args, session),
      /fixture transport stopped before persistence/u,
    );
  }
});
