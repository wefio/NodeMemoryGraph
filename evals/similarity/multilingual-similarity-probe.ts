import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { downloadFile } from "@huggingface/hub";
import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";

import { statementSimilarity } from "../../src/core/store/search-ranking.ts";
import { RelevanceModel, type RelevanceTrainingPair } from "../../src/lab/relevance-model.ts";
import { mapConcurrent } from "../../tools/parts/async.ts";
import { writeJsonAtomic } from "../../tools/parts/fs.ts";
import { characterNgramCosine, pairFeatures } from "./pair-features.ts";

const DATASET = "SemRel/SemRel2024";
const DATASET_REVISION = "ef5c383d1b87eb8feccde3dfb7f95e42b1b050dd";
const LANGUAGES = [
  "afr",
  "amh",
  "arb",
  "arq",
  "ary",
  "eng",
  "esp",
  "hau",
  "hin",
  "ind",
  "kin",
  "mar",
  "pan",
  "tel",
] as const;
const DEFAULT_TRAIN = ["eng", "esp", "hau", "mar", "tel"];
const DEFAULT_HELD_OUT = ["afr", "arb", "hin", "ind", "pan"];
const FEATURE_COUNT = 17;

interface SimilarityRow {
  language: string;
  sentence1: string;
  sentence2: string;
  label: number;
  features: number[];
}

interface ScoredRow {
  gold: number;
  existingWordJaccard: number;
  characterNgramCosine: number;
  programComposite: number;
  neuralMlp: number;
}

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    "model-out": { type: "string" },
    "train-languages": { type: "string", default: DEFAULT_TRAIN.join(",") },
    "held-out-languages": { type: "string", default: DEFAULT_HELD_OUT.join(",") },
    epochs: { type: "string", default: "40" },
    "max-pairs": { type: "string", default: "2500" },
    "max-rows-per-split": { type: "string", default: "300" },
    seed: { type: "string", default: "19427" },
  },
  strict: true,
});

if (!values.out)
  throw new Error(
    "usage: --out <report.json> [--model-out <weights.json>] [--train-languages amh,eng,...]",
  );
const trainLanguages = parseLanguages(values["train-languages"]!, "train languages");
const heldOutLanguages = parseLanguages(values["held-out-languages"]!, "held-out languages");
if (trainLanguages.some((language) => heldOutLanguages.includes(language))) {
  throw new Error("training and held-out languages must be disjoint");
}
const epochs = positiveInteger(values.epochs!, "epochs");
const maxPairs = positiveInteger(values["max-pairs"]!, "max-pairs");
const maxRowsPerSplit = positiveInteger(values["max-rows-per-split"]!, "max-rows-per-split");
const seed = positiveInteger(values.seed!, "seed");

const revision = DATASET_REVISION;

const trainPages = await mapConcurrent(trainLanguages, 1, (language) =>
  fetchSplit(language, "train", revision, maxRowsPerSplit),
);
const validationPages = await mapConcurrent(trainLanguages, 1, (language) =>
  fetchSplit(language, "dev", revision, maxRowsPerSplit),
);
const testLanguages = [...new Set([...trainLanguages, ...heldOutLanguages])];
const testPages = await mapConcurrent(testLanguages, 1, (language) =>
  fetchSplit(language, "test", revision, maxRowsPerSplit),
);
const trainRows = trainPages.flatMap((page) => page.rows);
if (trainRows.length === 0) throw new Error("SemRel train split is empty");

for (const row of trainRows) row.features = pairFeatures(row.sentence1, row.sentence2);
const trainingPairs = sampleRankPairs(trainRows, maxPairs, seed);
if (trainingPairs.length < 100) {
  throw new Error(`only ${trainingPairs.length} usable training comparisons; require at least 100`);
}

const model = new RelevanceModel({ featureCount: FEATURE_COUNT, hidden: 8 });
const startedAt = performance.now();
const training = model.trainPairs(trainingPairs, {
  epochs,
  learningRate: 0.05,
  batchSize: 128,
});
const trainingMs = Math.round(performance.now() - startedAt);
if (values["model-out"]) writeJsonAtomic(resolve(values["model-out"]), model.toJSON());

const validationScores = validationPages.map((page) => scoreRows(page.rows, model));
const hybridNeuralWeight = chooseHybridWeight(validationScores);

const digest = createHash("sha256");
for (const page of [...trainPages, ...validationPages, ...testPages]) {
  for (const row of page.rows) {
    digest.update(`${row.language}\0${row.sentence1}\0${row.sentence2}\0${row.label}\n`);
  }
}

