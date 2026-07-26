import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  CONTROLLER_FEATURE_COUNT,
  controllerSampleFromTrace,
} from "../../src/core/controller-protocol.ts";
import { evaluateControllerGate } from "../../src/core/controller-gate.ts";
import { DifferentiableController } from "../../src/core/differentiable-controller.ts";
import { OpenAIEmbeddingClient } from "../../src/core/openai-embedding.ts";
import { NmgStore } from "../../src/core/store.ts";
import type { MemoryContext } from "../../src/core/types.ts";
import { gitRevision, sampleFingerprint } from "../official/reproducibility.ts";
import { loadBeam, loadLocomo, stratifiedSample } from "../benchmarks/loaders.ts";
import type { BenchmarkCase } from "../benchmarks/types.ts";

type SupportedBenchmark = "beam" | "locomo";

interface PreparedCase {
  item: BenchmarkCase;
  sample: ReturnType<typeof controllerSampleFromTrace>;
  context: MemoryContext;
  sourceByMemoryId: Map<string, string>;
  preparationMs: number;
  featureMs: number;
  embeddingRequests: number;
  embeddedTexts: number;
}

interface PreparedCorpus {
  directory: string;
  sourceByMemoryId: Map<string, string>;
  preparationMs: number;
  embeddingRequests: number;
  embeddedTexts: number;
}

const root = resolve(import.meta.dirname, "../..");
const benchmark = parseBenchmark(process.argv[2]);
const perCategory = positiveInteger(process.argv[3] ?? "4");
const epochs = positiveInteger(process.env.NMG_CONTROLLER_EPOCHS ?? "80");
const topNodes = positiveInteger(process.env.NMG_CONTROLLER_TOP_NODES ?? "2");
const runDirectory = resolve(
  root,
  "evals/controller/results",
  new Date().toISOString().replaceAll(":", "-"),
);
mkdirSync(runDirectory, { recursive: true });

const all = loadCases(benchmark).filter((item) => (item.evidenceIds?.length ?? 0) > 0);
const selected = stratifiedSample(all, perCategory);
if (selected.length < 2) throw new Error("controller evaluation needs at least two labelled cases");

