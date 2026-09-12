import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DATASET_NAMES, loadDataset, type DatasetName } from "../evals/retrieval/datasets.ts";
import { normalizeText } from "../evals/retrieval/score.ts";
import {
  columnsForBlocks,
  relevanceFeatureMatrix,
  RELEVANCE_FEATURE_NAMES,
  type FeatureBlockId,
} from "../src/core/relevance-features.ts";
import { composeQpp, computeQppComponents } from "../src/core/qpp.ts";
import { NmgStore } from "../src/core/store.ts";
import type { QppCandidate } from "../src/core/types.ts";
import { createEmbeddingClientFromEnv } from "../src/core/embedding-provider.ts";
import { searchMemoryContext, type QueryEmbeddingClient } from "../src/integration/search.ts";
import {
  RelevanceModel,
  type RelevanceLoss,
  type RelevanceTrainingExample,
  type RelevanceTrainingPair,
} from "../src/lab/relevance-model.ts";

/**
 * Offline trainer + evaluator for the learned (model-side) relevance gate.
 *
 * Builds (features, label) pairs from an already-ingested benchmark store with
 * gold relevance (no embedding service), splits by QUESTION, mines hard
 * negatives, trains pointwise (BCE / focal) then optionally pairwise (RankNet),
 * fits Platt calibration on a validation split, and reports the AND / union
 * trade-off against the deterministic program gate (flat-list abstain on the
 * raw-scale cv).
 *
 * Usage:
 *   node --experimental-strip-types tools/relevance-model-train.ts \
 *     --dataset locomo --out ~/.nmg/relevance-model.json \
 *     [--loss bce|focal] [--pairwise] [--hard-negatives 8] [--epochs 300]
 *     [--hidden 8] [--lr 0.1] [--json]
 *
 * `--certify` switches to risk-controlled gate selection instead of training a
 * shippable model: it certifies (set-level cut, model floor) pairs on a held-out
 * calibration split at a target selection-conditioned risk alpha and reports the
 * chosen pair on a test split (see `certifyPoints`).
 */

const DATASET_NAMES_SET = new Set<string>(DATASET_NAMES);
const CV_FLOOR = 0.002; // program gate: abstain only when the list is flat

import { reciprocalRankFusion, type RankedRoute } from "../src/lab/rank-fusion.ts";

/**
 * The program gate as a set of *rules* rather than a conjunction of them: each
 * rule ranks the query's own candidates and RRF fuses the rankings. The rules
 * sit on incomparable scales (bounded is 0..1, a term count is unbounded, cosine
 * runs -1..1), which is what rank fusion is for, and a conjunction of them makes
 * the first rule's error unrecoverable. `reciprocalRankFusion` is the product's
 * existing fusion primitive, not a second one.
 */
const RULE_ROUTES = ["bounded", "idf_coverage", "term_coverage", "vector"] as const;
/** Index of the bounded [0,1] hybrid score inside the feature row. */
const FEATURE_INDEX = new Map(RELEVANCE_FEATURE_NAMES.map((name, index) => [name, index]));
/**
 * Query-level features the gate controller reads. It answers "how far should the
 * gate open for this query?" from how much usable signal the candidate set
 * carries — it never scores an individual candidate, so it holds no delete
 * permission.
 */
export const CONTROLLER_FEATURE_NAMES = [
  "qpp_top1",
  "qpp_nqc",
  "qpp_topGap",
  "cv_raw",
  "log_candidates",
  "max_bounded",
  "mean_bounded",
  "max_term_coverage",
  "max_idf_coverage",
  "max_jaccard",
  "max_char_overlap",
  "mean_raw_log",
] as const;
/** The set-level families that decide how far the gate opens. */
/** Composition families swept in the certification lattice. `fusion`, `rrf` and
 *  `rrffusion` are not set-level signals: for `fusion` the "cut" is the convex
 *  weight `w` of `w * model + (1 - w) * program` with the *single-rule* program
 *  score; for `rrffusion` the same weight, but the rules half is the RRF-fused
 *  rule ranking, which is what "the neural head fused with the rules" means; for
 *  `rrf` it is a cut on that fused rule score, intersected with the model. See
 *  `keptIndices` and
 *  docs/experiments/retrieval-quality/gate-cascade-literature-2026-09-09.md. */
const SET_FAMILIES = ["cv", "qpp", "controller", "fusion", "rrf", "rrffusion"] as const;
type SetFamily = (typeof SET_FAMILIES)[number];
/** Bootstrap replicates and seed for the cluster-robust item-level bound. */
const BOOTSTRAP_REPLICATES = 2000;
const BOOTSTRAP_SEED = 0x5f3759df;
/**
 * Quantiles of the split's own score distribution used as the default cut ladder.
 */
const QUANTILE_TARGETS = [0.1, 0.25, 0.5, 0.75, 0.9, 0.97];
/** Acceptance levels for the iso-acceptance frontier comparison. */
const ISO_ACCEPTANCE_LEVELS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.5];

interface Options {
  dataset: DatasetName;
  storeRoot: string;
  out: string;
  loss: RelevanceLoss;
  pairwise: boolean;
  hardNegatives: number;
  epochs: number;
  hidden: number;
  learningRate: number;
  json: boolean;
  cache?: string;
  /** Directory of a BEIR-style qrels dataset (corpus.jsonl/queries.jsonl/qrels/test.tsv). */
  qrels?: string;
  certify: boolean;
  alphas: number[];
  delta: number;
  cvCuts?: number[];
  qppCuts?: number[];
  controllerCuts?: number[];
  modelFloors: number[];
  /** Convex weights for the `fusion` family. Empty disables it, which makes the
   *  lattice identical to the pre-fusion runs. */
  fusionWeights: number[];
  /** Cuts for the `rrf` family (fused rule-ranking score). Undefined uses the
   *  split's own quantile ladder; an empty list disables the family. */
  rrfCuts?: number[];
  /** Rotation of the certification split: at this sample size one split is one
   *  draw, so the offset is swept to see whether a finding survives it. */
  splitOffset: number;
  risk: RiskUnit;
  /** Train against the scale-bound retrieval block as well (default: no). */
  embeddings: boolean;
  /** Embedder identity (`indexId`) the retrieval block belongs to. */
  embedder: string;
}

const DEFAULT_OPTIONS: Options = {
  dataset: "locomo",
  storeRoot: ".benchmarks/retrieval-stores",
  out: resolve(process.env.HOME ?? process.cwd(), ".nmg", "relevance-model.json"),
  loss: "bce",
  pairwise: false,
  hardNegatives: 8,
  epochs: 300,
  hidden: 8,
  learningRate: 0.1,
  json: false,
  certify: false,
  // Ladder of target risks: the kept set's noise rate may not exceed alpha.
  alphas: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
  delta: 0.05,
  // Cut ladders default to quantiles of the split (see `quantileCuts`); the
  // product's own QPP score is top1 + 0.5*nqc in [0, 1.5], but which values bite
  // depends on the path, so they are never hardcoded.
  modelFloors: [0.2, 0.35, 0.5, 0.65, 0.8],
  fusionWeights: [0.2, 0.5, 0.8],
  splitOffset: 0,
  risk: "question",
  embeddings: false,
  embedder: "",
};

/** Strict comma-separated number list; a malformed list must not become [] . */
function numberList(value: string, flag: string): number[] {
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.length === 0 || !parts.every(Number.isFinite)) {
    throw new Error(`${flag} expects a comma-separated list of numbers, got "${value}"`);
  }
  return parts;
}

interface FlagSpec {
  /** Whether the flag consumes the next argv item. */
  takesValue: boolean;
  apply(options: Options, value: string): void;
}

