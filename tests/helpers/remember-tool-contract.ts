import assert from "node:assert/strict";

export async function assertRememberToolContract(
  call: (args: Record<string, unknown>) => Promise<string>,
): Promise<void> {
  await assert.rejects(
    async () => call({ statement: "Incomplete request" }),
    /action=save requires statement and nodeName/u,
  );
  await assert.rejects(
    async () => call({ action: "feedback", activeGraphId: "fixture" }),
    /action=feedback requires at least one label or feedbackNote/u,
  );
  const saved = await call({
    statement: "The detached fixture uses SQLite for archived checkpoints.",
    nodeName: "Detached checkpoint fixture",
    memoryType: "fact",
    recallTriggers: ["archived checkpoints"],
  });
  const memoryId = /Saved ([0-9a-f-]+)/u.exec(saved)?.[1];
  assert.ok(memoryId, saved);
  assert.match(
    await call({ action: "forget", memoryId }),
    /Memory withdrawn from normal retrieval/u,
  );
}
