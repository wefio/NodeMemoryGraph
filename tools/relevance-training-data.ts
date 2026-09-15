import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { RELEVANCE_FEATURE_NAMES } from "../src/core/relevance-features.ts";

export interface TrainingGroup {
  queryId: string;
  /** Shared by every task/variant derived from one source conversation. */
  sourceUnitId: string;
  query: string;
  candidateIds: string[];
  features: number[][];
  /** -1 is unjudged; it is never a training negative. */
  labels: number[];
  raw: number[];
}

export interface TrainingData {
  version: 1;
  corpusId: string;
  corpusDigest: string;
  labelSource: "qrels" | "verified-evidence";
  labelEvidence: string;
  sourceSplit: string;
  featureNames: string[];
  retrieval: { protocol: string; embedder: string };
  groups: TrainingGroup[];
}

export const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

function requiredText(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`missing ${name}`);
}

function validateGroup(group: TrainingGroup): void {
  requiredText(group.queryId, "queryId");
  requiredText(group.sourceUnitId, "sourceUnitId");
  requiredText(group.query, "query");
  if (![group.features, group.labels, group.raw, group.candidateIds].every(Array.isArray))
    throw new Error("missing candidate arrays");
  const size = group.features.length;
  if ([group.labels, group.raw, group.candidateIds].some((array) => array.length !== size))
    throw new Error("candidate arrays have different lengths");
  if (!group.labels.every((label) => [-1, 0, 1].includes(label)))
    throw new Error("invalid label; expected -1, 0 or 1");
  if (
    !group.raw.every(Number.isFinite) ||
    group.features.some(
      (row) =>
        !Array.isArray(row) ||
        row.length !== RELEVANCE_FEATURE_NAMES.length ||
        !row.every(Number.isFinite),
    )
  )
    throw new Error("invalid feature values");
  for (const id of group.candidateIds) requiredText(id, "candidateId");
  if (new Set(group.candidateIds).size !== size) throw new Error("duplicate candidateId");
}

export function validateTrainingData(value: unknown): TrainingData {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as TrainingData).version !== 1
  ) {
    throw new Error(
      "expected versioned relevance dataset; rebuild legacy anonymous caches with --prepare-only",
    );
  }
  const data = value as TrainingData;
  for (const key of ["corpusId", "corpusDigest", "labelEvidence", "sourceSplit"] as const)
    requiredText(data[key], key);
  if (!/^[a-f0-9]{64}$/.test(data.corpusDigest)) throw new Error("invalid corpusDigest");
  if (!["qrels", "verified-evidence"].includes(data.labelSource))
    throw new Error("labels require qrels or verified-evidence provenance");
  if (JSON.stringify(data.featureNames) !== JSON.stringify(RELEVANCE_FEATURE_NAMES))
    throw new Error("feature protocol mismatch; rebuild dataset");
  requiredText(data.retrieval?.protocol, "retrieval protocol");
  requiredText(data.retrieval?.embedder, "embedder");
  if (!Array.isArray(data.groups) || data.groups.length === 0)
    throw new Error("dataset has no query groups");
  const ids = new Set<string>();
  for (const group of data.groups) {
    validateGroup(group);
    if (ids.has(group.queryId)) throw new Error(`duplicate queryId ${group.queryId}`);
    ids.add(group.queryId);
  }
  return data;
}

export interface TrainingSplit {
  train: TrainingData[];
  cal: TrainingData[];
  test: TrainingData[];
}

function validateCorpusRole(data: TrainingData, role: string, developmentCorpora: Set<string>) {
  if (
    role !== "test" &&
    /^(locomo|longmemeval|beam|personamem(?:-v2)?|halumem)$/i.test(data.corpusId)
  )
    throw new Error("memory benchmark corpora are evaluation-only");
  if (role !== "test" && /^(test|held[-_]?out)$/i.test(data.sourceSplit))
    throw new Error("official test partition cannot be used for fitting or calibration");
  if (
    role === "test" &&
    (developmentCorpora.has(data.corpusId) || developmentCorpora.has(data.corpusDigest))
  )
    throw new Error("test corpus overlaps training/calibration; use an independent corpus");
  if (role !== "test") {
    developmentCorpora.add(data.corpusId);
    developmentCorpora.add(data.corpusDigest);
  }
}

function recordGroupRoles(
  data: TrainingData,
  role: string,
  units: Map<string, string>,
  queries: Map<string, string>,
) {
  for (const group of data.groups) {
    for (const corpus of [data.corpusId, data.corpusDigest]) {
      const key = `${corpus}:${group.sourceUnitId}`;
      const prior = units.get(key);
      if (prior && prior !== role)
        throw new Error(`source unit ${group.sourceUnitId} overlaps ${prior}/${role}`);
      units.set(key, role);
    }
    const query = group.query.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
    const prior = queries.get(query);
    if (prior && prior !== role) throw new Error(`duplicate query crosses ${prior}/${role}`);
    queries.set(query, role);
  }
}

