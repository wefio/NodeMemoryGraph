import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ShadowEvaluationLog } from "../../src/core/shadow-evaluation.ts";

test("shadow evaluation records retrieval, actual use, outcome, and feedback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nmg-shadow-"));
  const path = join(directory, "shadow.jsonl");
  const log = new ShadowEvaluationLog(path, {
    now: () => new Date("2026-07-26T00:00:00.000Z"),
  });
  try {
    assert.equal(
      log.retrieval({
        graphId: "graph-1",
        sessionId: "session-1",
        origin: "tool",
        query: "What did I prefer?",
        candidateMemoryIds: ["memory-1"],
        candidateNodeIds: ["node-1"],
        decision: {
          baselineNodeIds: ["node-1", "node-2"],
          learnedNodeIds: ["node-2", "node-1"],
          changed: true,
          trainingSteps: 7,
        },
        usage: {
          nodes: 2,
          edges: 1,
          evidence: 1,
          estimatedTokens: 42,
          graphHops: 1,
          deepestTier: 1,
          latencyMs: 3.5,
          exhausted: [],
        },
        controllerLatencyMs: 0.2,
      }),
      true,
    );
    log.use({
      graphId: "graph-1",
      sessionId: "session-1",
      requestedMemoryIds: ["memory-1", "missing"],
      usedMemoryIds: ["memory-1"],
    });
    log.outcome({
      graphId: "graph-1",
      sessionId: "session-1",
      messageCount: 3,
      inputTokens: 100,
      outputTokens: 20,
    });
    log.feedback({
      graphId: "graph-1",
      sessionId: "session-1",
      taskSuccess: true,
      userCorrection: false,
    });

    const events = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    assert.deepEqual(
      events.map((event) => event.type),
      ["retrieval", "use", "outcome", "feedback"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});

test("shadow evaluation rotates bounded local logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nmg-shadow-"));
  const path = join(directory, "shadow.jsonl");
  const log = new ShadowEvaluationLog(path, { maxBytes: 1_024, retainedFiles: 2 });
  try {
    for (let index = 0; index < 20; index += 1) {
      log.feedback({
        graphId: `graph-${index}`,
        sessionId: "session",
        note: "x".repeat(120),
      });
    }
    assert.equal(readFileSync(path, "utf8").length > 0, true);
    assert.equal(readFileSync(`${path}.1`, "utf8").length > 0, true);
    assert.throws(() => readFileSync(`${path}.2`, "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});
