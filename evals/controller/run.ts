import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  CONTROLLER_FEATURE_COUNT,
  controllerSampleFromTrace,
} from "../../src/core/controller-protocol.ts";
import { evaluateControllerGate } from "../../src/core/controller-gate.ts";
import {
  DifferentiableController,
  type ControllerTrainingExample,
} from "../../src/core/differentiable-controller.ts";
import { OpenAIEmbeddingClient } from "../../src/core/openai-embedding.ts";
import { qppCandidates, shouldTriggerSecondPass } from "../../src/core/qpp.ts";
import { NmgStore } from "../../src/core/store.ts";
import { fibonacciEvidenceBudgets } from "../../src/core/store/active-graph.ts";
import { queryIntentFamilies } from "../../src/core/store/search-ranking.ts";
import type { ActiveGraphSelection, MemoryContext } from "../../src/core/types.ts";
import { cosineSimilarity, HashingVectorEmbedder } from "../../src/core/vector.ts";
import { gitRevision, sampleFingerprint } from "../official/reproducibility.ts";
import { resolveBenchmarkData } from "../official/data-path.ts";
import { loadBeam, loadLocomo, stratifiedSample } from "../benchmarks/loaders.ts";
import type { BenchmarkCase } from "../benchmarks/types.ts";

type SupportedBenchmark = "beam" | "locomo";
const QPP2_FEATURE_COUNT = 15;
const QPP2_SAFE_ANCHORS = 15;