/** Explicit roles replace index-based random splits. Test corpora cannot train/calibrate. */
export function validateTrainingSplit(split: TrainingSplit): void {
  const units = new Map<string, string>();
  const queries = new Map<string, string>();
  const developmentCorpora = new Set<string>();
  let protocol: string | undefined;
  for (const role of ["train", "cal", "test"] as const) {
    if (!Array.isArray(split[role]) || split[role].length === 0)
      throw new Error(`empty ${role} partition`);
    for (const source of split[role]) {
      const data = validateTrainingData(source);
      validateCorpusRole(data, role, developmentCorpora);
      const identity = JSON.stringify([
        data.retrieval.protocol,
        data.retrieval.embedder,
        data.featureNames,
      ]);
      if (protocol !== undefined && protocol !== identity)
        throw new Error("retrieval protocol differs across partitions");
      protocol = identity;
      recordGroupRoles(data, role, units, queries);
    }
  }
}

export function loadTrainingManifest(path: string) {
  const raw = readFileSync(path, "utf8");
  const manifest = JSON.parse(raw) as {
    version: number;
    train: string[];
    cal: string[];
    test: string[];
  };
  if (manifest.version !== 1) throw new Error("training manifest version must be 1");
  const split: TrainingSplit = { train: [], cal: [], test: [] };
  const sources: Array<{
    role: string;
    path: string;
    sha256: string;
    corpusId: string;
    sourceSplit: string;
    labelSource: string;
    labelEvidence: string;
    groups: number;
  }> = [];
  const seenFiles = new Set<string>();
  for (const role of ["train", "cal", "test"] as const) {
    if (!Array.isArray(manifest[role])) throw new Error(`manifest requires ${role} file list`);
    for (const file of manifest[role]) {
      requiredText(file, "dataset path");
      const resolved = resolve(dirname(path), file);
      const contents = readFileSync(resolved, "utf8");
      const sha256 = digest(contents);
      if (seenFiles.has(sha256)) throw new Error("duplicate dataset in manifest");
      seenFiles.add(sha256);
      const data = validateTrainingData(JSON.parse(contents));
      split[role].push(data);
      sources.push({
        role,
        path: resolved,
        sha256,
        corpusId: data.corpusId,
        sourceSplit: data.sourceSplit,
        labelSource: data.labelSource,
        labelEvidence: data.labelEvidence,
        groups: data.groups.length,
      });
    }
  }
  validateTrainingSplit(split);
  const evaluationUnits = [...split.cal, ...split.test].flatMap((data) =>
    data.groups.map((group) => `${data.corpusDigest}:${group.sourceUnitId}`),
  );
  return {
    train: split.train.flatMap((data) => data.groups),
    cal: split.cal.flatMap((data) => data.groups),
    test: split.test.flatMap((data) => data.groups),
    testDatasets: split.test,
    independentEvaluationUnits: new Set(evaluationUnits).size === evaluationUnits.length,
    provenance: {
      manifestSha256: digest(raw),
      evaluation: "cross-corpus" as const,
      sources,
      retrieval: split.train[0]!.retrieval,
    },
  };
}

export function judgedExamples(groups: readonly { features: number[][]; labels: number[] }[]) {
  return groups.flatMap((group) =>
    group.features.flatMap((features, index) => {
      const label = group.labels[index];
      return label === 0 || label === 1 ? [{ features, label: label as 0 | 1 }] : [];
    }),
  );
}

/** Retention is relative to known positives in the retrieved pool, not corpus recall or sufficiency. */
export function retentionMetrics<T extends { labels: number[] }>(
  groups: readonly T[],
  select: (group: T) => number[],
) {
  let positives = 0,
    keptPositives = 0,
    hitGroups = 0,
    keptHitGroups = 0,
    completeGroups = 0;
  let total = 0,
    kept = 0,
    knownNoise = 0,
    keptNoise = 0,
    unknown = 0,
    unknownKept = 0;
  for (const group of groups) {
    const selected = new Set(select(group));
    const positive = group.labels.filter((label) => label === 1).length;
    const retained = group.labels.filter(
      (label, index) => label === 1 && selected.has(index),
    ).length;
    positives += positive;
    keptPositives += retained;
    if (positive > 0) {
      hitGroups += 1;
      if (retained > 0) keptHitGroups += 1;
      if (retained === positive) completeGroups += 1;
    }
    total += group.labels.length;
    kept += selected.size;
    group.labels.forEach((label, index) => {
      if (label === 0) {
        knownNoise += 1;
        if (selected.has(index)) keptNoise += 1;
      }
      if (label === -1) {
        unknown += 1;
        if (selected.has(index)) unknownKept += 1;
      }
    });
  }
  const ratio = (n: number, d: number) => (d === 0 ? null : n / d);
  return {
    queries: groups.length,
    candidates: total,
    kept,
    positives,
    keptPositives,
    unknown,
    unknownKept,
    judgmentCoverage: ratio(total - unknown, total),
    candidateReduction: ratio(total - kept, total),
    knownNoiseRemoved: ratio(knownNoise - keptNoise, knownNoise),
    positiveRetention: ratio(keptPositives, positives),
    hitRetention: ratio(keptHitGroups, hitGroups),
    allPositiveRetention: ratio(completeGroups, hitGroups),
    poolHitRate: ratio(hitGroups, groups.length),
    judgedPrecision: ratio(keptPositives, keptPositives + keptNoise),
  };
}
