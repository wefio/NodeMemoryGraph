/** Paired LME recall regression check over existing stores; no provider calls. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import type { OmniMemEvalBridge, OmniRetrievedMemory } from "../omnimemeval/bridge.ts";
import { CachedOmniEmbeddingClient } from "../omnimemeval/embedding-cache.ts";
import { loadDataset } from "./datasets.ts";
import { aggregateByCategory, scoreQuestion } from "./score.ts";
import { writeJsonAtomic } from "../../tools/parts/fs.ts";

const { values } = parseArgs({
  options: {
    "baseline-root": { type: "string" },
    stores: { type: "string" },
    "run-input": { type: "string" },
    cache: { type: "string" },
    "index-id": { type: "string" },
    out: { type: "string" },
    scratch: { type: "string" },
    limit: { type: "string" },
  },
});
function required(name: keyof typeof values): string {
  const value = values[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}
const baselineRoot = resolve(required("baseline-root"));
const storesRoot = resolve(required("stores"));
const runInput = resolve(required("run-input"));
const cachePath = resolve(required("cache"));
const indexId = required("index-id");
const out = resolve(required("out"));
const scratch = resolve(required("scratch"));
if (existsSync(scratch)) throw new Error("--scratch must name a fresh owned directory");
const limit = values.limit === undefined ? undefined : Number(values.limit);
if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
  throw new Error("Invalid --limit");

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function digest(value: unknown): string {
  return hash(JSON.stringify(value));
}
const failProvider = async (): Promise<number[][]> => {
  throw new Error("Provider access is disabled");
};
const client = { indexId, embedQueries: failProvider, embedDocuments: failProvider };
const spec = loadDataset("longmemeval", { full: true });
const prior = JSON.parse(readFileSync(runInput, "utf8")) as Record<
  string,
  Array<{ question: string }>
>;
const users = new Map<string, string>();
for (const [user, rows] of Object.entries(prior)) {
  const index = Number(user.slice(user.lastIndexOf("_") + 1));
  const question = spec.questions[index];
  assert.ok(
    question && rows.length === 1 && rows[0]!.question === question.query,
    `Cannot bind ${user} to dataset`,
  );
  assert.ok(!users.has(question.id), "Duplicate question binding");
  users.set(question.id, user);
}
const questions = spec.questions.slice(0, limit);
assert.ok(questions.length > 0 && users.size === spec.questions.length);
const cache = new CachedOmniEmbeddingClient(cachePath, client, { cacheOnly: true });
try {
  await cache.embedQueries(questions.map((q) => q.query));
} finally {
  cache.close();
}

type BridgeConstructor = typeof OmniMemEvalBridge;
async function bridgeAt(root: string): Promise<BridgeConstructor> {
  return (await import(pathToFileURL(resolve(root, "evals/omnimemeval/bridge.ts")).href))
    .OmniMemEvalBridge as BridgeConstructor;
}
const Baseline = await bridgeAt(baselineRoot);
const Candidate = await bridgeAt(process.cwd());
const options = {
  embeddingClient: client,
  embeddingCachePath: cachePath,
  embeddingCacheOnly: true,
  secondPass: true,
  leafBlockRouting: false,
  appendedMaxChars: 16000,
  appendedMaxRatio: 0.75,
  chainExpansionMaxChains: 4,
  chainExpansionMaxHops: 1,
  chainExpansionMaxMemoryHops: 2,
};
interface Result {
  text: string;
  memories: OmniRetrievedMemory[];
  retrievalMode: string;
}

async function search(
  Bridge: BridgeConstructor,
  directory: string,
  userId: string,
  query: string,
): Promise<Result> {
  const bridge = new Bridge(directory, options);
  try {
    const result = (await bridge.handle({
      id: 1,
      op: "search",
      userId,
      query,
      topK: 20,
    })) as Result;
    assert.equal(result.retrievalMode, "records", "Embedding fallback invalidates this comparison");
    return result;
  } finally {
    bridge.close();
  }
}

function score(question: (typeof questions)[number], result: Result) {
  return scoreQuestion(
    {
      category: question.category,
      golds: question.golds,
      candidates: result.memories.map((m) => [m.statement, m.evidenceExcerpt ?? ""]),
      rankedCandidateCount: result.memories.filter((m) => m.ranked).length,
      contextText: result.text,
    },
    spec.direction,
  );
}
function signature(result: Result): string {
  return digest({
    text: result.text,
    memories: result.memories,
    retrievalMode: result.retrievalMode,
  });
}
function hits(ranks: Array<number | null>): number {
  return ranks.filter((rank) => rank !== null && rank <= 20).length;
}
function implementation(root: string) {
  const paths = [
    "src/core/store/base.ts",
    "src/core/store/retrieval.ts",
    "src/integration/information-output.ts",
    "src/core/store/active-graph.ts",
    "src/integration/agent-surface.ts",
    "evals/omnimemeval/bridge.ts",
  ];
  return Object.fromEntries(paths.map((p) => [p, hash(readFileSync(resolve(root, p)))]));
}

const rows = [];
mkdirSync(scratch, { recursive: false });
try {
  for (const [index, question] of questions.entries()) {
    const userId = users.get(question.id)!;
    const filename = `${hash(userId).slice(0, 24)}.sqlite`;
    const source = resolve(storesRoot, filename);
    assert.ok(existsSync(source), `Missing source store ${source}`);
    const beforeDir = resolve(scratch, "before");
    const afterDir = resolve(scratch, "after");
    mkdirSync(beforeDir);
    mkdirSync(afterDir);
    const snapshotPath = resolve(beforeDir, filename);
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      await backup(db, snapshotPath);
    } finally {
      db.close();
    }
    const snapshotHash = hash(readFileSync(snapshotPath));
    copyFileSync(snapshotPath, resolve(afterDir, filename));
    const before = await search(Baseline, beforeDir, userId, question.query);
    const after = await search(Candidate, afterDir, userId, question.query);
    const baselineScore = score(question, before);
    const candidateScore = score(question, after);
    rows.push({
      id: question.id,
      userId,
      queryHash: hash(question.query),
      snapshotHash,
      baseline: baselineScore,
      candidate: candidateScore,
      baselineOutputHash: signature(before),
      candidateOutputHash: signature(after),
      rankedIdsEqual:
        digest(before.memories.filter((m) => m.ranked).map((m) => m.memoryId)) ===
        digest(after.memories.filter((m) => m.ranked).map((m) => m.memoryId)),
      regressed: hits(candidateScore.rankedGoldRanks) < hits(baselineScore.rankedGoldRanks),
      baselineResultCount: before.memories.length,
      candidateResultCount: after.memories.length,
    });
    // These two directories are created above under this invocation's fresh scratch.
    rmSync(beforeDir, { recursive: true });
    rmSync(afterDir, { recursive: true });
    if ((index + 1) % 25 === 0) console.log(`paired ${index + 1}/${questions.length}`);
  }
  const report = {
    measuredAt: new Date().toISOString(),
    nodeVersion: process.version,
    baselineRevision: execFileSync("git", ["-C", baselineRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    input: {
      dataset: spec.name,
      datasetPath: spec.dataPath,
      datasetHash: spec.sha256,
      runInput,
      runInputHash: hash(readFileSync(runInput)),
      storesRoot,
      cachePath,
      indexId,
      limit: limit ?? null,
      questions: questions.length,
      topK: 20,
      scoring:
        "evals/retrieval/score.ts candidate-in-gold; micro evidence recall; ranked prefix only",
      scoreImplementation: hash(readFileSync("evals/retrieval/score.ts")),
      runnerImplementation: hash(readFileSync("evals/retrieval/infra-recall.ts")),
    },
    implementation: {
      baseline: implementation(baselineRoot),
      candidate: implementation(process.cwd()),
    },
    baseline: aggregateByCategory(
      rows.map((r) => r.baseline),
      [1, 5, 10, 20],
    ),
    candidate: aggregateByCategory(
      rows.map((r) => r.candidate),
      [1, 5, 10, 20],
    ),
    regressedQuestions: rows.filter((r) => r.regressed).length,
    changedOutputs: rows.filter((r) => r.baselineOutputHash !== r.candidateOutputHash).length,
    changedRankedIds: rows.filter((r) => !r.rankedIdsEqual).length,
    rows,
  };
  writeJsonAtomic(out, report);
  console.log(
    JSON.stringify(
      {
        baseline: report.baseline,
        candidate: report.candidate,
        regressedQuestions: report.regressedQuestions,
        changedOutputs: report.changedOutputs,
        changedRankedIds: report.changedRankedIds,
      },
      null,
      2,
    ),
  );
  assert.equal(report.regressedQuestions, 0, "Per-question recall@20 regression");
  assert.equal(report.changedRankedIds, 0, "Ranked record IDs changed");
  assert.equal(report.changedOutputs, 0, "Complete retrieval output changed");
} finally {
  // scratch did not exist at entry; only this invocation writes below it.
  rmSync(scratch, { recursive: true, force: true });
}