/** Every accepted flag, its arity, and how it lands in {@link Options}. */
const FLAGS: Record<string, FlagSpec> = {
  "--dataset": {
    takesValue: true,
    apply: (options, value) => {
      if (!DATASET_NAMES_SET.has(value)) throw new Error(`unknown dataset: ${value}`);
      options.dataset = value as DatasetName;
    },
  },
  "--store-root": {
    takesValue: true,
    apply: (options, value) => {
      options.storeRoot = value || options.storeRoot;
    },
  },
  "--out": {
    takesValue: true,
    apply: (options, value) => {
      options.out = resolve(value || options.out);
    },
  },
  "--loss": {
    takesValue: true,
    apply: (options, value) => {
      if (value !== "bce" && value !== "focal") throw new Error(`unknown loss: ${value}`);
      options.loss = value;
    },
  },
  "--pairwise": { takesValue: false, apply: (options) => void (options.pairwise = true) },
  "--json": { takesValue: false, apply: (options) => void (options.json = true) },
  "--hard-negatives": {
    takesValue: true,
    apply: (options, value) => void (options.hardNegatives = Number(value)),
  },
  "--epochs": {
    takesValue: true,
    apply: (options, value) => void (options.epochs = Number(value)),
  },
  "--hidden": {
    takesValue: true,
    apply: (options, value) => void (options.hidden = Number(value)),
  },
  "--lr": {
    takesValue: true,
    apply: (options, value) => void (options.learningRate = Number(value)),
  },
  "--qrels": {
    takesValue: true,
    apply: (options, value) => void (options.qrels = value),
  },
  "--cache": {
    takesValue: true,
    apply: (options, value) => void (options.cache = resolve(value)),
  },
  "--certify": { takesValue: false, apply: (options) => void (options.certify = true) },
  "--alphas": {
    takesValue: true,
    apply: (options, value) => void (options.alphas = numberList(value, "--alphas")),
  },
  "--delta": {
    takesValue: true,
    apply: (options, value) => void (options.delta = Number(value)),
  },
  "--cv-cuts": {
    takesValue: true,
    apply: (options, value) => void (options.cvCuts = numberList(value, "--cv-cuts")),
  },
  "--qpp-cuts": {
    takesValue: true,
    apply: (options, value) => void (options.qppCuts = numberList(value, "--qpp-cuts")),
  },
  "--embeddings": { takesValue: false, apply: (options) => void (options.embeddings = true) },
  "--embedder": {
    takesValue: true,
    apply: (options, value) => void (options.embedder = value),
  },
  "--controller-cuts": {
    takesValue: true,
    apply: (options, value) =>
      void (options.controllerCuts = numberList(value, "--controller-cuts")),
  },
  "--model-floors": {
    takesValue: true,
    apply: (options, value) => void (options.modelFloors = numberList(value, "--model-floors")),
  },
  "--fusion-weights": {
    takesValue: true,
    apply: (options, value) =>
      void (options.fusionWeights = value === "none" ? [] : numberList(value, "--fusion-weights")),
  },
  "--rrf-cuts": {
    takesValue: true,
    apply: (options, value) =>
      void (options.rrfCuts = value === "none" ? [] : numberList(value, "--rrf-cuts")),
  },
  "--split-offset": {
    takesValue: true,
    apply: (options, value) => void (options.splitOffset = Number(value)),
  },
  "--risk": {
    takesValue: true,
    apply: (options, value) => {
      if (value !== "question" && value !== "item") {
        throw new Error(`--risk expects question|item, got "${value}"`);
      }
      options.risk = value;
    },
  },
};

function parseArgs(argv: string[]): Options {
  const options: Options = { ...DEFAULT_OPTIONS };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const spec = FLAGS[flag];
    if (!spec) throw new Error(`unknown option: ${flag}`);
    spec.apply(options, spec.takesValue ? (argv[++index] ?? "") : "");
  }
  return options;
}

/**
 * Which feature blocks this run trains against, and which embedder the scores
 * came from. Lexical-only is the default because the retrieval block is an
 * *absolute* score scale: weights trained on one retriever/embedder must not be
 * fed another, so including that block requires naming the embedder.
 */
function itemHeadProvenance(options: Options): { blocks: FeatureBlockId[]; embedder: string } {
  if (!options.embeddings) return { blocks: ["core"], embedder: "none" };
  if (!options.embedder) {
    throw new Error(
      "--embeddings requires --embedder <indexId>: the retrieval block is bound to one embedder",
    );
  }
  return { blocks: ["core", "retrieval"], embedder: options.embedder };
}

/**
 * The live embedding client a run may embed with, or undefined for a
 * lexical-only run. `--embeddings` asserts against the client's own `indexId`
 * rather than trusting the flag: a head that declares one score scale while
 * being trained on another is the silent failure this whole block split exists
 * to prevent.
 */
function embeddingForRun(options: Options): QueryEmbeddingClient | undefined {
  let client: QueryEmbeddingClient | undefined;
  try {
    client = createEmbeddingClientFromEnv(process.env) as QueryEmbeddingClient | undefined;
  } catch (error) {
    if (options.embeddings) throw error;
    return undefined;
  }
  if (!options.embeddings) return client;
  if (!client) {
    throw new Error("--embeddings requires a configured embedding provider (NMG_EMBED_*)");
  }
  if (options.embedder && options.embedder !== client.indexId) {
    throw new Error(`--embedder ${options.embedder} is not the live embedder ${client.indexId}`);
  }
  return client;
}

/** The item-level head, projected onto this run's feature blocks. */
function buildItemModel(options: Options): RelevanceModel {
  const { blocks, embedder } = itemHeadProvenance(options);
  return new RelevanceModel({
    hidden: options.hidden,
    columns: columnsForBlocks(blocks),
    blocks: [...blocks],
    embedder,
  });
}

const userKey = (userId: string) => createHash("sha256").update(userId).digest("hex").slice(0, 24);

interface Group {
  features: number[][];
  labels: number[];
  /** Raw first-stage score per candidate (for the program gate cv + hard negs). */
  raw: number[];
}

async function buildGroups(
  options: Options,
  embedding: QueryEmbeddingClient | undefined,
): Promise<Group[]> {
  const spec = loadDataset(options.dataset, {});
  const root = resolve(options.storeRoot, options.dataset);
  if (!existsSync(root)) {
    throw new Error(
      `no ingested store at ${root}; run \`npm run eval:retrieval -- --dataset ${options.dataset}\``,
    );
  }
  const stores = new Map<string, NmgStore>();
  const getStore = (userId: string): NmgStore | null => {
    const path = resolve(root, `${userKey(userId)}.sqlite`);
    if (!existsSync(path)) return null;
    let store = stores.get(path);
    if (!store) {
      store = new NmgStore(path);
      stores.set(path, store);
    }
    return store;
  };
  const groups: Group[] = [];
  for (const question of spec.questions) {
    const store = getStore(question.userId);
    if (!store) continue;
    const context = await searchMemoryContext(store, embedding, question.query, {
      limit: 20,
      maxTier: 3,
      graphHops: 1,
      tieredDisclosure: true,
      progressiveWarmDisclosure: false,
      expandChains: true,
    });
    if (context.results.length === 0) continue;
    const golds = question.golds.map(normalizeText).filter((gold) => gold.length > 0);
    const features = relevanceFeatureMatrix(question.query, context.results);
    const labels = context.results.map((result) => {
      const text = normalizeText(
        [result.memory.statement, ...(result.evidenceRecords ?? []).map((e) => e.content)].join(
          " ",
        ),
      );
      return golds.some((gold) =>
        spec.direction === "gold-in-candidate" ? text.includes(gold) : gold.includes(text),
      )
        ? 1
        : 0;
    });
    groups.push({
      features,
      labels,
      raw: features.map((row) => Math.expm1(row[0]!)),
    });
  }
  for (const store of stores.values()) store.close();
  return groups;
}

function cvOf(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  if (mean <= 0) return 0;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length);
  return Math.sqrt(variance) / mean;
}