const perLanguage = testPages.map((page) => {
  const scores = scoreRows(page.rows, model);
  const hybrid = scores.map(
    (row) => (1 - hybridNeuralWeight) * row.programComposite + hybridNeuralWeight * row.neuralMlp,
  );
  return {
    language: page.language,
    role: heldOutLanguages.includes(page.language) ? "zero-shot-language" : "seen-language",
    rows: scores.length,
    hiddenLabelRows: page.rows.length - scores.length,
    spearman: {
      existingWordJaccard: correlation(
        scores.map((row) => row.existingWordJaccard),
        scores.map((row) => row.gold),
      ),
      characterNgramCosine: correlation(
        scores.map((row) => row.characterNgramCosine),
        scores.map((row) => row.gold),
      ),
      programComposite: correlation(
        scores.map((row) => row.programComposite),
        scores.map((row) => row.gold),
      ),
      neuralMlp: correlation(
        scores.map((row) => row.neuralMlp),
        scores.map((row) => row.gold),
      ),
      hybrid: correlation(
        hybrid,
        scores.map((row) => row.gold),
      ),
    },
  };
});

const report = {
  measuredAt: new Date().toISOString(),
  dataset: DATASET,
  datasetRevision: revision,
  datasetFingerprint: digest.digest("hex"),
  license:
    "Not specified in the upstream dataset card; this probe emits metrics only and does not redistribute rows or weights.",
  protocol: {
    localMemoryDatasetUsed: false,
    dataAccess:
      "Pinned SemRel Parquet files downloaded with @huggingface/hub and decoded locally with hyparquet; no datasets-server rows endpoint",
    trainingSplit: "sampled official train rows from training languages only",
    validationSplit:
      "sampled official dev rows from training languages only; used only to select one global hybrid weight",
    heldOutLanguages,
    evaluationSplit:
      "sampled official test rows; Spanish hidden-label rows are counted and excluded",
    programBaselines: [
      "existing word-set Jaccard from src/core/store/search-ranking.ts",
      "mean cosine over Unicode character 1-4-gram count vectors",
      "equal mean of the two program scores",
    ],
    hybrid: {
      formula: "(1 - neuralWeight) * programComposite + neuralWeight * neuralMlp",
      neuralWeight: hybridNeuralWeight,
      selection:
        "grid search in 0.1 increments, maximizing macro Spearman on official dev splits from training languages",
    },
    neural:
      "CPU MLP from src/lab/relevance-model.ts, trained with RankNet on pair-feature comparisons; no embedding model",
    neuralFeatures: FEATURE_COUNT,
    hiddenUnits: 8,
    parameterCount: FEATURE_COUNT * 8 + 8 + 8 + 1,
    parameterBytesFloat32: (FEATURE_COUNT * 8 + 8 + 8 + 1) * 4,
    epochs,
    trainingComparisons: training.examples,
    trainingMs,
    finalLoss: training.loss,
    trainLanguages,
    trainRows: trainRows.length,
    validationRows: validationPages.reduce(
      (sum, page) => sum + page.rows.filter((row) => row.label >= 0).length,
      0,
    ),
    sampledRowsBySplit: Object.fromEntries(
      [...trainPages, ...validationPages, ...testPages].map((page) => [
        `${page.language}/${page.split}`,
        { sampled: page.rows.length, total: page.total },
      ]),
    ),
    testRows: perLanguage.reduce((sum, row) => sum + row.rows, 0),
  },
  macroSpearman: Object.fromEntries(
    ["existingWordJaccard", "characterNgramCosine", "programComposite", "neuralMlp", "hybrid"].map(
      (name) => {
        const scores = perLanguage
          .map((row) => row.spearman[name as keyof typeof row.spearman])
          .filter((score): score is number => score !== null);
        if (scores.length === 0) throw new Error(`no usable ${name} language scores`);
        return [name, { languages: scores.length, value: mean(scores) }];
      },
    ),
  ),
  perLanguage,
};

if (!Number.isFinite(report.protocol.finalLoss) || report.protocol.testRows === 0) {
  throw new Error("probe result failed its finite-loss/non-empty-test self-check");
}
for (const row of perLanguage) {
  if (
    row.rows > 0 &&
    !Object.values(row.spearman).every((score) => score === null || Number.isFinite(score))
  ) {
    throw new Error(`non-finite metric for ${row.language}`);
  }
}

