import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readQrels } from "../../tools/relevance-model-train.ts";
import {
  validateTrainingData,
  validateTrainingSplit,
  judgedExamples,
  retentionMetrics,
  type TrainingData,
} from "../../tools/relevance-training-data.ts";
import { RELEVANCE_FEATURE_NAMES } from "../../src/core/relevance-features.ts";

function data(corpus: string, unit: string): TrainingData {
  return {
    version: 1,
    corpusId: corpus,
    corpusDigest: corpus.repeat(64).slice(0, 64),
    labelSource: "qrels",
    labelEvidence: "fixture explicit relevance judgments",
    sourceSplit: "train",
    featureNames: [...RELEVANCE_FEATURE_NAMES],
    retrieval: { protocol: "nmg-relevance-v1", embedder: "none" },
    groups: [
      {
        queryId: unit,
        sourceUnitId: unit,
        query: `query ${unit}`,
        candidateIds: ["a", "b", "c"],
        features: [1, 2, 3].map(() => Array(RELEVANCE_FEATURE_NAMES.length).fill(0)),
        labels: [1, 0, -1],
        raw: [3, 2, 1],
      },
    ],
  };
}

test("training rejects legacy anonymous caches and malformed labels", () => {
  assert.throws(() => validateTrainingData([]), /versioned/);
  const input = data("a", "one");
  input.groups[0]!.labels[0] = 2;
  assert.throws(() => validateTrainingData(input), /label/);
});

test("unknown candidates are excluded from training, not relabeled negative", () => {
  const groups = validateTrainingData(data("a", "one")).groups;
  assert.deepEqual(
    judgedExamples(groups).map((item) => item.label),
    [1, 0],
  );
});

test("split rejects shared source units, normalized duplicate queries and renamed test corpora", () => {
  const train = data("a", "one"),
    cal = data("a", "two"),
    held = data("b", "three");
  assert.doesNotThrow(() => validateTrainingSplit({ train: [train], cal: [cal], test: [held] }));
  cal.groups[0]!.sourceUnitId = "one";
  assert.throws(
    () => validateTrainingSplit({ train: [train], cal: [cal], test: [held] }),
    /source unit/,
  );
  cal.groups[0]!.sourceUnitId = "two";
  held.groups[0]!.query = "  QUERY   one  ";
  assert.throws(() => validateTrainingSplit({ train: [train], cal: [cal], test: [held] }), /query/);
  held.groups[0]!.query = "different";
  held.corpusDigest = train.corpusDigest;
  assert.throws(
    () => validateTrainingSplit({ train: [train], cal: [cal], test: [held] }),
    /test corpus/,
  );
});