function auc(positive: number[], negative: number[]): number {
  if (positive.length === 0 || negative.length === 0) return 0.5;
  let score = 0;
  for (const p of positive) for (const n of negative) score += p > n ? 1 : p === n ? 0.5 : 0;
  return score / (positive.length * negative.length);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function expectedCalibrationError(scores: number[], labels: number[], bins = 10): number {
  let total = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    const low = bin / bins;
    const high = (bin + 1) / bins;
    const indices = scores
      .map((_, index) => index)
      .filter((i) => {
        const s = scores[i]!;
        return s >= low && (bin === bins - 1 ? s <= high : s < high);
      });
    if (indices.length === 0) continue;
    const confidence = mean(indices.map((i) => scores[i]!));
    const accuracy = mean(indices.map((i) => labels[i]!));
    total += (indices.length / scores.length) * Math.abs(confidence - accuracy);
  }
  return total;
}

function gateSweep(groups: Group[], model: RelevanceModel, floor: number) {
  let kept = 0;
  let keptPositive = 0;
  let hitRecallKept = 0;
  let totalHit = 0;
  for (const group of groups) {
    const keep = group.features
      .map((_, index) => index)
      .filter((index) => model.predict(group.features[index]!) >= floor);
    kept += keep.length;
    keptPositive += keep.filter((index) => group.labels[index] === 1).length;
    if (group.labels.some((label) => label === 1)) {
      totalHit += 1;
      if (keep.some((index) => group.labels[index] === 1)) hitRecallKept += 1;
    }
  }
  return {
    floor,
    kept,
    keptPrecision: kept === 0 ? 0 : keptPositive / kept,
    hitRecallKept: totalHit === 0 ? 0 : hitRecallKept / totalHit,
  };
}

function compositionSweep(groups: Group[], model: RelevanceModel, floor: number) {
  let totalHit = 0;
  let program = 0;
  let learned = 0;
  let intersection = 0;
  let union = 0;
  for (const group of groups) {
    if (!group.labels.some((label) => label === 1)) continue;
    totalHit += 1;
    const programKeeps = cvOf(group.raw) >= CV_FLOOR;
    const learnedKeeps = group.labels.some(
      (label, index) => label === 1 && model.predict(group.features[index]!) >= floor,
    );
    if (programKeeps) program += 1;
    if (learnedKeeps) learned += 1;
    if (programKeeps && learnedKeeps) intersection += 1;
    if (programKeeps || learnedKeeps) union += 1;
  }
  return {
    totalHit,
    program: program / totalHit,
    learned: learned / totalHit,
    intersection: intersection / totalHit,
    union: union / totalHit,
  };
}

/**
 * Certification of a gate threshold pair against a target selection-conditioned
 * risk. The unit is a QUESTION: we "accept" a query when the gate keeps at
 * least one candidate for it, and a kept query is an "error" when every kept
 * candidate is noise (no gold). That is the harm the gate exists to prevent,
 * and it keeps the test i.i.d. per question (candidates within a query are
 * correlated, questions are not).
 *
 * The decision "may this gate ship" is then a hypothesis test per threshold
 * pair and a Bonferroni bound over the lattice, not a metric comparison — see
 * docs/experiments/retrieval-quality/gate-cascade-literature-2026-09-09.md.
 */
export interface LatticePoint {
  family: "none" | "cv" | "qpp" | "controller" | "fusion" | "rrf" | "rrffusion";
  /** Set-level cut: keep the query when its score reaches this value. */
  cut: number;
  /** Model gate floor; null = model disabled (the program-only baseline). */
  modelFloor: number | null;
  /** Questions the gate kept at least one candidate for. */
  acceptedQuestions: number;
  /** Of those, questions where every kept candidate is noise. */
  errorQuestions: number;
  keptCandidates: number;
  /** Of the kept candidates, the ones that are noise. */
  noiseCandidates: number;
  /** Accepted units under the active risk unit (questions or candidates). */
  accepted: number;
  errors: number;
  /** accepted / all units. */
  acceptance: number;
  /** errors / accepted — the selection-conditioned risk. */
  risk: number;
  /** Per accepted question: kept items and how many of them are noise. The
   *  item-level test bootstraps over these clusters, because items within a
   *  question are not independent. */
  items: Array<{ kept: number; noise: number }>;
}

/** Risk unit: a question's whole kept set, or the injected items themselves. */
export type RiskUnit = "question" | "item";

function logAdd(left: number, right: number): number {
  const high = Math.max(left, right);
  const low = Math.min(left, right);
  return high + Math.log1p(Math.exp(low - high));
}

/**
 * Exact one-sided binomial p-value P(Bin(m, alpha) <= k): the evidence for
 * rejecting "the risk of this point exceeds alpha". Small p = certified. Summed
 * in log space because C(m, k) overflows double long before m = 400.
 */
export function binomialAtMost(k: number, m: number, alpha: number): number {
  if (!(alpha > 0 && alpha < 1)) throw new Error(`alpha must be in (0,1), got ${alpha}`);
  if (!Number.isFinite(k) || !Number.isFinite(m)) throw new Error("binomial test needs counts");
  if (k >= m) return 1;
  if (k < 0) return 0;
  if (m <= 0) throw new Error("binomial test needs at least one accepted unit");
  const logAlpha = Math.log(alpha);
  const logBeta = Math.log(1 - alpha);
  let logCoefficient = 0;
  let accumulator = Number.NEGATIVE_INFINITY;
  for (let index = 0; index <= k; index += 1) {
    if (index > 0) logCoefficient += Math.log((m - index + 1) / index);
    const term = logCoefficient + index * logAlpha + (m - index) * logBeta;
    accumulator = accumulator === Number.NEGATIVE_INFINITY ? term : logAdd(accumulator, term);
  }
  return Math.min(1, Math.exp(accumulator));
}

/** Max-acceptance point, ties broken by the lower risk. */
export function maxAcceptance(points: readonly LatticePoint[]): LatticePoint | undefined {
  return points.reduce<LatticePoint | undefined>((winner, point) => {
    if (point.accepted === 0) return winner;
    if (!winner) return point;
    if (point.acceptance > winner.acceptance) return point;
    if (point.acceptance === winner.acceptance && point.risk < winner.risk) return point;
    return winner;
  }, undefined);
}

/**
 * Upper confidence bound on the *aggregate* noise share of the injected items,
 * bootstrapped over questions. The item unit needs this because items inside a
 * question are correlated: the exact binomial on items is optimistic (it treats
 * three noise items from one question as three independent observations).
 * Resampling questions keeps the clustering; the (1 - level) quantile of the
 * replicates is the one-sided bound.
 */
export function bootstrapNoiseShareUpperBound(
  clusters: ReadonlyArray<{ kept: number; noise: number }>,
  options: { replicates: number; level: number; seed: number },
): number {
  if (clusters.length === 0) throw new Error("bootstrap needs at least one accepted question");
  if (!(options.level > 0 && options.level < 1)) {
    throw new Error(`bootstrap level must be in (0,1), got ${options.level}`);
  }
  if (options.replicates < 1) throw new Error("bootstrap needs at least one replicate");
  if (!clusters.every((cluster) => cluster.kept > 0)) {
    throw new Error("an accepted question cannot have zero kept items");
  }
  let state = options.seed >>> 0;
  const shares: number[] = [];
  for (let replicate = 0; replicate < options.replicates; replicate += 1) {
    let kept = 0;
    let noise = 0;
    for (let draw = 0; draw < clusters.length; draw += 1) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const pick = clusters[state % clusters.length]!;
      kept += pick.kept;
      noise += pick.noise;
    }
    shares.push(noise / kept);
  }
  shares.sort((left, right) => left - right);
  const index = Math.min(
    shares.length - 1,
    Math.max(0, Math.ceil(options.level * shares.length) - 1),
  );
  return shares[index]!;
}