interface PreparedCase {
  item: BenchmarkCase;
  sample: ReturnType<typeof controllerSampleFromTrace>;
  context: MemoryContext;
  candidateVectors: Map<string, readonly number[]>;
  evidenceVectors: Map<string, readonly number[]>;
  sourceByMemoryId: Map<string, string>;
  textBySourceId: Map<string, string>;
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
const requestedBudgetFolds = positiveInteger(process.env.NMG_CONTROLLER_BUDGET_FOLDS ?? "5");
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
const budgetCrossValidation = crossValidatedBudgetRows(prepared, epochs, requestedBudgetFolds);
const budgetRows = budgetCrossValidation.rows;
const qpp2Cohesion = summarizeEvidenceCohesion(prepared);
const budget = {
  fixedTop20: summarizeBudget(budgetRows.map((row) => row.fixedTop20)),
  fibonacciQpp: summarizeBudget(budgetRows.map((row) => row.fibonacciQpp)),
  autodiffQpp: summarizeBudget(budgetRows.map((row) => row.autodiffQpp)),
  autodiffQpp2: summarizeBudget(budgetRows.map((row) => row.autodiffQpp2)),
  adaptiveQpp2: summarizeBudget(budgetRows.map((row) => row.adaptiveQpp2)),
  adaptiveQpp2_95: summarizeBudget(budgetRows.map((row) => row.adaptiveQpp2_95)),
  adaptiveQpp2_98: summarizeBudget(budgetRows.map((row) => row.adaptiveQpp2_98)),
  fullTop50Qpp2: summarizeBudget(budgetRows.map((row) => row.fullTop50Qpp2)),
  diverseTop50Qpp2: summarizeBudget(budgetRows.map((row) => row.diverseTop50Qpp2)),
  fullTop50: summarizeBudget(budgetRows.map((row) => row.fullTop50)),
  oracleFibonacci: summarizeBudget(budgetRows.map((row) => row.oracleFibonacci)),
};
const adaptiveQpp2Tradeoff = summarizeCompression(
  budgetRows.map((row) => ({ expanded: row.autodiffQpp, compressed: row.adaptiveQpp2 })),
);
const adaptiveQpp2Tradeoff95 = summarizeCompression(
  budgetRows.map((row) => ({ expanded: row.autodiffQpp, compressed: row.adaptiveQpp2_95 })),
);
const adaptiveQpp2Tradeoff98 = summarizeCompression(
  budgetRows.map((row) => ({ expanded: row.autodiffQpp, compressed: row.adaptiveQpp2_98 })),
);
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
  budgetEvaluation: {
    supervision: "held-out official evidence IDs; the controller sees no labels at inference time",
    validation: `${budgetCrossValidation.folds}-fold stratified cross-validation`,
    policies: {
      fixedTop20: "first 20 selected memories",
      fibonacciQpp: "start at Top-1 and continue through Fibonacci tiers while QPP triggers",
      autodiffQpp:
        "autodiff evidence-budget head chooses the first Fibonacci tier; QPP may continue",
      autodiffQpp2:
        "keep a high-confidence prefix, then use a differentiable necessity head to replace noisy tail items",
      adaptiveQpp2:
        "retain 90% of the local probe probability mass with a safe prefix; flat lists remain wide",
      adaptiveQpp2_95: "same adaptive policy retaining 95% of local probability mass",
      adaptiveQpp2_98: "same adaptive policy retaining 98% of local probability mass",
      fullTop50Qpp2:
        "retrieve 50 candidates, keep a safe prefix, then select necessary evidence from the expansion",
      diverseTop50Qpp2:
        "keep five relevance anchors, then fill to 20 by round-robin semantic node coverage",
      fullTop50: "all available memories up to the experiment cap",
      oracleFibonacci: "smallest Fibonacci tier containing every retrievable official evidence",
    },
    summary: budget,
    adaptiveQpp2Tradeoff: {
      retainedMass90: adaptiveQpp2Tradeoff,
      retainedMass95: adaptiveQpp2Tradeoff95,
      retainedMass98: adaptiveQpp2Tradeoff98,
    },
    trainingMs: budgetCrossValidation.trainingMs,
    trainingSteps: budgetCrossValidation.trainingSteps,
    qpp2Cohesion,
    rows: budgetRows,
  },
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
process.stdout.write(
  process.env.NMG_CONTROLLER_COMPACT === "1"
    ? `${JSON.stringify(
        {
          runDirectory,
          benchmark,
          cases: prepared.length,
          budget,
          adaptiveQpp2Tradeoff: {
            retainedMass90: adaptiveQpp2Tradeoff,
            retainedMass95: adaptiveQpp2Tradeoff95,
            retainedMass98: adaptiveQpp2Tradeoff98,
          },
          qpp2Cohesion,
        },
        null,
        2,
      )}\n`
    : `${JSON.stringify(report, null, 2)}\n`,
);

async function prepareCorpus(item: BenchmarkCase, directory: string): Promise<PreparedCorpus> {
  const startedAt = performance.now();
  mkdirSync(directory, { recursive: true });
  const store = new NmgStore(resolve(directory, "nmg.sqlite"));
  const sourceByMemoryId = new Map<string, string>();
  const textBySourceId = new Map<string, string>();
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
        textBySourceId.set(turn.sourceId, `${turn.speaker ?? turn.role}: ${turn.content}`);
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
      textBySourceId,
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
    const candidateVectors = new Map<string, readonly number[]>();
    const evidenceVectors = new Map<string, readonly number[]>();
    const candidateTexts = context.results.map((result) => result.memory.statement);
    const evidenceEntries = (item.evidenceIds ?? []).flatMap((sourceId) => {
      const text = corpus.textBySourceId.get(sourceId);
      return text ? [{ sourceId, text }] : [];
    });
    if (process.env.NMG_EMBED_BASE_URL && candidateTexts.length > 0) {
      const client = embeddingClient();
      const vectors = await client.embedDocuments([
        ...candidateTexts,
        ...evidenceEntries.map((entry) => entry.text),
      ]);
      context.results.forEach((result, index) => {
        candidateVectors.set(result.memory.id, vectors[index]!);
      });
      evidenceEntries.forEach((entry, index) => {
        evidenceVectors.set(entry.sourceId, vectors[candidateTexts.length + index]!);
      });
      embeddingRequests += 1;
      embeddedTexts += candidateTexts.length + evidenceEntries.length;
    } else {
      const embedder = new HashingVectorEmbedder();
      context.results.forEach((result) => {
        candidateVectors.set(result.memory.id, embedder.embed(result.memory.statement));
      });
      evidenceEntries.forEach((entry) => {
        evidenceVectors.set(entry.sourceId, embedder.embed(entry.text));
      });
    }
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
      candidateVectors,
      evidenceVectors,
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

interface BudgetPolicyResult {
  recall: number;
  precision: number;
  evidenceFound: number;
  officialEvidence: number;
  visibleMemories: number;
  estimatedTokens: number;
  initialTier: number;
  finalTier: number;
  stages: number;
  qppStopped: boolean;
  inferenceMs: number;
}

function compareBudgets(
  item: PreparedCase,
  controller: DifferentiableController,
  qpp2Controller: DifferentiableController,
) {
  const evidence = new Set(item.item.evidenceIds ?? []);
  const ordered = orderedSelections(item);
  const cap = Math.min(50, ordered.length);
  const fixedTop20 = budgetAt(item, evidence, ordered, Math.min(20, cap), 20, 1, false, 0);
  const fullTop50 = budgetAt(item, evidence, ordered, cap, cap, 1, false, 0);
  const tiers = fibonacciEvidenceBudgets(Math.max(1, cap));
  const oracleTier =
    tiers.find(
      (tier) =>
        budgetAt(item, evidence, ordered, tier, tier, 1, false, 0).recall >= fullTop50.recall,
    ) ?? cap;
  const oracleFibonacci = budgetAt(item, evidence, ordered, oracleTier, oracleTier, 1, false, 0);
  const fibonacciQpp = progressiveBudget(item, evidence, ordered, 1);
  const inferenceStartedAt = performance.now();
  const allocation = controller.allocateBudget(item.sample.globalFeatures);
  const allocationMs = performance.now() - inferenceStartedAt;
  const initialTier = projectFibonacciTier(allocation.evidence, Math.max(1, cap));
  const autodiffQpp = progressiveBudget(item, evidence, ordered, initialTier, allocationMs);
  const autodiffQpp2 = learnedSelectionBudget(
    item,
    qpp2Controller,
    evidence,
    ordered,
    initialTier,
    20,
    QPP2_SAFE_ANCHORS,
    allocationMs,
  );
  const adaptiveQpp2 = adaptiveSelectionBudget(
    item,
    qpp2Controller,
    evidence,
    ordered,
    initialTier,
    QPP2_SAFE_ANCHORS,
    0.9,
    allocationMs,
  );
  const adaptiveQpp2_95 = adaptiveSelectionBudget(
    item,
    qpp2Controller,
    evidence,
    ordered,
    initialTier,
    QPP2_SAFE_ANCHORS,
    0.95,
    allocationMs,
  );
  const adaptiveQpp2_98 = adaptiveSelectionBudget(
    item,
    qpp2Controller,
    evidence,
    ordered,
    initialTier,
    QPP2_SAFE_ANCHORS,
    0.98,
    allocationMs,
  );
  const fullTop50Qpp2 = learnedSelectionBudget(
    item,
    qpp2Controller,
    evidence,
    ordered,
    cap,
    20,
    QPP2_SAFE_ANCHORS,
  );
  const diverseTop50Qpp2 = diversitySelectionBudget(item, evidence, ordered, cap, 20, 5);
  return {
    id: item.item.id,
    category: item.item.category,
    candidateRecall: fullTop50.recall,
    fixedTop20,
    fibonacciQpp,
    autodiffQpp,
    autodiffQpp2,
    adaptiveQpp2,
    adaptiveQpp2_95,
    adaptiveQpp2_98,
    fullTop50Qpp2,
    diverseTop50Qpp2,
    fullTop50,
    oracleFibonacci,
  };
}

function adaptiveSelectionBudget(
  item: PreparedCase,
  controller: DifferentiableController,
  evidence: Set<string>,
  ordered: Array<{ result: MemoryContext["results"][number]; selection: ActiveGraphSelection }>,
  candidateBreadth: number,
  safeAnchors: number,
  retainedMass: number,
  previousInferenceMs = 0,
): BudgetPolicyResult {
  const startedAt = performance.now();
  const candidates = ordered.slice(0, candidateBreadth);
  if (candidates.length === 0) {
    return budgetFromEntries(item, evidence, [], 0, 0, 1, true, previousInferenceMs);
  }
  const scored = candidates
    .map((entry) => {
      const probability = clampProbability(
        controller.scoreMemory(qpp2Features(item, entry, candidates)),
      );
      return {
        entry,
        logit: Math.log(probability / (1 - probability)),
      };
    })
    .sort(
      (left, right) =>
        right.logit - left.logit || left.entry.selection.rank - right.entry.selection.rank,
    );
  const maximum = scored[0]!.logit;
  const masses = scored.map((item) => Math.exp(item.logit - maximum));
  const totalMass = sum(masses);
  const selectedIds = new Set(
    candidates
      .slice(0, Math.min(safeAnchors, candidates.length))
      .map((entry) => entry.result.memory.id),
  );
  let accumulated = 0;
  for (let index = 0; index < scored.length; index += 1) {
    accumulated += masses[index]!;
    selectedIds.add(scored[index]!.entry.result.memory.id);
    if (accumulated / Math.max(totalMass, Number.EPSILON) >= retainedMass) break;
  }
  const selected = candidates.filter((entry) => selectedIds.has(entry.result.memory.id));
  return budgetFromEntries(
    item,
    evidence,
    selected,
    candidateBreadth,
    candidateBreadth,
    1,
    selected.length < candidates.length,
    previousInferenceMs + performance.now() - startedAt,
  );
}

function learnedSelectionBudget(
  item: PreparedCase,
  controller: DifferentiableController,
  evidence: Set<string>,
  ordered: Array<{ result: MemoryContext["results"][number]; selection: ActiveGraphSelection }>,
  candidateBreadth: number,
  outputLimit: number,
  safeAnchors: number,
  previousInferenceMs = 0,
): BudgetPolicyResult {
  const startedAt = performance.now();
  const candidates = ordered.slice(0, candidateBreadth);
  const anchorCount = Math.min(safeAnchors, outputLimit, candidates.length);
  const selected = candidates.slice(0, anchorCount);
  const selectedIds = new Set(selected.map((entry) => entry.result.memory.id));
  const additions = candidates
    .filter((entry) => !selectedIds.has(entry.result.memory.id))
    .map((entry) => ({
      entry,
      // QPP2 estimates whether this candidate contributes necessary evidence.
      // It does not compete for Top-1 and cannot evict the safe prefix.
      score: controller.scoreMemory(qpp2Features(item, entry, candidates)),
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.entry.selection.rank - right.entry.selection.rank,
    )
    .slice(0, Math.max(0, outputLimit - selected.length));
  selected.push(...additions.map(({ entry }) => entry));
  return budgetFromEntries(
    item,
    evidence,
    selected,
    candidateBreadth,
    candidateBreadth,
    1,
    true,
    previousInferenceMs + performance.now() - startedAt,
  );
}

function diversitySelectionBudget(
  item: PreparedCase,
  evidence: Set<string>,
  ordered: Array<{ result: MemoryContext["results"][number]; selection: ActiveGraphSelection }>,
  candidateBreadth: number,
  outputLimit: number,
  anchors: number,
): BudgetPolicyResult {
  const startedAt = performance.now();
  const candidates = ordered.slice(0, candidateBreadth);
  const selected = candidates.slice(0, Math.min(anchors, outputLimit));
  const selectedIds = new Set(selected.map((entry) => entry.result.memory.id));
  const byNode = new Map<
    string,
    Array<{ result: MemoryContext["results"][number]; selection: ActiveGraphSelection }>
  >();
  for (const entry of candidates) {
    if (selectedIds.has(entry.result.memory.id)) continue;
    const bucket = byNode.get(entry.result.node.id) ?? [];
    bucket.push(entry);
    byNode.set(entry.result.node.id, bucket);
  }
  while (selected.length < outputLimit && byNode.size > 0) {
    for (const [nodeId, bucket] of byNode) {
      const entry = bucket.shift();
      if (entry) {
        selected.push(entry);
        selectedIds.add(entry.result.memory.id);
      }
      if (bucket.length === 0) byNode.delete(nodeId);
      if (selected.length >= outputLimit) break;
    }
  }
  return budgetFromEntries(
    item,
    evidence,
    selected,
    candidateBreadth,
    candidateBreadth,
    1,
    true,
    performance.now() - startedAt,
  );
}

function qpp2TrainingExample(item: PreparedCase): ControllerTrainingExample | null {
  const candidates = orderedSelections(item).slice(0, 50);
  const evidence = new Set(item.item.evidenceIds ?? []);
  const positives = candidates.filter((entry) =>
    evidence.has(item.sourceByMemoryId.get(entry.result.memory.id) ?? ""),
  );
  if (positives.length === 0) return null;
  const negatives = candidates
    .filter((entry) => !evidence.has(item.sourceByMemoryId.get(entry.result.memory.id) ?? ""))
    .slice(0, Math.max(8, positives.length * 6));
  const memoryPairs = positives.flatMap((positive) =>
    negatives.map((negative) => ({
      preferredFeatures: qpp2Features(item, positive, candidates),
      rejectedFeatures: qpp2Features(item, negative, candidates),
    })),
  );
  return memoryPairs.length > 0 ? { memoryPairs } : null;
}

function qpp2Features(
  item: PreparedCase,
  entry: { result: MemoryContext["results"][number]; selection: ActiveGraphSelection },
  candidates: Array<{ result: MemoryContext["results"][number]; selection: ActiveGraphSelection }>,
): number[] {
  const nodeCount = candidates.filter(
    (candidate) => candidate.result.node.id === entry.result.node.id,
  ).length;
  const intents = new Set(queryIntentFamilies(item.item.question).map((intent) => intent.name));
  const pairwise = candidates
    .filter((candidate) => candidate.result.memory.id !== entry.result.memory.id)
    .map((candidate) =>
      boundedCosine(
        item.candidateVectors.get(entry.result.memory.id),
        item.candidateVectors.get(candidate.result.memory.id),
      ),
    )
    .sort((left, right) => right - left);
  const neighbours = candidates.filter(
    (candidate) => candidate.result.memory.id !== entry.result.memory.id,
  );
  const neighbourWeights = neighbours.map((candidate) =>
    Math.exp(
      boundedCosine(
        item.candidateVectors.get(entry.result.memory.id),
        item.candidateVectors.get(candidate.result.memory.id),
      ) / 0.1,
    ),
  );
  const weightTotal = sum(neighbourWeights);
  const secondOrderRelevance =
    weightTotal === 0
      ? 0
      : neighbours.reduce(
          (total, candidate, index) =>
            total +
            (neighbourWeights[index]! / weightTotal) * boundedScore(candidate.result.combinedScore),
          0,
        );
  const resonanceGain = boundedScore(
    0.5 + (secondOrderRelevance - boundedScore(entry.result.combinedScore)) / 2,
  );
  const relatedNodes = new Set<string>();
  for (const relation of item.context.relations) {
    if (relation.sourceNodeId === entry.result.node.id) relatedNodes.add(relation.targetNodeId);
    if (relation.targetNodeId === entry.result.node.id) relatedNodes.add(relation.sourceNodeId);
  }
  const graphSupport =
    candidates.filter(
      (candidate) =>
        candidate.result.node.id === entry.result.node.id ||
        relatedNodes.has(candidate.result.node.id),
    ).length / Math.max(1, candidates.length);
  return [
    boundedScore(entry.result.lexicalScore),
    boundedScore(entry.result.vectorScore),
    boundedScore(entry.result.routeScore),
    boundedScore(entry.result.combinedScore),
    boundedScore(entry.selection.scores.usefulness),
    entry.selection.rank / Math.max(1, candidates.length),
    nodeCount / Math.max(1, candidates.length),
    pairwise[0] ?? 0,
    average(pairwise.slice(0, 3)),
    pairwise.filter((score) => score >= 0.7).length / Math.max(1, pairwise.length),
    graphSupport,
    secondOrderRelevance,
    resonanceGain,
    Number(intents.has("list_count")),
    Number(intents.has("recommend")),
  ];
}

function crossValidatedBudgetRows(
  values: PreparedCase[],
  trainingEpochs: number,
  requestedFolds: number,
): {
  folds: number;
  rows: ReturnType<typeof compareBudgets>[];
  trainingMs: number;
  trainingSteps: number;
} {
  const categories = new Map<string, PreparedCase[]>();
  for (const item of values) {
    const group = categories.get(item.item.category) ?? [];
    group.push(item);
    categories.set(item.item.category, group);
  }
  const folds = Math.max(
    2,
    Math.min(requestedFolds, ...[...categories.values()].map((group) => group.length)),
  );
  const assignments = new Map<PreparedCase, number>();
  for (const group of categories.values()) {
    group.forEach((item, index) => assignments.set(item, index % folds));
  }
  const rows: ReturnType<typeof compareBudgets>[] = [];
  let trainingMs = 0;
  let trainingSteps = 0;
  for (let fold = 0; fold < folds; fold += 1) {
    const training = values.filter((item) => assignments.get(item) !== fold);
    const heldOut = values.filter((item) => assignments.get(item) === fold);
    const foldController = new DifferentiableController(CONTROLLER_FEATURE_COUNT);
    const qpp2Controller = new DifferentiableController(QPP2_FEATURE_COUNT);
    const startedAt = performance.now();
    for (let epoch = 0; epoch < trainingEpochs; epoch += 1) {
      for (const item of rotate(training, epoch)) {
        if (item.sample.training) foldController.train(item.sample.training, 0.03);
        const qpp2Example = qpp2TrainingExample(item);
        if (qpp2Example) qpp2Controller.train(qpp2Example, 0.03);
      }
    }
    trainingMs += performance.now() - startedAt;
    trainingSteps += foldController.trainingSteps + qpp2Controller.trainingSteps;
    rows.push(...heldOut.map((item) => compareBudgets(item, foldController, qpp2Controller)));
  }
  rows.sort((left, right) => left.id.localeCompare(right.id));
  return { folds, rows, trainingMs, trainingSteps };
}

function progressiveBudget(
  item: PreparedCase,
  evidence: Set<string>,
  ordered: Array<{ result: MemoryContext["results"][number]; selection: ActiveGraphSelection }>,
  requestedInitialTier: number,
  controllerInferenceMs = 0,
): BudgetPolicyResult {
  const startedAt = performance.now();
  const cap = Math.min(50, ordered.length);
  if (cap === 0) {
    return budgetAt(item, evidence, ordered, 0, 0, 0, true, controllerInferenceMs);
  }
  const tiers = fibonacciEvidenceBudgets(cap);
  const initialTier = tiers.find((tier) => tier >= requestedInitialTier) ?? cap;
  let stages = 0;
  let finalTier = initialTier;
  let qppStopped = false;
  for (const tier of tiers.filter((value) => value >= initialTier)) {
    stages += 1;
    finalTier = tier;
    const prefix = ordered.slice(0, tier);
    const decision = shouldTriggerSecondPass(
      item.item.question,
      qppCandidates(
        prefix.map((entry) => entry.result),
        prefix.map((entry) => entry.selection),
      ),
    );
    if (!decision.trigger) {
      qppStopped = true;
      break;
    }
  }
  return budgetAt(
    item,
    evidence,
    ordered,
    finalTier,
    initialTier,
    stages,
    qppStopped,
    controllerInferenceMs + performance.now() - startedAt,
  );
}

function budgetAt(
  item: PreparedCase,
  evidence: Set<string>,
  ordered: Array<{ result: MemoryContext["results"][number]; selection: ActiveGraphSelection }>,
  visible: number,
  initialTier: number,
  stages: number,
  qppStopped: boolean,
  inferenceMs: number,
): BudgetPolicyResult {
  const selected = ordered.slice(0, visible);
  return budgetFromEntries(
    item,
    evidence,
    selected,
    initialTier,
    selected.length,
    stages,
    qppStopped,
    inferenceMs,
  );
}

function budgetFromEntries(
  item: PreparedCase,
  evidence: Set<string>,
  selected: Array<{ result: MemoryContext["results"][number]; selection: ActiveGraphSelection }>,
  initialTier: number,
  finalTier: number,
  stages: number,
  qppStopped: boolean,
  inferenceMs: number,
): BudgetPolicyResult {
  const sources = new Set(
    selected.map((entry) => item.sourceByMemoryId.get(entry.result.memory.id) ?? ""),
  );
  const evidenceFound = [...evidence].filter((id) => sources.has(id)).length;
  return {
    recall: evidence.size === 0 ? 1 : evidenceFound / evidence.size,
    precision: selected.length === 0 ? 0 : evidenceFound / selected.length,
    evidenceFound,
    officialEvidence: evidence.size,
    visibleMemories: selected.length,
    estimatedTokens: selected.reduce((total, entry) => total + entry.selection.estimatedTokens, 0),
    initialTier,
    finalTier,
    stages,
    qppStopped,
    inferenceMs,
  };
}

function orderedSelections(
  item: PreparedCase,
): Array<{ result: MemoryContext["results"][number]; selection: ActiveGraphSelection }> {
  const results = new Map(item.context.results.map((result) => [result.memory.id, result]));
  return (item.context.activeGraph?.selections ?? [])
    .slice()
    .sort((left, right) => left.rank - right.rank)
    .flatMap((selection) => {
      const result = results.get(selection.memoryId);
      return result ? [{ result, selection }] : [];
    });
}

function projectFibonacciTier(fraction: number, maximum: number): number {
  const projected = 1 + (maximum - 1) * Math.max(0, Math.min(1, fraction));
  return fibonacciEvidenceBudgets(maximum).find((tier) => tier >= projected) ?? maximum;
}

function summarizeBudget(rows: BudgetPolicyResult[]) {
  return {
    recall: average(rows.map((row) => row.recall)),
    precision: average(rows.map((row) => row.precision)),
    evidenceFound: sum(rows.map((row) => row.evidenceFound)),
    officialEvidence: sum(rows.map((row) => row.officialEvidence)),
    visibleMemories: average(rows.map((row) => row.visibleMemories)),
    estimatedTokens: average(rows.map((row) => row.estimatedTokens)),
    initialTier: average(rows.map((row) => row.initialTier)),
    finalTier: average(rows.map((row) => row.finalTier)),
    stages: average(rows.map((row) => row.stages)),
    qppStopRate: average(rows.map((row) => Number(row.qppStopped))),
    inferenceMs: average(rows.map((row) => row.inferenceMs)),
  };
}

function summarizeCompression(
  rows: Array<{ expanded: BudgetPolicyResult; compressed: BudgetPolicyResult }>,
) {
  return {
    evidenceRetention: average(
      rows.map(({ expanded, compressed }) =>
        expanded.evidenceFound === 0
          ? 1
          : Math.min(1, compressed.evidenceFound / expanded.evidenceFound),
      ),
    ),
    tokenCompression: average(
      rows.map(({ expanded, compressed }) =>
        expanded.estimatedTokens === 0
          ? 0
          : 1 - compressed.estimatedTokens / expanded.estimatedTokens,
      ),
    ),
    recordCompression: average(
      rows.map(({ expanded, compressed }) =>
        expanded.visibleMemories === 0
          ? 0
          : 1 - compressed.visibleMemories / expanded.visibleMemories,
      ),
    ),
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
    ? loadLocomo(
        resolveBenchmarkData("LoCoMo", process.env.NMG_LOCOMO_DATA, [
          resolve(root, "evals/locomo/data/locomo10.json"),
          resolve(root, ".benchmarks/official/LoCoMo/data/locomo10.json"),
        ]),
      )
    : loadBeam(
        resolveBenchmarkData("BEAM", process.env.NMG_BEAM_DATA, [
          resolve(root, "evals/beam/data/chats/100K"),
          resolve(root, ".benchmarks/official/BEAM/chats/100K"),
        ]),
      );
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

function boundedScore(value: number): number {
  return Math.max(0, Math.min(Number.isFinite(value) ? value : 0, 1));
}

function clampProbability(value: number): number {
  return Math.max(1e-6, Math.min(1 - 1e-6, value));
}

function boundedCosine(
  left: readonly number[] | undefined,
  right: readonly number[] | undefined,
): number {
  if (!left || !right) return 0;
  return boundedScore((cosineSimilarity(left, right) + 1) / 2);
}

function summarizeEvidenceCohesion(values: PreparedCase[]) {
  const evidencePairs: number[] = [];
  const evidenceNoisePairs: number[] = [];
  let eligibleCases = 0;
  for (const item of values.filter((value) => value.item.category === "1")) {
    const evidenceIds = new Set(item.item.evidenceIds ?? []);
    const positives = [...evidenceIds].filter((sourceId) => item.evidenceVectors.has(sourceId));
    const negatives = item.context.results.filter(
      (result) => !evidenceIds.has(item.sourceByMemoryId.get(result.memory.id) ?? ""),
    );
    if (positives.length < 2 || negatives.length === 0) continue;
    eligibleCases += 1;
    for (let left = 0; left < positives.length; left += 1) {
      for (let right = left + 1; right < positives.length; right += 1) {
        evidencePairs.push(
          boundedCosine(
            item.evidenceVectors.get(positives[left]!),
            item.evidenceVectors.get(positives[right]!),
          ),
        );
      }
    }
    for (const positive of positives) {
      for (const negative of negatives) {
        evidenceNoisePairs.push(
          boundedCosine(
            item.evidenceVectors.get(positive),
            item.candidateVectors.get(negative.memory.id),
          ),
        );
      }
    }
  }
  const evidenceMean = average(evidencePairs);
  const evidenceNoiseMean = average(evidenceNoisePairs);
  return {
    category: "LoCoMo category 1 (official multi-hop)",
    eligibleCases,
    evidencePairs: evidencePairs.length,
    evidenceNoisePairs: evidenceNoisePairs.length,
    evidencePairSimilarity: evidenceMean,
    evidenceNoiseSimilarity: evidenceNoiseMean,
    separation: evidenceMean - evidenceNoiseMean,
    assumptionSupported: evidencePairs.length > 0 && evidenceMean > evidenceNoiseMean,
  };
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