writeJsonAtomic(resolve(values.out), report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function fetchSplit(
  language: string,
  split: "train" | "dev" | "test",
  datasetRevision: string,
  rowLimit: number,
) {
  const path = `${language}/${split}-00000-of-00001.parquet`;
  const file = await downloadFile({
    repo: { type: "dataset", name: DATASET },
    path,
    revision: datasetRevision,
  });
  if (!file) throw new Error(`SemRel file does not exist: ${path} at ${datasetRevision}`);
  const parquetRows = await parquetReadObjects({ file: await file.arrayBuffer(), compressors });
  const allRows = parquetRows.map((row, index) => ({
    language,
    sentence1: requireText(row.sentence1, `${language}/${split}[${index}].sentence1`),
    sentence2: requireText(row.sentence2, `${language}/${split}[${index}].sentence2`),
    label: requireLabel(row.label, `${language}/${split}[${index}].label`),
    features: [],
  }));
  if (allRows.length === 0)
    throw new Error(`${language}/${split}: downloaded Parquet split has no rows`);
  const rows = sampleRows(allRows, rowLimit);
  return { language, split, total: allRows.length, rows };
}

function sampleRows<T>(rows: readonly T[], limit: number): T[] {
  const count = Math.min(rows.length, limit);
  if (count === rows.length) return [...rows];
  if (count === 1) return [rows[0]!];
  return Array.from(
    { length: count },
    (_value, index) => rows[Math.round((index * (rows.length - 1)) / (count - 1))]!,
  );
}

function parseLanguages(value: string, label: string): string[] {
  const languages = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (languages.length === 0 || new Set(languages).size !== languages.length) {
    throw new Error(
      `${label} must be a non-empty comma-separated language list without duplicates`,
    );
  }
  const unknown = languages.filter(
    (language) => !(LANGUAGES as readonly string[]).includes(language),
  );
  if (unknown.length > 0)
    throw new Error(`${label} contains unsupported language(s): ${unknown.join(",")}`);
  return languages;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} is empty`);
  return value;
}

function requireLabel(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < -1 || value > 1) {
    throw new Error(`${name} must be finite and in [-1,1]`);
  }
  return value;
}

function scoreRows(rows: SimilarityRow[], model: RelevanceModel): ScoredRow[] {
  return rows
    .filter((row) => row.label >= 0)
    .map((row) => {
      const existingWordJaccard = statementSimilarity(row.sentence1, row.sentence2);
      const characterScore = characterNgramCosine(row.sentence1, row.sentence2);
      return {
        gold: row.label,
        existingWordJaccard,
        characterNgramCosine: characterScore,
        programComposite: (existingWordJaccard + characterScore) / 2,
        neuralMlp: model.predict(pairFeatures(row.sentence1, row.sentence2)),
      };
    });
}

function chooseHybridWeight(validationPages: ScoredRow[][]): number {
  let bestWeight = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let step = 0; step <= 10; step += 1) {
    const neuralWeight = step / 10;
    const languageScores = validationPages
      .map((rows) =>
        correlation(
          rows.map(
            (row) => (1 - neuralWeight) * row.programComposite + neuralWeight * row.neuralMlp,
          ),
          rows.map((row) => row.gold),
        ),
      )
      .filter((score): score is number => score !== null);
    if (languageScores.length === 0)
      throw new Error("validation splits contain no usable labeled rows");
    const macroScore = mean(languageScores);
    if (macroScore > bestScore) {
      bestScore = macroScore;
      bestWeight = neuralWeight;
    }
  }
  return bestWeight;
}

function sampleRankPairs(
  rows: SimilarityRow[],
  limit: number,
  initialSeed: number,
): RelevanceTrainingPair[] {
  const high = rows.filter((row) => row.label >= 0.75);
  const low = rows.filter((row) => row.label <= 0.25);
  if (high.length === 0 || low.length === 0) {
    throw new Error(
      `need high/low labels for RankNet; found high=${high.length}, low=${low.length}`,
    );
  }
  let state = initialSeed >>> 0;
  const next = (bound: number) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return Math.floor((state / 0x1_0000_0000) * bound);
  };
  const count = Math.min(limit, Math.max(high.length, low.length) * 4);
  return Array.from({ length: count }, () => ({
    positiveFeatures: high[next(high.length)]!.features,
    negativeFeatures: low[next(low.length)]!.features,
  }));
}

function ranks(values: readonly number[]): number[] {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array<number>(values.length);
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end]!.value === sorted[start]!.value) end += 1;
    const averageRank = (start + 1 + end) / 2;
    for (let index = start; index < end; index += 1) result[sorted[index]!.index] = averageRank;
    start = end;
  }
  return result;
}

function correlation(left: readonly number[], right: readonly number[]): number | null {
  if (left.length !== right.length || left.length < 2) return null;
  const a = ranks(left);
  const b = ranks(right);
  const meanA = mean(a);
  const meanB = mean(b);
  let numerator = 0;
  let sumA = 0;
  let sumB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const centeredA = a[index]! - meanA;
    const centeredB = b[index]! - meanB;
    numerator += centeredA * centeredB;
    sumA += centeredA * centeredA;
    sumB += centeredB * centeredB;
  }
  return sumA === 0 || sumB === 0 ? null : numerator / Math.sqrt(sumA * sumB);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("mean requires at least one value");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