/**
 * Certify every point at family-wise error rate `delta` (Bonferroni over the
 * whole lattice: the shipped pair is chosen after seeing all of them, so the
 * multiplicity is the lattice size). Returns the certified set and, among it,
 * the highest-acceptance point.
 */
export function certifyPoints(
  points: readonly LatticePoint[],
  alpha: number,
  delta: number,
  unit: RiskUnit = "question",
): { threshold: number; certified: LatticePoint[]; best?: LatticePoint } {
  if (points.length === 0) throw new Error("certification needs at least one lattice point");
  if (!(delta > 0 && delta < 1)) throw new Error(`delta must be in (0,1), got ${delta}`);
  const threshold = delta / points.length;
  const certified = points
    .filter((point) => point.accepted > 0 && point.errors <= point.accepted)
    .filter((point) =>
      unit === "item"
        ? bootstrapNoiseShareUpperBound(point.items, {
            replicates: BOOTSTRAP_REPLICATES,
            level: 1 - threshold,
            seed: BOOTSTRAP_SEED,
          }) <= alpha
        : binomialAtMost(point.errors, point.accepted, alpha) <= threshold,
    );
  return { threshold, certified, best: maxAcceptance(certified) };
}

/**
 * Does the same bound still hold on a second split? A pair that certifies on
 * calibration and drops on test is the failure mode this whole note is about, so
 * the report says which certified pairs survive a held-out look.
 */
function boundHolds(
  point: LatticePoint,
  entries: readonly CertGroup[],
  models: GateModels,
  alpha: number,
  threshold: number,
  unit: RiskUnit,
): boolean {
  const evaluated = evaluatePoint(entries, models, point.family, point.cut, point.modelFloor, unit);
  if (evaluated.accepted === 0) return false;
  if (unit === "item") {
    return (
      bootstrapNoiseShareUpperBound(evaluated.items, {
        replicates: BOOTSTRAP_REPLICATES,
        level: 1 - threshold,
        seed: BOOTSTRAP_SEED,
      }) <= alpha
    );
  }
  return binomialAtMost(evaluated.errors, evaluated.accepted, alpha) <= threshold;
}

/** A query with its precomputed set-level scores and controller features. */
interface CertGroup {
  group: Group;
  cv: number;
  qpp: number;
  controller: number[];
}

/**
 * Rebuild the product's QPP score from a cached feature row. The cache keeps only
 * the bounded hybrid score, so every row is treated as a direct candidate;
 * `top1` and `nqc` — the two components `composeQpp` reads — depend on nothing
 * else. The intent/expansion components are degenerate here and are not used.
 */
function qppComponentsOf(group: Group): QppComponents {
  const candidates: QppCandidate[] = group.features.map((row) => ({
    strength: row[FEATURE_INDEX.get("bounded")!]!,
    reason: "hybrid_match",
    memoryType: "fact",
    isDirect: true,
  }));
  return computeQppComponents("", candidates);
}

function maxOfColumn(group: Group, column: number): number {
  return group.features.reduce((best, row) => Math.max(best, row[column] ?? 0), 0);
}

function meanOfColumn(group: Group, column: number): number {
  return group.features.length === 0
    ? 0
    : group.features.reduce((sum, row) => sum + (row[column] ?? 0), 0) / group.features.length;
}

function columnOf(name: string): number {
  const column = FEATURE_INDEX.get(name);
  if (column === undefined) throw new Error(`unknown candidate feature: ${name}`);
  return column;
}

/**
 * The query-level row the gate controller reads: how much usable signal this
 * query's candidate set carries (set-level QPP, dispersion, best-item coverage),
 * i.e. the inputs to "how far should the gate open for this query?".
 */
function controllerFeaturesOf(group: Group, components: QppComponents, cv: number): number[] {
  const features = [
    components.top1,
    components.nqc,
    components.topGap,
    cv,
    Math.log1p(group.features.length),
    maxOfColumn(group, columnOf("bounded")),
    meanOfColumn(group, columnOf("bounded")),
    maxOfColumn(group, columnOf("term_coverage")),
    maxOfColumn(group, columnOf("idf_coverage")),
    maxOfColumn(group, columnOf("jaccard")),
    maxOfColumn(group, columnOf("char_overlap")),
    meanOfColumn(group, columnOf("raw_log")),
  ];
  if (features.length !== CONTROLLER_FEATURE_NAMES.length) {
    throw new Error(
      `controller features ${features.length} != declared ${CONTROLLER_FEATURE_NAMES.length}`,
    );
  }
  if (!features.every(Number.isFinite)) throw new Error("controller features must be finite");
  return features;
}

function certGroups(groups: readonly Group[]): CertGroup[] {
  return groups.map((group) => {
    const components = qppComponentsOf(group);
    const cv = cvOf(group.raw);
    return {
      group,
      cv,
      qpp: composeQpp(components),
      controller: controllerFeaturesOf(group, components, cv),
    };
  });
}

/** The two learned heads: item-level (what to keep) and query-level (how far to open). */
interface GateModels {
  item?: RelevanceModel;
  controller?: RelevanceModel;
}

function controllerScore(entry: CertGroup, models: GateModels): number | undefined {
  return models.controller ? models.controller.predict(entry.controller) : undefined;
}

function keepsSetLevel(
  entry: CertGroup,
  family: LatticePoint["family"],
  cut: number,
  models: GateModels,
): boolean {
  // `fusion`, `rrf` and `rrffusion` decide at the item level, so every query
  // with candidates is a candidate for acceptance: their set-level cut is not a
  // signal.
  if (family === "none" || family === "fusion" || family === "rrf" || family === "rrffusion") {
    return true;
  }
  if (family === "cv") return entry.cv >= cut;
  if (family === "qpp") return entry.qpp >= cut;
  const score = controllerScore(entry, models);
  if (score === undefined) throw new Error("the controller family needs a controller model");
  return score >= cut;
}

/** The program gate's own per-candidate score: the bounded lexical scale its
 *  absolute floor reads. Always available, because it is in the core block. */
function programScore(features: readonly number[]): number {
  const index = FEATURE_INDEX.get("bounded");
  if (index === undefined) throw new Error("the fusion family needs the bounded lexical feature");
  const value = features[index];
  if (value === undefined) throw new Error(`feature row is missing "bounded" (index ${index})`);
  return value;
}

/** One rule route per rule name: the query's candidates ordered by that rule. */
function ruleRoutes(entry: CertGroup): RankedRoute[] {
  return RULE_ROUTES.map((name) => {
    const column = FEATURE_INDEX.get(name);
    if (column === undefined) throw new Error(`the rrf family needs the ${name} feature`);
    return {
      ids: entry.group.features
        .map((row, index) => ({ index, value: row[column] ?? 0 }))
        .sort((left, right) => right.value - left.value || left.index - right.index)
        .map(({ index }) => String(index)),
      weight: 1,
    };
  });
}

/** Fused rule score per candidate, keyed by the item's index as a string. */
function rrfScores(entry: CertGroup): Map<string, number> {
  const fused = reciprocalRankFusion(ruleRoutes(entry), entry.group.features.length);
  return new Map(fused.map(({ id, score }) => [id, score]));
}