function workspace(t: TestContext): string {
  const root = resolve(".benchmarks/test-runs");
  mkdirSync(root, { recursive: true });
  const path = mkdtempSync(resolve(root, "relevance-data-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

const trainer = fileURLToPath(new URL("../../tools/relevance-model-train.ts", import.meta.url));
function run(args: string[]): string {
  return execFileSync(process.execPath, ["--experimental-strip-types", trainer, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("qrels parser keeps explicit negatives, rejects malformed scores", (t) => {
  const path = resolve(workspace(t), "qrels.tsv");
  writeFileSync(path, "query-id\tcorpus-id\tscore\nq\ta\t1\nq\tb\t0\n");
  assert.deepEqual(
    [...readQrels(path).get("q")!],
    [
      ["a", 1],
      ["b", 0],
    ],
  );
  writeFileSync(path, "query-id\tcorpus-id\tscore\nq\ta\tNaN\n");
  assert.throws(() => readQrels(path), /invalid qrel/);
});

test("trainer runs offline with independent sources and persists provenance", (t) => {
  const dir = workspace(t);
  for (const [role, source] of [
    ["train", data("a", "one")],
    ["cal", data("a", "two")],
    ["test", data("b", "three")],
  ] as const) {
    writeFileSync(resolve(dir, `${role}.json`), JSON.stringify(source));
  }
  const manifest = resolve(dir, "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify({ version: 1, train: ["train.json"], cal: ["cal.json"], test: ["test.json"] }),
  );
  const out = resolve(dir, "candidate.json");
  const report = JSON.parse(run(["--manifest", manifest, "--epochs", "2", "--out", out, "--json"]));
  assert.equal(report.provenance.evaluation, "cross-corpus");
  assert.equal(report.provenance.sources.length, 3);
  assert.equal(report.trainExamples, 2);
  assert.equal(report.operatingPoint.minimumRetention, 1);
  assert.equal(report.operatingPoint.test.unknown, 1);
  assert.equal(report.deploymentEligible, false);
  const artifact = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(artifact.trainingProvenance, report.provenance);
  assert.deepEqual(JSON.parse(readFileSync(`${out}.report.json`, "utf8")), report);
  // Test-label changes affect evaluation, never training or the calibrated threshold.
  const changedTest = data("b", "three");
  changedTest.groups[0]!.labels = [0, 1, -1];
  writeFileSync(resolve(dir, "test.json"), JSON.stringify(changedTest));
  const second = JSON.parse(run(["--manifest", manifest, "--epochs", "2", "--out", out, "--json"]));
  const secondArtifact = JSON.parse(readFileSync(out, "utf8"));
  delete artifact.trainingProvenance;
  delete secondArtifact.trainingProvenance;
  assert.deepEqual(secondArtifact, artifact);
  assert.equal(second.operatingPoint.floor, report.operatingPoint.floor);
});

test("qrels preparation uses the named split and preserves unjudged candidates", (t) => {
  const dir = workspace(t);
  mkdirSync(resolve(dir, "qrels"));
  writeFileSync(
    resolve(dir, "corpus.jsonl"),
    [
      { _id: "a", text: "Orchid watering requires draining the pot after soaking." },
      { _id: "b", text: "Orchid exhibition tickets cost twenty dollars on weekends." },
      { _id: "c", text: "Orchid species grow in diverse tropical forest habitats." },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  writeFileSync(
    resolve(dir, "queries.jsonl"),
    [
      { _id: "q", text: "orchid" },
      { _id: "empty", text: "zzzxxyyunknownterm" },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  writeFileSync(
    resolve(dir, "qrels/train.tsv"),
    "query-id\tcorpus-id\tscore\nq\ta\t1\nq\tb\t0\nempty\ta\t1\n",
  );
  const cache = resolve(dir, "prepared.json");
  run([
    "--prepare-only",
    "--qrels",
    dir,
    "--qrels-split",
    "train",
    "--cache",
    cache,
    "--store-root",
    resolve(dir, "stores"),
  ]);
  const prepared = validateTrainingData(JSON.parse(readFileSync(cache, "utf8")));
  assert.equal(prepared.sourceSplit, "train");
  assert.equal(prepared.retrieval.embedder, "none");
  assert.equal(prepared.groups.length, 2);
  const group = prepared.groups.find((entry) => entry.queryId === "q")!;
  const labels = Object.fromEntries(
    group.candidateIds.map((id, index) => [id, group.labels[index]]),
  );
  assert.equal(labels.a, 1);
  assert.equal(labels.b, 0);
  assert.equal(labels.c, -1);
});

test("split rejects feature drift and official test data used for fitting", () => {
  const train = data("a", "one"),
    cal = data("a", "two"),
    held = data("b", "three");
  train.sourceSplit = "test";
  assert.throws(
    () => validateTrainingSplit({ train: [train], cal: [cal], test: [held] }),
    /test partition/,
  );
  train.sourceSplit = "train";
  held.retrieval.embedder = "other";
  assert.throws(
    () => validateTrainingSplit({ train: [train], cal: [cal], test: [held] }),
    /retrieval protocol/,
  );
});

test("retention reports positive loss and unknown coverage separately from noise", () => {
  const groups = data("a", "one").groups;
  groups.push({
    ...groups[0]!,
    queryId: "empty",
    sourceUnitId: "empty",
    query: "empty",
    features: [],
    labels: [],
    raw: [],
    candidateIds: [],
  });
  const result = retentionMetrics(groups, (group) =>
    group.labels.map((_, i) => i).filter((i) => i > 0),
  );
  assert.equal(result.positiveRetention, 0);
  assert.equal(result.hitRetention, 0);
  assert.equal(result.unknownKept, 1);
  assert.equal(result.knownNoiseRemoved, 0);
  assert.equal(result.poolHitRate, 0.5);
  assert.equal(result.allPositiveRetention, 0);
});
