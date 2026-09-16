import assert from "node:assert/strict";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { acquireFileLock, ShadowEvaluationLog } from "../../src/lab/shadow-evaluation.ts";

test("shadow evaluation separates retrieval, disclosure, attribution, outcome, and feedback", async () => {
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
        queryTaskId: "query:preference",
        candidateMemoryIds: ["memory-1"],
        candidateNodeIds: ["node-1"],
        selections: [
          {
            memoryId: "memory-1",
            nodeId: "node-1",
            source: "direct",
            reason: "lexical_match",
            rank: 1,
            tier: 0,
            estimatedTokens: 20,
            scores: { lexical: 1, vector: 0, route: 0, combined: 1, usefulness: 1 },
          },
        ],
        qpp: {
          trigger: false,
          reason: "ok",
          qpp: 0.9,
          threshold: 0.55,
          components: {
            top1: 0.9,
            variance: 0,
            nqc: 0,
            topGap: 1,
            intentCoverage: 1,
            reasonHealth: 1,
            directCount: 1,
            totalCount: 1,
          },
        },
        decision: {
          baselineNodeIds: ["node-1", "node-2"],
          learnedNodeIds: ["node-2", "node-1"],
          changed: true,
          trainingSteps: 7,
          features: {
            protocolVersion: 2,
            global: [0.25],
            memories: { "memory-1": [0.5] },
            nodes: { "node-1": [0.75] },
            edges: {},
          },
        },
        budget: {
          maxNodes: 8,
          maxEdges: 12,
          maxEvidence: 13,
          maxTokens: 4_000,
          maxGraphHops: 1,
          maxLocalTier: 1,
          maxTierBudget: 1,
          maxLatencyMs: 500,
        },
        usage: {
          nodes: 2,
          edges: 1,
          evidence: 1,
          estimatedTokens: 42,
          graphHops: 1,
          deepestTier: 1,
          tiersOpened: 1,
          deepEvidence: 0,
          latencyMs: 3.5,
          exhausted: [],
        },
        controllerLatencyMs: 0.2,
      }),
      true,
    );
    log.toolFlow({
      graphId: "graph-1",
      sessionId: "session-1",
      action: "search_suppressed",
      reason: "evidence_progression_required",
      query: "same query again",
    });
    log.disclosure({
      graphId: "graph-1",
      sessionId: "session-1",
      requestedMemoryIds: ["memory-1", "missing"],
      disclosedMemoryIds: ["memory-1"],
    });
    log.attribution({
      graphId: "graph-1",
      sessionId: "session-1",
      candidateMemoryIds: ["memory-1"],
      attributedMemoryIds: ["memory-1"],
      method: "answer_overlap",
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
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            queryTaskId?: string;
            qpp?: unknown;
            controllerFeatures?: { protocolVersion: number; global: number[] };
            budget?: { maxEvidence: number };
          },
      );
    assert.deepEqual(
      events.map((event) => event.type),
      ["retrieval", "tool_flow", "disclosure", "attribution", "outcome", "feedback"],
    );
    assert.equal(events[0]?.queryTaskId, "query:preference");
    assert.ok(events[0]?.qpp);
    assert.deepEqual(events[0]?.controllerFeatures, {
      protocolVersion: 2,
      global: [0.25],
      memories: { "memory-1": [0.5] },
      nodes: { "node-1": [0.75] },
      edges: {},
    });
    assert.equal(events[0]?.budget?.maxEvidence, 13);
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

test("shadow evaluation serializes cross-process appends and rotation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nmg-shadow-multiprocess-"));
  const path = join(directory, "shadow.jsonl");
  const modulePath = new URL("../../src/lab/shadow-evaluation.ts", import.meta.url).href;
  try {
    await Promise.all(
      Array.from({ length: 4 }, (_, processIndex) =>
        runChild([
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          `import { ShadowEvaluationLog } from ${JSON.stringify(modulePath)};
           const log = new ShadowEvaluationLog(${JSON.stringify(path)}, { maxBytes: 4096, retainedFiles: 8 });
           for (let i = 0; i < 15; i += 1) {
             if (!log.feedback({ graphId: \`p${processIndex}-g\${i}\`, sessionId: \`p${processIndex}\`, note: "x".repeat(40) })) process.exit(2);
           }`,
        ]),
      ),
    );
    const graphIds = new Set<string>();
    for (let suffix = 8; suffix >= 0; suffix -= 1) {
      const file = suffix === 0 ? path : `${path}.${suffix}`;
      try {
        for (const line of readFileSync(file, "utf8").trim().split("\n").filter(Boolean)) {
          graphIds.add((JSON.parse(line) as { graphId: string }).graphId);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    assert.equal(graphIds.size, 60);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});

function permissionError(): NodeJS.ErrnoException {
  const error = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
  error.code = "EPERM";
  return error;
}

// The opener is injected because a real `EPERM` cannot be produced on demand. Without
// these two, the retry classification is a claim: reverting it to `EEXIST` only would
// leave every test in this file passing, which is how the defect reached `main`.
test("a lock reported as EPERM is contention, and is waited out rather than refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nmg-shadow-lock-"));
  const lockPath = join(directory, "shadow.jsonl.lock");
  let attempts = 0;
  try {
    const handle = acquireFileLock(lockPath, 500, (target) => {
      attempts += 1;
      // Windows reports an existing lock file this way while its owner releases it.
      if (attempts === 1) throw permissionError();
      return openSync(target, "wx");
    });
    assert.equal(attempts, 2, "the second attempt must be reached instead of throwing");
    assert.equal(existsSync(lockPath), true);
    closeSync(handle);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});

test("a lock that never frees still fails loudly, with the lock named", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nmg-shadow-lock-timeout-"));
  const lockPath = join(directory, "shadow.jsonl.lock");
  try {
    assert.throws(
      () =>
        acquireFileLock(lockPath, 30, () => {
          throw permissionError();
        }),
      /shadow evaluation log lock timed out/,
      "contention must not be swallowed into a silent success",
    );
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
});

function runChild(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (error += chunk));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`shadow writer exited ${code}: ${error}`)),
    );
  });
}