function keptIndices(
  entry: CertGroup,
  models: GateModels,
  family: LatticePoint["family"],
  cut: number,
  modelFloor: number | null,
): number[] {
  const all = entry.group.features.map((_, index) => index);
  if (family === "rrffusion") {
    // The rules half IS the RRF-fused rule ranking, so this is the neural head
    // fused with the rules with the rules side actually fused. The fused rule
    // score is min-max normalised inside the query (an RRF score is at most
    // routes/61 ≈ 0.066), because a convex combination needs both halves on one
    // scale. `cut` is the weight on the model; `modelFloor` the single threshold.
    if (modelFloor === null) return all;
    if (!models.item) throw new Error("the rrffusion family needs an item model");
    const scores = rrfScores(entry);
    const top = Math.max(0, ...all.map((index) => scores.get(String(index)) ?? 0));
    if (top <= 0) return [];
    return all.filter(
      (index) =>
        cut * models.item!.predict(entry.group.features[index]!) +
          (1 - cut) * ((scores.get(String(index)) ?? 0) / top) >=
        modelFloor,
    );
  }
  if (family === "rrf") {
    // Rules fused by rank, then (only when a floor is set) the model as a second
    // item filter. A query whose fused scores all sit below the cut keeps
    // nothing, so this composition can still abstain.
    const scores = rrfScores(entry);
    const aboveCut = all.filter((index) => (scores.get(String(index)) ?? 0) >= cut);
    if (modelFloor === null) return aboveCut;
    if (!models.item) throw new Error("a model floor needs an item model");
    return aboveCut.filter(
      (index) => models.item!.predict(entry.group.features[index]!) >= modelFloor,
    );
  }
  if (family === "fusion") {
    // A convex combination of the two scores, not an intersection of two
    // thresholds: `cut` is the weight on the model and one threshold keeps the
    // item. Both terms are already bounded to 0..1, which is what lets a single
    // weight stand in for the pair.
    if (modelFloor === null) return all;
    if (!models.item) throw new Error("the fusion family needs an item model");
    return all.filter(
      (index) =>
        cut * models.item!.predict(entry.group.features[index]!) +
          (1 - cut) * programScore(entry.group.features[index]!) >=
        modelFloor,
    );
  }
  if (modelFloor === null) return all;
  if (!models.item) throw new Error("a model floor needs an item model");
  return all.filter((index) => models.item!.predict(entry.group.features[index]!) >= modelFloor);
}

/** Score one (family, cut, model floor) point on one split. */
export function evaluatePoint(
  entries: readonly CertGroup[],
  models: GateModels,
  family: LatticePoint["family"],
  cut: number,
  modelFloor: number | null,
  unit: RiskUnit = "question",
): LatticePoint {
  let acceptedQuestions = 0;
  let errorQuestions = 0;
  let keptCandidates = 0;
  let noiseCandidates = 0;
  const items: Array<{ kept: number; noise: number }> = [];
  for (const entry of entries) {
    if (!keepsSetLevel(entry, family, cut, models)) continue;
    const kept = keptIndices(entry, models, family, cut, modelFloor);
    if (kept.length === 0) continue; // abstain: nothing injected, nothing exposed
    acceptedQuestions += 1;
    keptCandidates += kept.length;
    const noise = kept.filter((index) => entry.group.labels[index] !== 1).length;
    noiseCandidates += noise;
    items.push({ kept: kept.length, noise });
    if (noise === kept.length) errorQuestions += 1;
  }
  const totalCandidates = entries.reduce((sum, entry) => sum + entry.group.labels.length, 0);
  const accepted = unit === "question" ? acceptedQuestions : keptCandidates;
  const errors = unit === "question" ? errorQuestions : noiseCandidates;
  const pool = unit === "question" ? entries.length : totalCandidates;
  if (errors > accepted) throw new Error("errors cannot exceed accepted");
  return {
    family,
    cut,
    modelFloor,
    acceptedQuestions,
    errorQuestions,
    keptCandidates,
    noiseCandidates,
    accepted,
    errors,
    acceptance: pool === 0 ? 0 : accepted / pool,
    risk: accepted === 0 ? 0 : errors / accepted,
    items,
  };
}

interface LatticeSpec {
  family: LatticePoint["family"];
  cut: number;
  modelFloor: number | null;
}

/**
 * Cut ladder for a sweep axis: 0 (keep every question) plus quantiles of the
 * split's own score distribution. Hardcoded cuts silently keep nothing when the
 * live score scale moves (the degraded lexical path is not the hybrid path), and
 * a ladder that keeps nothing cannot certify anything.
 */
export function quantileCuts(values: readonly number[], targets: readonly number[]): number[] {
  if (values.length === 0) throw new Error("quantile cuts need at least one value");
  const sorted = [...values].sort((left, right) => left - right);
  const cuts = new Set<number>([0]);
  for (const target of targets) {
    const position = Math.round(target * (sorted.length - 1));
    const value = sorted[Math.min(sorted.length - 1, Math.max(0, position))]!;
    cuts.add(Number(value.toFixed(4)));
  }
  return [...cuts].sort((left, right) => left - right);
}

function latticeSpec(
  cuts: Record<SetFamily, readonly number[]>,
  modelFloors: readonly number[],
): LatticeSpec[] {
  const floors: Array<number | null> = [null, ...modelFloors];
  const spec: LatticeSpec[] = [{ family: "none", cut: 0, modelFloor: null }];
  for (const family of SET_FAMILIES) {
    for (const cut of cuts[family]) {
      for (const modelFloor of floors) spec.push({ family, cut, modelFloor });
    }
  }
  return spec;
}

export interface IsoRow {
  level: number;
  modelOff?: LatticePoint;
  anyPoint?: LatticePoint;
}

/**
 * Risk at "accept at least `level` of the split", model-off versus the whole
 * lattice. This is the robust way to ask whether the learned half earns a place:
 * counting non-dominated points is noise-sensitive (n=2 swings it), whereas
 * comparing at a fixed acceptance level is not.
 */
export function isoAcceptanceFrontier(
  points: readonly LatticePoint[],
  levels: readonly number[],
): IsoRow[] {
  return levels.map((level) => ({
    level,
    modelOff: lowestRisk(points.filter((p) => p.modelFloor === null && p.acceptance >= level)),
    anyPoint: lowestRisk(points.filter((p) => p.acceptance >= level)),
  }));
}

// ── qrels (BEIR-style) ingest ───────────────────────────────────────────────
// The memory benchmarks label a candidate by whether its text contains the gold
// answer string. That is not a relevance judgment, so the head trained on it
// learns to reproduce a lexical matching rule. A qrels dataset has per-document
// relevance, which is the label this gate actually needs.

interface QrelsDoc {
  _id: string;
  title?: string;
  text?: string;
}

interface QrelsQuery {
  _id: string;
  text: string;
}

/** Document id round-trips through the node name so labels can be looked up. */
const QRELS_NODE_PREFIX = "doc:";
const QRELS_BATCH = 200;

function readJsonl<T>(path: string): T[] {
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) throw new Error(`${path} is empty`);
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

/** TSV `query-id, corpus-id, score`; a score >= 1 is a positive judgment. */
function readQrels(path: string): Map<string, Set<string>> {
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error(`${path} carries no judgments`);
  const byQuery = new Map<string, Set<string>>();
  for (const line of lines.slice(1)) {
    const [queryId, corpusId, score] = line.split("\t");
    if (!queryId || !corpusId || Number(score) < 1) continue;
    const judged = byQuery.get(queryId) ?? new Set<string>();
    judged.add(corpusId);
    byQuery.set(queryId, judged);
  }
  if (byQuery.size === 0) throw new Error(`${path} has no positive judgments`);
  return byQuery;
}

function ingestQrelsDocs(store: NmgStore, docs: readonly QrelsDoc[], project: string): number {
  let written = 0;
  for (let start = 0; start < docs.length; start += QRELS_BATCH) {
    const batch = docs.slice(start, start + QRELS_BATCH).map((doc) => ({
      statement: `${doc.title ? `${doc.title}. ` : ""}${doc.text ?? ""}`.slice(0, 4000),
      nodeName: `${QRELS_NODE_PREFIX}${doc._id}`,
      truthStatus: "verified" as const,
      scope: { project },
    }));
    written += store.rememberMany(batch).length;
  }
  return written;
}

