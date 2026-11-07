import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { RelevanceModel, type RelevanceTrainingExample } from "../../src/lab/relevance-model.ts";
import {
  identityCandidateFeatures,
  loadBpid,
  type BpidPair,
  type IdentityCandidateFeatures,
} from "./bpid.ts";

const DATA_PATH = resolve(
  process.env.NMG_BPID_DATA ?? ".benchmarks/bpid/data/data_release/matching_dataset.jsonl",
);
const REPORT_PATH = resolve(
  process.env.NMG_BPID_NEURAL_REPORT ?? "evals/topology/results/bpid-neural-probe-20260929.json",
);
const SPLIT_SEEDS = [19427, 19428, 19429] as const;
const MIN_REJECTION_PRECISION = 0.95;
const MIN_RELEVANT_RETENTION = 0.99;
const EPOCHS = 100;
const LEARNING_RATE = 0.05;
const BATCH_SIZE = 128;
const HIDDEN_UNITS = 8;
const FEATURE_NAMES = ["name", "email", "phone", "address", "dateOfBirth", "ruleScore"] as const;

interface PreparedPair {
  pair: BpidPair;
  features: number[];
  ruleScore: number;
  label: 0 | 1;
}

interface PointMetrics {
  rows: number;
  positives: number;
  negatives: number;
  excluded: number;
  kept: number;
  excludedIrrelevantPrecision: number | null;
  irrelevantRejectionRecall: number;
  relevantRetention: number;
  keptRelevancePrecision: number;
  accuracy: number;
  balancedAccuracy: number;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function profileKey(pair: BpidPair["profile1"]): string {
  return digest(
    JSON.stringify({
      fullname: pair.fullname,
      email: [...pair.email].sort(),
      phone: [...pair.phone].sort(),
      addr: [...pair.addr].sort(),
      dob: pair.dob,
    }),
  );
}

function profilePartition(key: string, seed: number): "train" | "cal" | "test" {
  const bucket = Number.parseInt(digest(`${seed}:${key}`).slice(0, 8), 16) / 0xffffffff;
  if (bucket < 0.55) return "train";
  if (bucket < 0.775) return "cal";
  return "test";
}

function featureVector(features: IdentityCandidateFeatures): number[] {
  return [
    features.name,
    features.email,
    features.phone,
    features.address,
    features.dateOfBirth,
    features.score,
  ];
}

function label(pair: BpidPair): 0 | 1 {
  return pair.match === "True" ? 1 : 0;
}

function splitPairs(
  pairs: readonly BpidPair[],
  seed: number,
): Record<"train" | "cal" | "test", PreparedPair[]> & {
  groupedComponents: number;
  uniqueProfiles: number;
  profileOverlapBetweenSplits: boolean;
} {
  const result = { train: [], cal: [], test: [] } as Record<
    "train" | "cal" | "test",
    PreparedPair[]
  >;
  const profileKeys = new Set<string>();
  const parent = pairs.map((_, index) => index);
  const firstRowByProfile = new Map<string, number>();
  const keysByRow: string[][] = [];

  const find = (index: number): number => {
    if (parent[index] !== index) parent[index] = find(parent[index]!);
    return parent[index]!;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  for (const [index, pair] of pairs.entries()) {
    const leftKey = profileKey(pair.profile1);
    const rightKey = profileKey(pair.profile2);
    profileKeys.add(leftKey);
    profileKeys.add(rightKey);
    keysByRow.push([leftKey, rightKey]);
    for (const key of [leftKey, rightKey]) {
      const previousRow = firstRowByProfile.get(key);
      if (previousRow === undefined) firstRowByProfile.set(key, index);
      else union(index, previousRow);
    }
  }

  const rowsByComponent = new Map<number, number[]>();
  for (let index = 0; index < pairs.length; index += 1) {
    const root = find(index);
    const rows = rowsByComponent.get(root) ?? [];
    rows.push(index);
    rowsByComponent.set(root, rows);
  }

  for (const rows of rowsByComponent.values()) {
    const componentProfiles = [...new Set(rows.flatMap((index) => keysByRow[index]!))].sort();
    const componentId = digest(componentProfiles.join("\n"));
    const splitName = profilePartition(componentId, seed);
    for (const index of rows) {
      const pair = pairs[index]!;
      const features = identityCandidateFeatures(pair.profile1, pair.profile2);
      result[splitName].push({
        pair,
        features: featureVector(features),
        ruleScore: features.score,
        label: label(pair),
      });
    }
  }

  const profileOwners = new Map<string, "train" | "cal" | "test">();
  let profileOverlapBetweenSplits = false;
  for (const splitName of ["train", "cal", "test"] as const) {
    for (const item of result[splitName]) {
      for (const key of [profileKey(item.pair.profile1), profileKey(item.pair.profile2)]) {
        const owner = profileOwners.get(key);
        if (owner && owner !== splitName) profileOverlapBetweenSplits = true;
        profileOwners.set(key, splitName);
      }
    }
  }
  if (profileOverlapBetweenSplits) throw new Error(`seed ${seed} leaked a profile between splits`);

  return {
    ...result,
    groupedComponents: rowsByComponent.size,
    uniqueProfiles: profileKeys.size,
    profileOverlapBetweenSplits,
  };
}

function pointMetrics(
  examples: readonly PreparedPair[],
  scores: readonly number[],
  threshold: number,
): PointMetrics {
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;

  for (let index = 0; index < examples.length; index += 1) {
    const positive = examples[index]!.label === 1;
    const kept = scores[index]! >= threshold;
    if (positive && kept) truePositive += 1;
    else if (positive) falseNegative += 1;
    else if (kept) falsePositive += 1;
    else trueNegative += 1;
  }

  const positives = truePositive + falseNegative;
  const negatives = trueNegative + falsePositive;
  const excluded = trueNegative + falseNegative;
  const kept = truePositive + falsePositive;
  const relevantRetention = positives === 0 ? 0 : truePositive / positives;
  const irrelevantRejectionRecall = negatives === 0 ? 0 : trueNegative / negatives;
  const trueNegativeRate = negatives === 0 ? 0 : trueNegative / negatives;

  return {
    rows: examples.length,
    positives,
    negatives,
    excluded,
    kept,
    excludedIrrelevantPrecision: excluded === 0 ? null : trueNegative / excluded,
    irrelevantRejectionRecall,
    relevantRetention,
    keptRelevancePrecision: kept === 0 ? 0 : truePositive / kept,
    accuracy: examples.length === 0 ? 0 : (truePositive + trueNegative) / examples.length,
    balancedAccuracy: (relevantRetention + trueNegativeRate) / 2,
  };
}

function chooseSafeExclusionThreshold(
  examples: readonly PreparedPair[],
  scores: readonly number[],
): { threshold: number | null; metrics: PointMetrics } {
  if (examples.length === 0) throw new Error("calibration split is empty");
  const thresholds = [...new Set(scores.map((score) => score + 1e-12))].sort((a, b) => a - b);
  let best: { threshold: number; metrics: PointMetrics } | undefined;

  for (const threshold of thresholds) {
    const metrics = pointMetrics(examples, scores, threshold);
    if (
      metrics.excludedIrrelevantPrecision === null ||
      metrics.excludedIrrelevantPrecision < MIN_REJECTION_PRECISION ||
      metrics.relevantRetention < MIN_RELEVANT_RETENTION
    ) {
      continue;
    }
    if (
      !best ||
      metrics.irrelevantRejectionRecall > best.metrics.irrelevantRejectionRecall ||
      (metrics.irrelevantRejectionRecall === best.metrics.irrelevantRejectionRecall &&
        metrics.relevantRetention > best.metrics.relevantRetention)
    ) {
      best = { threshold, metrics };
    }
  }

  if (best) return best;
  const noRejectionThreshold = Number.NEGATIVE_INFINITY;
  return {
    threshold: null,
    metrics: pointMetrics(examples, scores, noRejectionThreshold),
  };
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizeRuns(
  runs: readonly Record<string, unknown>[],
  modelOrRule: "model" | "rule",
): Record<string, { mean: number; values: number[] }> {
  const metricNames = [
    "excludedIrrelevantPrecision",
    "irrelevantRejectionRecall",
    "relevantRetention",
    "keptRelevancePrecision",
    "accuracy",
    "balancedAccuracy",
  ] as const;
  return Object.fromEntries(
    metricNames.map((metricName) => {
      const values = runs
        .map((run) => {
          const branch = run[modelOrRule] as { test: PointMetrics };
          return branch.test[metricName];
        })
        .filter((value): value is number => typeof value === "number");
      return [metricName, { mean: average(values), values }];
    }),
  );
}

const pairs = await loadBpid(DATA_PATH);
const positives = pairs.filter((pair) => label(pair) === 1).length;
const negatives = pairs.length - positives;
const runs: Array<Record<string, unknown>> = [];

for (const seed of SPLIT_SEEDS) {
  const split = splitPairs(pairs, seed);
  const train = split.train;
  const cal = split.cal;
  const test = split.test;
  if ([train, cal, test].some((part) => part.length === 0)) {
    throw new Error(`seed ${seed} produced an empty split`);
  }
  if ([train, cal, test].some((part) => new Set(part.map((item) => item.label)).size < 2)) {
    throw new Error(`seed ${seed} produced a split without both labels`);
  }

  const model = new RelevanceModel({
    featureCount: FEATURE_NAMES.length,
    columns: FEATURE_NAMES.map((_, index) => index),
    hidden: HIDDEN_UNITS,
    blocks: ["core"],
    domain: "synthetic-entity-match",
    labelSource: "bpid-pair-label",
    unit: "item",
  });
  const examples: RelevanceTrainingExample[] = train.map((item) => ({
    features: item.features,
    label: item.label,
  }));
  const startedAt = performance.now();
  const training = model.train(examples, {
    epochs: EPOCHS,
    learningRate: LEARNING_RATE,
    batchSize: BATCH_SIZE,
    loss: "bce",
  });
  const trainingMs = performance.now() - startedAt;
  const calibration = model.fitCalibration(
    cal.map((item) => ({ features: item.features, label: item.label })),
  );

  const ruleCalScores = cal.map((item) => item.ruleScore);
  const ruleTestScores = test.map((item) => item.ruleScore);
  const modelCalScores = cal.map((item) => model.predict(item.features));
  const modelTestScores = test.map((item) => model.predict(item.features));
  const ruleOperatingPoint = chooseSafeExclusionThreshold(cal, ruleCalScores);
  const modelOperatingPoint = chooseSafeExclusionThreshold(cal, modelCalScores);
  const ruleTest = pointMetrics(
    test,
    ruleTestScores,
    ruleOperatingPoint.threshold ?? Number.NEGATIVE_INFINITY,
  );
  const modelTest = pointMetrics(
    test,
    modelTestScores,
    modelOperatingPoint.threshold ?? Number.NEGATIVE_INFINITY,
  );
  const majorityAccuracy =
    Math.max(
      test.filter((item) => item.label === 1).length,
      test.filter((item) => item.label === 0).length,
    ) / test.length;

  runs.push({
    seed,
    split: {
      trainRows: train.length,
      calibrationRows: cal.length,
      testRows: test.length,
      groupedComponents: split.groupedComponents,
      uniqueExactProfiles: split.uniqueProfiles,
      profileOverlapBetweenSplits: split.profileOverlapBetweenSplits,
    },
    majorityAccuracy,
    rule: {
      calibrationThreshold: ruleOperatingPoint.threshold,
      calibration: ruleOperatingPoint.metrics,
      test: ruleTest,
    },
    model: {
      calibrationThreshold: modelOperatingPoint.threshold,
      calibration: modelOperatingPoint.metrics,
      test: modelTest,
      calibrationScale: calibration.scale,
      calibrationShift: calibration.shift,
      trainingMs,
      training,
    },
  });
}

const report = {
  benchmark: "BPID-small-autodiff-classifier-probe",
  protocolVersion: 1,
  source: DATA_PATH,
  datasetDigest: digest(readFileSync(DATA_PATH)),
  rows: pairs.length,
  positives,
  negatives,
  accuracyBaseline: {
    majorityClassAccuracy: Math.max(positives, negatives) / pairs.length,
    positiveRate: positives / pairs.length,
  },
  splitProtocol: {
    assignment:
      "rows sharing any exact profile are grouped; components are assigned to one split without dropping pairs",
    fractions: { train: 0.55, calibration: 0.225, test: 0.225 },
    seeds: SPLIT_SEEDS,
  },
  modelProtocol: {
    type: "local RelevanceModel MLP trained with pointwise binary cross entropy",
    featureNames: FEATURE_NAMES,
    hiddenUnits: HIDDEN_UNITS,
    parameterCount: FEATURE_NAMES.length * HIDDEN_UNITS + HIDDEN_UNITS + HIDDEN_UNITS + 1,
    parameterBytesFloat32:
      (FEATURE_NAMES.length * HIDDEN_UNITS + HIDDEN_UNITS + HIDDEN_UNITS + 1) * 4,
    epochs: EPOCHS,
    learningRate: LEARNING_RATE,
    batchSize: BATCH_SIZE,
    selection: `threshold selected on calibration only to maximize rejection recall while excluded-negative precision >= ${MIN_REJECTION_PRECISION} and positive retention >= ${MIN_RELEVANT_RETENTION}`,
  },
  metricDefinitions: {
    excludedIrrelevantPrecision:
      "among excluded pairs, share labelled different-person (match=False)",
    irrelevantRejectionRecall: "share of all labelled different-person pairs excluded",
    relevantRetention: "share of all labelled same-person pairs retained",
    keptRelevancePrecision: "among retained pairs, share labelled same-person",
    accuracy: "ordinary binary accuracy; included to expose majority-class traps",
  },
  runs,
  meanTestMetrics: {
    rule: summarizeRuns(runs, "rule"),
    model: summarizeRuns(runs, "model"),
  },
  limitations: [
    "Synthetic structured-identity pairs; not multilingual text retrieval or user rejection history.",
    "Exact full-profile repeats stay in one split; semantically equivalent profile variants may still cross splits.",
    "A useful result here is only evidence for this structured pair task, not the memory-search product task.",
  ],
};

if (existsSync(REPORT_PATH)) throw new Error(`Refusing to overwrite report: ${REPORT_PATH}`);
mkdirSync(dirname(REPORT_PATH), { recursive: true });
writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({ output: REPORT_PATH, ...report }, null, 2)}\n`);