const workspace = join(tmpdir(), `nmg-controller-eval-${process.pid}`);
mkdirSync(workspace, { recursive: true });
const prepared: PreparedCase[] = [];
const corpora = new Map<string, PreparedCorpus>();
try {
  for (const [index, item] of selected.entries()) {
    const key = corpusKey(item);
    let corpus = corpora.get(key);
    if (!corpus) {
      corpus = await prepareCorpus(item, join(workspace, `corpus-${index}`));
      corpora.set(key, corpus);
    }
    prepared.push(await prepareCase(item, corpus));
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

const { train, test } = splitByCategory(prepared);
const controller = new DifferentiableController(CONTROLLER_FEATURE_COUNT);
const trainingStartedAt = performance.now();
const losses: number[] = [];
for (let epoch = 0; epoch < epochs; epoch += 1) {
  for (const item of rotate(train, epoch)) {
    if (!item.sample.training) continue;
    losses.push(controller.train(item.sample.training, 0.03).loss);
  }
}
const trainingMs = performance.now() - trainingStartedAt;

const rows = test.map((item) => compare(item, controller, topNodes));
const baseline = summarize(rows.map((row) => row.baseline));
const learned = summarize(rows.map((row) => row.learned));
const candidateRecall = average(rows.map((row) => row.candidateRecall));
const latencyTolerance = Number.parseFloat(process.env.NMG_CONTROLLER_LATENCY_FACTOR ?? "4");
const recallTolerance = Number.parseFloat(process.env.NMG_CONTROLLER_RECALL_TOLERANCE ?? "0.01");
const gate = evaluateControllerGate(
  {
    trainingCases: train.length,
    candidateRecall,
    baselineRecall: baseline.recall,
    learnedRecall: learned.recall,
    baselinePrecision: baseline.precision,
    learnedPrecision: learned.precision,
    baselineInferenceMs: baseline.inferenceMs,
    learnedInferenceMs: learned.inferenceMs,
  },
  {
    latencyFactor: latencyTolerance,
    qualityTolerance: recallTolerance,
  },
);
const report = {
  benchmark,
  runAt: new Date().toISOString(),
  codeRevision: gitRevision(root),
  sampleFingerprint: sampleFingerprint(
    selected.map((item) => ({
      id: item.id,
      question: item.question,
      evidenceIds: item.evidenceIds,
    })),
  ),
  protocol: {
    featureCount: CONTROLLER_FEATURE_COUNT,
    candidateGenerator: process.env.NMG_EMBED_BASE_URL
      ? `${process.env.NMG_EMBED_MODEL ?? "Qwen/Qwen3-Embedding-0.6B"} ` +
        `(${process.env.NMG_EMBED_PROFILE ?? "qwen3"})`
      : "SQLite FTS5 + hashing vector baseline",
    supervision: "official evidence IDs intersected with retrieved candidates",
    split: "last labelled case per category held out",
    topNodes,
    nodeCandidateLimit: candidateLimit("NMG_CONTROLLER_NODE_CANDIDATES", 5),
    leafCandidateLimit: candidateLimit("NMG_CONTROLLER_LEAF_CANDIDATES", 8),
    vectorGranularity: vectorGranularity(),
    leafBlockSize: candidateLimit("NMG_CONTROLLER_LEAF_BLOCK_SIZE", 32),
    learnedResidualWeight: residualWeight(),
  },
  cases: { total: prepared.length, train: train.length, test: test.length },
  candidateRecall,
  baseline,
  learned,
  costs: {
    corpusPreparationMs: sum([...corpora.values()].map((item) => item.preparationMs)),
    queryPreparationMs: sum(prepared.map((item) => item.preparationMs)),
    featureExtractionMs: sum(prepared.map((item) => item.featureMs)),
    trainingMs,
    trainingSteps: controller.trainingSteps,
    finalTrainingLoss: losses.at(-1) ?? null,
    serializedControllerBytes: Buffer.byteLength(JSON.stringify(controller.toJSON())),
    embeddingRequests:
      sum([...corpora.values()].map((item) => item.embeddingRequests)) +
      sum(prepared.map((item) => item.embeddingRequests)),
    embeddedTexts:
      sum([...corpora.values()].map((item) => item.embeddedTexts)) +
      sum(prepared.map((item) => item.embeddedTexts)),
    languageModelCalls: 0,
  },
  gate,
  eligibleForShadowPi: gate.eligibility.shadow,
  eligibleForActivePi: gate.eligibility.active,
  eligibleForDefaultPi: gate.eligibility.defaultPi,
  rows,
};
writeFileSync(resolve(runDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function prepareCorpus(item: BenchmarkCase, directory: string): Promise<PreparedCorpus> {
  const startedAt = performance.now();
  mkdirSync(directory, { recursive: true });
  const store = new NmgStore(resolve(directory, "nmg.sqlite"));
  const sourceByMemoryId = new Map<string, string>();
  let embeddingRequests = 0;
  let embeddedTexts = 0;
  let previousNodeId: string | undefined;
  try {
    for (const session of item.sessions) {
      let currentNodeId: string | undefined;
      const nodeName = `${item.benchmark} ${corpusKey(item)} ${session.id}`;
      const nodeSummary = session.turns
        .map((turn) => turn.content)
        .join(" ")
        .slice(0, 1_500);
      for (const turn of session.turns) {
        const saved = store.remember({
          statement: `${turn.speaker ?? turn.role}: ${turn.content}`,
          nodeName,
          nodeSummary,
          memoryType: "conversation_evidence",
          sourceActor: turn.role,
          truthStatus: turn.role === "user" ? "asserted" : "unverified",
          evidence: turn.content,
          sourceRef: `${item.benchmark.toLowerCase()}:${corpusKey(item)}:${turn.sourceId}`,
          eventTime: session.date,
          tier: 2,
          importance: 0.5,
          scope: { benchmark: item.benchmark, corpus: corpusKey(item) },
        });
        sourceByMemoryId.set(saved.memory.id, turn.sourceId);
        currentNodeId = saved.node.id;
      }
      if (previousNodeId && currentNodeId) {
        store.linkNodes({
          sourceNodeId: previousNodeId,
          targetNodeId: currentNodeId,
          type: "related_to",
        });
      }
      previousNodeId = currentNodeId;
    }
    if (process.env.NMG_EMBED_BASE_URL) {
      const client = embeddingClient();
      store.rebuildLeafBlocks(undefined, candidateLimit("NMG_CONTROLLER_LEAF_BLOCK_SIZE", 32));
      const nodes = store.nodeEmbeddingDocuments("", 2_048, client.indexId);
      const nodeVectors = await client.embedDocuments(nodes.map((document) => document.text));
      embeddingRequests += Number(nodes.length > 0);
      embeddedTexts += nodes.length;
      store.upsertExternalNodeEmbeddings(
        client.indexId,
        nodes.map((document, index) => ({
          nodeId: document.nodeId,
          vector: nodeVectors[index]!,
        })),
      );
      const leaves = store.leafEmbeddingDocuments("", 2_048, client.indexId);
      const leafVectors = await client.embedDocuments(leaves.map((document) => document.text));
      embeddingRequests += Number(leaves.length > 0);
      embeddedTexts += leaves.length;
      store.upsertExternalLeafEmbeddings(
        client.indexId,
        leaves.map((document, index) => ({
          blockId: document.blockId,
          vector: leafVectors[index]!,
        })),
      );
      if (vectorGranularity() !== "hierarchy") {
        const records = store.embeddingDocuments("", 2_048, client.indexId);
        const recordVectors = await client.embedDocuments(records.map((document) => document.text));
        embeddingRequests += Number(records.length > 0);
        embeddedTexts += records.length;
        store.upsertExternalEmbeddings(
          client.indexId,
          records.map((document, index) => ({
            memoryId: document.memoryId,
            vector: recordVectors[index]!,
          })),
        );
      }
    }
    return {
      directory,
      sourceByMemoryId,
      preparationMs: performance.now() - startedAt,
      embeddingRequests,
      embeddedTexts,
    };
  } finally {
    store.close();
  }
}

async function prepareCase(item: BenchmarkCase, corpus: PreparedCorpus): Promise<PreparedCase> {
  const startedAt = performance.now();
  const store = new NmgStore(resolve(corpus.directory, "nmg.sqlite"));
  let embeddingRequests = 0;
  let embeddedTexts = 0;
  try {
    let semantic: { queryVector: readonly number[]; model: string } | undefined;
    if (process.env.NMG_EMBED_BASE_URL) {
      const client = embeddingClient();
      semantic = {
        queryVector: (await client.embedQueries([item.question]))[0]!,
        model: client.indexId,
      };
      embeddingRequests = 1;
      embeddedTexts = 1;
    }
    const context = store.searchContext(
      item.question,
      {
        limit: 50,
        graphHops: 1,
        maxTier: 3,
        retrievalMode: "hybrid",
        nodeCandidateLimit: candidateLimit("NMG_CONTROLLER_NODE_CANDIDATES", 5),
        leafCandidateLimit: candidateLimit("NMG_CONTROLLER_LEAF_CANDIDATES", 8),
        vectorGranularity: vectorGranularity(),
        activeGraphBudget: {
          maxNodes: 50,
          maxEdges: 50,
          maxEvidence: 50,
          maxTokens: 100_000,
          maxGraphHops: 1,
          maxLocalTier: 3,
          maxLatencyMs: 5_000,
        },
      },
      semantic,
    );
    if (!context.activeGraph) throw new Error("searchContext did not produce an Active Graph");
    const official = new Set(item.evidenceIds ?? []);
    const usefulMemoryIds = context.results
      .filter((result) => official.has(corpus.sourceByMemoryId.get(result.memory.id) ?? ""))
      .map((result) => result.memory.id);
    const rejectedMemoryIds = context.results
      .map((result) => result.memory.id)
      .filter((id) => !usefulMemoryIds.includes(id));
    store.recordActiveGraphUse(context.activeGraph.id, {
      usedMemoryIds: usefulMemoryIds,
      rejectedMemoryIds,
    });
    const trace = store.retrievalTrace(context.activeGraph.id);
    if (!trace) throw new Error("retrieval trace was not persisted");
    const featureStartedAt = performance.now();
    const sample = controllerSampleFromTrace(context, trace);
    const featureMs = performance.now() - featureStartedAt;
    return {
      item,
      sample,
      context,
      sourceByMemoryId: corpus.sourceByMemoryId,
      preparationMs: performance.now() - startedAt,
      featureMs,
      embeddingRequests,
      embeddedTexts,
    };
  } finally {
    store.close();
  }
}

function corpusKey(item: BenchmarkCase): string {
  const sampleId = item.officialMetadata.sampleId;
  if (typeof sampleId === "string" && sampleId) return `${item.benchmark}:${sampleId}`;
  return `${item.benchmark}:${item.id.split(":")[0]}`;
}

function embeddingClient(): OpenAIEmbeddingClient {
  return new OpenAIEmbeddingClient({
    baseUrl: process.env.NMG_EMBED_BASE_URL,
    model: process.env.NMG_EMBED_MODEL,
    profile: process.env.NMG_EMBED_PROFILE as "bge-en" | "plain" | "qwen3" | undefined,
    timeoutMs: Number.parseInt(process.env.NMG_EMBED_TIMEOUT_MS ?? "30000", 10),
  });
}

function compare(item: PreparedCase, controller: DifferentiableController, limit: number) {
  const evidence = new Set(item.item.evidenceIds ?? []);
  const candidateSources = new Set(
    item.context.results.map((result) => item.sourceByMemoryId.get(result.memory.id) ?? ""),
  );
  const relevantNodes = new Set(
    item.context.results
      .filter((result) => evidence.has(item.sourceByMemoryId.get(result.memory.id) ?? ""))
      .map((result) => result.node.id),
  );
  const baselineStartedAt = performance.now();
  const baselineNodes = rankBaseline(item).slice(0, limit);
  const baselineMs = performance.now() - baselineStartedAt;
  const learnedStartedAt = performance.now();
  const deterministicScores = baselineScores(item);
  const learnedNodes = Object.entries(item.sample.nodeFeatures)
    .map(([nodeId, features]) => ({
      nodeId,
      score:
        (deterministicScores.get(nodeId) ?? 0) +
        residualWeight() * (controller.scoreNode(features) - 0.5),
    }))
    .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId))
    .slice(0, limit)
    .map((value) => value.nodeId);
  const learnedMs = performance.now() - learnedStartedAt;
  return {
    id: item.item.id,
    category: item.item.category,
    officialEvidence: evidence.size,
    candidateRecall: recall(candidateSources, evidence),
    baseline: selectionMetrics(item, baselineNodes, relevantNodes, evidence, baselineMs),
    learned: selectionMetrics(item, learnedNodes, relevantNodes, evidence, learnedMs),
  };
}

function rankBaseline(item: PreparedCase): string[] {
  const scores = baselineScores(item);
  return Object.keys(item.sample.nodeFeatures).sort(
    (left, right) =>
      (scores.get(right) ?? 0) - (scores.get(left) ?? 0) || left.localeCompare(right),
  );
}

function baselineScores(item: PreparedCase): Map<string, number> {
  const scores = new Map<string, number>();
  for (const selection of item.context.activeGraph?.selections ?? []) {
    scores.set(
      selection.nodeId,
      Math.max(scores.get(selection.nodeId) ?? 0, selection.scores.usefulness),
    );
  }
  return scores;
}

function selectionMetrics(
  item: PreparedCase,
  selected: string[],
  relevantNodes: Set<string>,
  evidence: Set<string>,
  inferenceMs: number,
) {
  const nodeHits = selected.filter((id) => relevantNodes.has(id)).length;
  const selectedNodeIds = new Set(selected);
  const selectedSources = new Set(
    item.context.results
      .filter((result) => selectedNodeIds.has(result.node.id))
      .map((result) => item.sourceByMemoryId.get(result.memory.id) ?? ""),
  );
  return {
    recall: recall(selectedSources, evidence),
    precision: selected.length === 0 ? 0 : nodeHits / selected.length,
    inferenceMs,
    selected,
  };
}

function summarize(rows: Array<ReturnType<typeof selectionMetrics>>) {
  return {
    recall: average(rows.map((row) => row.recall)),
    precision: average(rows.map((row) => row.precision)),
    inferenceMs: average(rows.map((row) => row.inferenceMs)),
  };
}

function splitByCategory(values: PreparedCase[]): { train: PreparedCase[]; test: PreparedCase[] } {
  const categories = new Map<string, PreparedCase[]>();
  for (const item of values) {
    const group = categories.get(item.item.category) ?? [];
    group.push(item);
    categories.set(item.item.category, group);
  }
  const test = [...categories.values()].map((group) => group.at(-1)!);
  const testIds = new Set(test.map((item) => item.item.id));
  return { train: values.filter((item) => !testIds.has(item.item.id)), test };
}

function rotate<T>(values: T[], offset: number): T[] {
  if (values.length === 0) return [];
  const index = offset % values.length;
  return [...values.slice(index), ...values.slice(0, index)];
}

function recall(found: Set<string>, expected: Set<string>): number {
  if (expected.size === 0) return 1;
  return [...expected].filter((id) => found.has(id)).length / expected.size;
}

function loadCases(value: SupportedBenchmark): BenchmarkCase[] {
  return value === "locomo"
    ? loadLocomo(resolve(root, "evals/locomo/data/locomo10.json"))
    : loadBeam(resolve(root, "evals/beam/data/chats/100K"));
}

function parseBenchmark(value: string | undefined): SupportedBenchmark {
  if (value === "beam" || value === "locomo") return value;
  throw new Error("controller benchmark must be locomo or beam");
}

function positiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`expected positive integer: ${value}`);
  return parsed;
}

function candidateLimit(name: string, fallback: number): number {
  const configured = process.env[name];
  return configured ? positiveInteger(configured) : fallback;
}

function vectorGranularity(): "hierarchy" | "records" | "union" {
  const value = process.env.NMG_CONTROLLER_VECTOR_GRANULARITY;
  return value === "records" || value === "union" ? value : "hierarchy";
}

function residualWeight(): number {
  const value = Number.parseFloat(process.env.NMG_CONTROLLER_RESIDUAL_WEIGHT ?? "0.1");
  return Math.max(0, Math.min(Number.isFinite(value) ? value : 0.1, 1));
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