/** Candidate groups over a qrels corpus, built through the production search. */
async function buildQrelsGroups(
  options: Options,
  embedding: QueryEmbeddingClient | undefined,
): Promise<Group[]> {
  const dir = options.qrels;
  if (!dir) throw new Error("--qrels needs a directory");
  const corpusPath = resolve(dir, "corpus.jsonl");
  const queriesPath = resolve(dir, "queries.jsonl");
  const qrelsPath = resolve(dir, "qrels/test.tsv");
  for (const path of [corpusPath, queriesPath, qrelsPath]) {
    if (!existsSync(path)) throw new Error(`missing ${path}`);
  }
  const docs = readJsonl<QrelsDoc>(corpusPath);
  const queries = readJsonl<QrelsQuery>(queriesPath);
  const qrels = readQrels(qrelsPath);
  if (docs.length === 0 || queries.length === 0) throw new Error("empty corpus or queries");
  const project = basename(resolve(dir));
  const dbPath = resolve(options.storeRoot, `qrels-${project}.sqlite`);
  // Ingest is a ONE-TIME cost (thousands of rememberMany calls) and the store
  // persists, so a run is reused. A completion marker keyed to the corpus size
  // is what makes reuse safe: a store that exists but carries fewer documents
  // (an interrupted ingest) would otherwise be searched silently.
  const markerPath = `${dbPath}.complete`;
  const complete =
    existsSync(markerPath) && readFileSync(markerPath, "utf8").trim() === String(docs.length);
  if (!complete && existsSync(dbPath)) rmSync(dbPath, { force: true });
  const store = new NmgStore(dbPath);
  const groups: Group[] = [];
  try {
    if (!complete) {
      const written = ingestQrelsDocs(store, docs, project);
      if (written !== docs.length) {
        throw new Error(`ingested ${written}/${docs.length} documents — refusing a partial store`);
      }
      writeFileSync(markerPath, String(docs.length), "utf8");
    }
    let judgedSeen = 0;
    for (const query of queries) {
      const positives = qrels.get(query._id);
      if (!positives) continue;
      const context = await searchMemoryContext(store, embedding, query.text, {
        limit: 20,
        maxTier: 3,
        graphHops: 1,
        tieredDisclosure: true,
        progressiveWarmDisclosure: false,
        expandChains: true,
        scope: { project },
      });
      if (context.results.length === 0) continue;
      const features = relevanceFeatureMatrix(query.text, context.results);
      const labels = context.results.map((result) =>
        positives.has(result.node.canonicalName.slice(QRELS_NODE_PREFIX.length)) ? 1 : 0,
      );
      if (labels.some((label) => label === 1)) judgedSeen += 1;
      groups.push({ features, labels, raw: features.map((row) => Math.expm1(row[0]!)) });
    }
    if (judgedSeen === 0) {
      throw new Error(
        `no query surfaced a judged document (${queries.length} queries, ${qrels.size} judged): the store scope or the ingest is wrong`,
      );
    }
    process.stdout.write(
      `qrels ingest: ${docs.length} docs, ${queries.length} queries, ${qrels.size} judged queries` +
        ` -> ${groups.length} groups, ${judgedSeen} with a positive candidate
`,
    );
  } finally {
    store.close();
  }
  return groups;
}

async function loadGroups(options: Options): Promise<Group[]> {
  const cache = options.cache ?? resolve(options.storeRoot, `${options.dataset}-groups.json`);
  if (existsSync(cache)) {
    return JSON.parse(readFileSync(cache, "utf8")) as Group[];
  }
  const groups = options.qrels
    ? await buildQrelsGroups(options, embeddingForRun(options))
    : await buildGroups(options, embeddingForRun(options));
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(cache, JSON.stringify(groups), "utf8");
  return groups;
}

function formatPoint(point: LatticePoint | undefined): string {
  if (!point) return "-";
  if (point.family === "none") return "accept all";
  const floor = point.modelFloor === null ? "off" : `model>=${point.modelFloor}`;
  return `${point.family}>=${point.cut} ${floor}`;
}

function formatRate(value: number): string {
  return `${(100 * value).toFixed(1)}%`;
}

function rateCell(point: LatticePoint | undefined): string {
  if (point === undefined) return "-";
  const questionRisk =
    point.acceptedQuestions === 0 ? 0 : point.errorQuestions / point.acceptedQuestions;
  const candidateRisk =
    point.keptCandidates === 0 ? 0 : point.noiseCandidates / point.keptCandidates;
  return `${formatRate(point.acceptance)} | q ${formatRate(questionRisk)} c ${formatRate(candidateRisk)} | n=${point.accepted}`;
}

/** Lowest-risk accepted point; ties go to the higher acceptance. */
export function lowestRisk(points: readonly LatticePoint[]): LatticePoint | undefined {
  return points
    .filter((point) => point.accepted > 0)
    .reduce<LatticePoint | undefined>((winner, point) => {
      if (!winner) return point;
      if (point.risk < winner.risk) return point;
      if (point.risk === winner.risk && point.acceptance > winner.acceptance) return point;
      return winner;
    }, undefined);
}

interface FrontierRow {
  family: SetFamily;
  cut: number;
  cal: LatticePoint;
  test: LatticePoint;
  /** True for the model-off row at this cut (the program-gate baseline). */
  baseline: boolean;
}

/**
 * The frontier on the calibration split: at every set-level cut, the model-off
 * baseline plus the lowest-risk model-on floor. Chosen on calibration and
 * evaluated on test with the same floor — the pair is not re-picked on test.
 */
function frontierRows(
  cuts: Record<SetFamily, readonly number[]>,
  cal: readonly CertGroup[],
  test: readonly CertGroup[],
  models: GateModels,
  modelFloors: readonly number[],
  unit: RiskUnit,
): FrontierRow[] {
  const rows: FrontierRow[] = [];
  for (const family of SET_FAMILIES) {
    for (const cut of cuts[family]) {
      if (family !== "fusion" && family !== "rrffusion") {
        // "Model off" is not a fusion point: with no floor the fused rule keeps
        // everything, so the row would be the trivial accept-all baseline. For
        // `rrf` the model-off row is the program-only baseline we want.
        rows.push({
          family,
          cut,
          cal: evaluatePoint(cal, models, family, cut, null, unit),
          test: evaluatePoint(test, models, family, cut, null, unit),
          baseline: true,
        });
      }
      const withModel = lowestRisk(
        modelFloors.map((floor) => evaluatePoint(cal, models, family, cut, floor, unit)),
      );
      if (!withModel) continue;
      rows.push({
        family,
        cut,
        cal: withModel,
        test: evaluatePoint(test, models, family, cut, withModel.modelFloor, unit),
        baseline: false,
      });
    }
  }
  return rows;
}

/** Risk of an already-chosen point re-evaluated on the test split. */
function testRisk(
  point: LatticePoint,
  test: readonly CertGroup[],
  models: GateModels,
  unit: RiskUnit,
): number {
  return evaluatePoint(test, models, point.family, point.cut, point.modelFloor, unit).risk;
}

/** The highest-acceptance certified point of one family, or undefined. */
function certifiedInFamily(
  certified: readonly LatticePoint[],
  family: LatticePoint["family"],
): LatticePoint | undefined {
  return maxAcceptance(certified.filter((point) => point.family === family));
}

/**
 * Train the query-level gate controller: its target is whether this question's
 * pool contains a gold at all. Its output is a *threshold* — how far the gate
 * opens for this query — so it never decides which candidate to keep and cannot
 * subtract anything the item model or the program gate would have kept.
 */
function trainController(trainGroups: readonly Group[], options: Options): RelevanceModel {
  const entries = certGroups(trainGroups);
  const labels = trainGroups.map((group) => (group.labels.some((label) => label === 1) ? 1 : 0));
  const positives = labels.filter((label) => label === 1).length;
  if (positives === 0 || positives === labels.length) {
    throw new Error(
      `controller needs both classes in the train split (got ${positives}/${labels.length})`,
    );
  }
  const model = new RelevanceModel({
    hidden: options.hidden,
    featureCount: CONTROLLER_FEATURE_NAMES.length,
  });
  model.train(
    entries.map((entry, index) => ({ features: entry.controller, label: labels[index] as 0 | 1 })),
    { epochs: options.epochs, learningRate: options.learningRate, loss: options.loss },
  );
  return model;
}

/**
 * Train once, certify the lattice on the calibration split, report the chosen
 * point on the test split. Answers three questions at once: which set-level
 * signal (raw cv or the product's QPP score), which cut, and whether the model
 * gate buys any acceptance at a certified risk.
 */
interface CertSplit {
  train: Group[];
  cal: Group[];
  test: Group[];
}

/** Every fifth question to test, the next fifth to calibration, the rest to training. */
function certificationSplit(groups: readonly Group[], offset = 0): CertSplit {
  const split: CertSplit = { train: [], cal: [], test: [] };
  groups.forEach((group, index) => {
    const slot = (index + offset) % 5;
    (slot === 0 ? split.test : slot === 1 ? split.cal : split.train).push(group);
  });
  if (split.train.length === 0 || split.cal.length === 0 || split.test.length === 0) {
    throw new Error("certification split produced an empty side");
  }
  return split;
}

interface FamilyResult {
  family: LatticePoint["family"];
  point?: LatticePoint;
  /** True when the same bound still holds on the test split. */
  holds: boolean;
  test?: LatticePoint;
}

function formatFamilyResult(entry: FamilyResult): string {
  if (!entry.point) return `${entry.family}: none certified`;
  return `${entry.family}: ${formatPoint(entry.point)} cal ${rateCell(entry.point)} test ${rateCell(
    entry.test,
  )} ${entry.holds ? "HOLDS" : "DROPS"}`;
}

/** The certification ladder: one line per target risk. */
function certifyAtAlphas(
  calPoints: readonly LatticePoint[],
  test: readonly CertGroup[],
  models: GateModels,
  options: Options,
  unit: RiskUnit,
): { lines: string[]; json: unknown[] } {
  const lines: string[] = [];
  const json: unknown[] = [];
  for (const alpha of options.alphas) {
    const { threshold, certified } = certifyPoints(calPoints, alpha, options.delta, unit);
    const families: FamilyResult[] = SET_FAMILIES.map((family) => {
      const point = certifiedInFamily(certified, family);
      return {
        family,
        point,
        holds: point ? boundHolds(point, test, models, alpha, threshold, unit) : false,
        test: point
          ? evaluatePoint(test, models, point.family, point.cut, point.modelFloor, unit)
          : undefined,
      };
    });
    lines.push(
      `${formatRate(alpha).padStart(5)}  ${families.map(formatFamilyResult).join("   |   ")}`,
    );
    json.push({ alpha, threshold, certified: certified.length, families });
  }
  return { lines, json };
}

/**
 * The iso-acceptance comparison, which is the robust way to ask whether the
 * learned half earns a place: counting non-dominated points is noise-sensitive.
 */
function isoLines(
  isoRows: readonly IsoRow[],
  test: readonly CertGroup[],
  models: GateModels,
  unit: RiskUnit,
): string[] {
  const lines = [
    "",
    'iso-acceptance frontier (smallest risk at "accept at least L"), cal -> test: model-off vs any point',
    "level  model-off                any point                chosen point",
  ];
  for (const row of isoRows) {
    const cell = (point: LatticePoint | undefined) =>
      point
        ? `${formatRate(point.risk)} -> ${formatRate(testRisk(point, test, models, unit))}`
        : "-";
    lines.push(
      `${formatRate(row.level).padStart(5)}  ${cell(row.modelOff).padEnd(23)} ${cell(
        row.anyPoint,
      ).padEnd(23)} ${formatPoint(row.anyPoint)}`,
    );
  }
  return lines;
}

/**
 * Train once, certify the lattice on the calibration split, report the chosen
 * point on the test split. Answers three questions at once: which set-level
 * signal (raw cv or the product's QPP score), which cut, and whether the model
 * gate buys any acceptance at a certified risk.
 */
async function runCertification(options: Options, groups: Group[]): Promise<number> {
  for (const alpha of options.alphas) {
    if (!(alpha > 0 && alpha < 1))
      throw new Error(`--alphas values must be in (0,1), got ${alpha}`);
  }
  if (!Number.isInteger(options.splitOffset) || options.splitOffset < 0) {
    throw new Error(`--split-offset must be a non-negative integer, got ${options.splitOffset}`);
  }
  for (const weight of options.fusionWeights) {
    if (!(weight >= 0 && weight <= 1)) {
      throw new Error(`--fusion-weights must be in [0,1], got ${weight}`);
    }
  }
  const unit: RiskUnit = options.risk;
  const {
    train: trainGroups,
    cal: calGroups,
    test: testGroups,
  } = certificationSplit(groups, options.splitOffset);
  const examples = trainGroups.flatMap((group) =>
    group.features.map((features, row) => ({ features, label: group.labels[row] as 0 | 1 })),
  );
  const model = buildItemModel(options);
  // No Platt fit: the model floor is a lattice axis, so every operating point is
  // certified directly and the calibration split stays untouched by training.
  model.train(examples, {
    epochs: options.epochs,
    learningRate: options.learningRate,
    loss: options.loss,
  });

  const cal = certGroups(calGroups);
  const test = certGroups(testGroups);
  const controller = trainController(trainGroups, options);
  const models: GateModels = { item: model, controller };
  const cuts: Record<SetFamily, number[]> = {
    cv:
      options.cvCuts ??
      quantileCuts(
        cal.map((entry) => entry.cv),
        QUANTILE_TARGETS,
      ),
    qpp:
      options.qppCuts ??
      quantileCuts(
        cal.map((entry) => entry.qpp),
        QUANTILE_TARGETS,
      ),
    controller:
      options.controllerCuts ??
      quantileCuts(
        cal.map((entry) => controllerScore(entry, models)!),
        QUANTILE_TARGETS,
      ),
    // Fusion weights are absolute (a convex weight), not data-derived cuts: a
    // quantile ladder over them would be meaningless. `rrffusion` reuses them:
    // same axis, same meaning, different rules half.
    fusion: [...options.fusionWeights],
    rrffusion: [...options.fusionWeights],
    rrf:
      options.rrfCuts ??
      quantileCuts(
        // Pooled over candidates, not per-query maxima: the fused score's
        // within-query spread is what decides which items to keep, while the
        // per-query maximum is nearly constant (a unanimous rank-1 candidate
        // scores the same in every query), which collapses the ladder to two
        // values and therefore to "keep everything" or "keep nothing".
        cal.flatMap((entry) => [...rrfScores(entry).values()]),
        QUANTILE_TARGETS,
      ),
  };
  const spec = latticeSpec(cuts, options.modelFloors);
  const withGold = test.filter((entry) => entry.group.labels.some((label) => label === 1)).length;
  if (withGold === 0) {
    throw new Error(`${options.dataset}: no question has a gold in the pool — nothing to certify`);
  }
  const calPoints = spec.map((point) =>
    evaluatePoint(cal, models, point.family, point.cut, point.modelFloor, unit),
  );
  const unitNote =
    unit === "question"
      ? "risk unit = question; error = kept but every kept candidate is noise (i.i.d. per question)"
      : "risk unit = item; error = an injected item is noise — the bound is a cluster bootstrap over" +
        " questions (items within a question are correlated), so it is conservative, not optimistic";
  const lines: string[] = [
    `${options.dataset} certification (${new Date().toISOString()}): ${groups.length} questions` +
      ` (train ${trainGroups.length}, cal ${cal.length}, test ${test.length}), delta=${options.delta}`,
    `  ${unitNote}`,
    `  item head: blocks ${model.blocks.join("+")} (${model.featureCount} columns), embedder ${model.embedder || "unset"}`,
    `  pool ceiling (test): ${formatRate(withGold / test.length)} of questions have a gold anywhere in` +
      ` the pool (${withGold}/${test.length}) — no gate can do better on the other` +
      ` ${formatRate(1 - withGold / test.length)} except by abstaining`,
    `  lattice: ${spec.length} points (${SET_FAMILIES.map((family) => `${family} cuts ${cuts[family].join("/")}`).join("; ")};` +
      ` floors ${options.modelFloors.join("/")}; item model + ${CONTROLLER_FEATURE_NAMES.length}-feature controller)`,
    `  fusion rows read "cut" as the convex weight w: fused = w * model + (1 - w) * program`,
    `  rrffusion rows are the same weight with the rules half = RRF-fused rule ranking (min-max in query)`,
    `  rrf rows read "cut" as the cut on the RRF-fused rule rankings (rules ${RULE_ROUTES.join("/")})`,
    "",
    "frontier (chosen on cal; test uses the same floor; acc = acceptance, q = question risk, c = candidate risk)",
    "family  cut      floor  cal acc | q / c risk | n        test acc | q / c risk | n",
  ];
  for (const row of frontierRows(cuts, cal, test, models, options.modelFloors, unit)) {
    const floor = row.baseline ? "off" : `${row.cal.modelFloor}`;
    lines.push(
      `${row.family.padEnd(6)}  ${String(row.cut).padEnd(8)} ${floor.padEnd(6)}` +
        ` ${rateCell(row.cal)}   ${rateCell(row.test)}`,
    );
  }
  const isoRows = isoAcceptanceFrontier(calPoints, ISO_ACCEPTANCE_LEVELS);
  lines.push(
    ...isoLines(isoRows, test, models, unit),
    "",
    `certification (Bonferroni over ${spec.length} points):`,
  );
  const certification = certifyAtAlphas(calPoints, test, models, options, unit);
  lines.push(...certification.lines);
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          dataset: options.dataset,
          blocks: model.blocks,
          embedder: model.embedder,
          groups: groups.length,
          split: { train: trainGroups.length, cal: cal.length, test: test.length },
          unit,
          poolCeiling: withGold / test.length,
          lattice: spec.length,
          cuts,
          iso: isoRows,
          certification: certification.json,
        },
        null,
        2,
      )}
`,
    );
    return 0;
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  // A qrels run must not report itself under the default --dataset name: the
  // label is the only thing tying a number to the corpus it came from.
  if (options.qrels) options.dataset = basename(resolve(options.qrels)) as Options["dataset"];
  else if (options.cache) {
    // A certification run over a cache built by --qrels inherits the corpus from
    // the cache filename; otherwise its numbers look like another corpus.
    const fromCache = basename(options.cache).match(/^qrels-(.+)-groups\.json$/);
    if (fromCache) options.dataset = fromCache[1] as Options["dataset"];
  }
  const groups = await loadGroups(options);
  const positives = groups.reduce(
    (sum, group) => sum + group.labels.filter((l) => l === 1).length,
    0,
  );
  if (positives === 0) throw new Error(`${options.dataset}: no gold hits — nothing to learn from`);
  if (options.certify) return runCertification(options, groups);

  const trainGroups: Group[] = [];
  const valGroups: Group[] = [];
  const testGroups: Group[] = [];
  groups.forEach((group, index) => {
    (index % 5 === 0 ? testGroups : index % 5 === 1 ? valGroups : trainGroups).push(group);
  });
  const flatten = (sets: Group[]): RelevanceTrainingExample[] =>
    sets.flatMap((group) =>
      group.features.map((features, row) => ({ features, label: group.labels[row] as 0 | 1 })),
    );
  const train = flatten(trainGroups);
  const validation = flatten(valGroups);
  const test = flatten(testGroups);
  if (train.length === 0 || validation.length === 0 || test.length === 0) {
    throw new Error("split produced an empty side");
  }

  const model = buildItemModel(options);
  const beforeTest = test.map((example) => model.predict(example.features));
  const training = model.train(train, {
    epochs: options.epochs,
    learningRate: options.learningRate,
    loss: options.loss,
  });

  // Hard-negative mining: per query with a positive, the negatives the first
  // stage ranked highest are the "semantically close but wrong" cases that the
  // live store is full of.
  let pairwise: RelevanceTrainingResult | undefined;
  if (options.pairwise) {
    const pairs: RelevanceTrainingPair[] = [];
    for (const group of trainGroups) {
      const positiveIdx = group.labels.map((l, i) => (l === 1 ? i : -1)).filter((i) => i >= 0);
      if (positiveIdx.length === 0) continue;
      const negativeIdx = group.labels
        .map((l, i) => (l === 0 ? i : -1))
        .filter((i) => i >= 0)
        .sort((a, b) => group.raw[b]! - group.raw[a]!)
        .slice(0, options.hardNegatives);
      for (const p of positiveIdx) {
        for (const n of negativeIdx) {
          pairs.push({
            positiveFeatures: group.features[p]!,
            negativeFeatures: group.features[n]!,
          });
        }
      }
    }
    if (pairs.length > 0) pairwise = model.trainPairs(pairs, { epochs: 60, learningRate: 0.05 });
  }

  const calibration = model.fitCalibration(validation);
  const afterTest = test.map((example) => model.predict(example.features));
  const testLabels = test.map((example) => example.label);
  const aucBefore = auc(
    beforeTest.filter((_, i) => testLabels[i] === 1),
    beforeTest.filter((_, i) => testLabels[i] === 0),
  );
  const aucAfter = auc(
    afterTest.filter((_, i) => testLabels[i] === 1),
    afterTest.filter((_, i) => testLabels[i] === 0),
  );
  const eceAfter = expectedCalibrationError(afterTest, testLabels);
  const brier = mean(afterTest.map((score, index) => (score - testLabels[index]!) ** 2));

  const sweep = [0.2, 0.35, 0.5].map((floor) => gateSweep(testGroups, model, floor));
  const composition = compositionSweep(testGroups, model, 0.5);

  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(model.toJSON())}\n`, "utf8");

  const report = {
    dataset: options.dataset,
    blocks: model.blocks,
    embedder: model.embedder,
    loss: options.loss,
    pairwise: Boolean(pairwise),
    groups: groups.length,
    trainExamples: train.length,
    positives,
    training,
    pairwiseTraining: pairwise,
    calibration,
    aucBefore,
    aucAfter,
    eceAfter,
    brier,
    gateSweep: sweep,
    composition,
    out: options.out,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `${options.dataset} (loss=${options.loss}${pairwise ? "+pairwise" : ""}): ${groups.length} questions, ${positives} positive candidates\n` +
      `  train ${train.length} / val ${validation.length} / test ${test.length}; loss=${training.loss.toFixed(4)}\n` +
      `  test AUC ${aucBefore.toFixed(3)} -> ${aucAfter.toFixed(3)} | ECE ${eceAfter.toFixed(3)} | Brier ${brier.toFixed(4)}\n` +
      `  calibration: scale=${calibration.scale.toFixed(3)} shift=${calibration.shift.toFixed(3)}\n` +
      `  gate sweep: ${sweep.map((s) => `${s.floor}: prec=${s.keptPrecision.toFixed(3)} hitRecall=${s.hitRecallKept.toFixed(3)}`).join("; ")}\n` +
      `  composition (gold questions, floor 0.5): program=${composition.program.toFixed(3)} learned=${composition.learned.toFixed(3)} AND=${composition.intersection.toFixed(3)} OR=${composition.union.toFixed(3)}\n` +
      `  model written to ${options.out}\n`,
  );
  return 0;
}

// Only run when this file IS the entry point: the pure certification helpers are
// imported by tests/tools/relevance-certify.test.ts, and an unguarded `main()`
// would make every import train a model.
const isEntryPoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
