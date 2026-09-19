import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { DATASET_NAMES, loadDataset, type DatasetName } from "../evals/retrieval/datasets.ts";
import { normalizeText } from "../evals/retrieval/score.ts";
import { queryScoreStats } from "../src/core/relevance-gate.ts";
import { NmgStore } from "../src/core/store.ts";
import { searchMemoryContext } from "../src/integration/search.ts";

/**
 * Offline calibration / regression for the program-side relevance gate.
 *
 * Runs the deterministic retrieval path against an already-ingested benchmark
 * store (no embedding service) and reports how a flat-list abstain level on the
 * RAW-scale coefficient of variation (`queryScoreStats` cv) trades kept
 * precision against hit recall. This is the gold-labelled, reproducible dataset
 * the live recall corpus is too small to be.
 *
 * Usage:
 *   node --experimental-strip-types tools/relevance-gate-calibration.ts \
 *     [--dataset locomo] [--store-root .benchmarks/retrieval-stores] \
 *     [--cv-cut 0.027] [--cv-cut 0.109] [--json]
 *
 * The store must already exist (ingest via `npm run eval:retrieval`); a missing
 * store is refused rather than silently yielding zero questions.
 */

const DATASET_NAMES_SET = new Set<string>(DATASET_NAMES);
const DEFAULT_CUTS = [0, 0.027, 0.06, 0.109, 0.189];

interface Options {
  dataset: DatasetName;
  storeRoot: string;
  cuts: number[];
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dataset: "locomo",
    storeRoot: ".benchmarks/retrieval-stores",
    cuts: [...DEFAULT_CUTS],
    json: false,
  };
  const cuts: number[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dataset") {
      const value = argv[++index] ?? "";
      if (!DATASET_NAMES_SET.has(value)) throw new Error(`unknown dataset: ${value}`);
      options.dataset = value as DatasetName;
    } else if (argument === "--store-root") {
      options.storeRoot = argv[++index] ?? options.storeRoot;
    } else if (argument === "--cv-cut") {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value < 0) throw new Error("--cv-cut must be a number >= 0");
      cuts.push(value);
    } else if (argument === "--json") {
      options.json = true;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  if (cuts.length > 0) options.cuts = [...new Set(cuts)].sort((a, b) => a - b);
  return options;
}

interface Sample {
  hit: boolean;
  cv: number;
  top1: number;
}

const userKey = (userId: string) => createHash("sha256").update(userId).digest("hex").slice(0, 24);

async function collect(options: Options): Promise<Sample[]> {
  const spec = loadDataset(options.dataset, {});
  const root = resolve(options.storeRoot, options.dataset);
  if (!existsSync(root)) {
    throw new Error(`no ingested store at ${root}; run \`npm run eval:retrieval -- --dataset ${options.dataset}\``);
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
  const samples: Sample[] = [];
  for (const question of spec.questions) {
    const store = getStore(question.userId);
    if (!store) continue;
    const context = await searchMemoryContext(store, undefined, question.query, {
      limit: 20,
      maxTier: 3,
      graphHops: 1,
      tieredDisclosure: true,
      progressiveWarmDisclosure: false,
      expandChains: true,
    });
    const candidates = context.results.map((result) => ({
      scores: result,
      text: normalizeText(
        [result.memory.statement, ...(result.evidenceRecords ?? []).map((e) => e.content)].join(" "),
      ),
    }));
    if (candidates.length === 0) continue;
    const golds = question.golds.map(normalizeText).filter((gold) => gold.length > 0);
    const hit = candidates.some((candidate) =>
      golds.some((gold) =>
        spec.direction === "gold-in-candidate"
          ? candidate.text.includes(gold)
          : gold.includes(candidate.text),
      ),
    );
    const stats = queryScoreStats(candidates.map((candidate) => candidate.scores), undefined, "raw");
    samples.push({ hit, cv: stats.cv, top1: stats.top1 });
  }
  for (const store of stores.values()) store.close();
  return samples;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const samples = await collect(options);
  if (samples.length === 0) throw new Error("no scored questions — store is empty or unscoped");
  const hits = samples.filter((sample) => sample.hit).length;
  const baseline = hits / samples.length;
  const rows = options.cuts.map((cut) => {
    const kept = samples.filter((sample) => sample.cv >= cut);
    const keptHits = kept.filter((sample) => sample.hit).length;
    return {
      cut,
      abstained: samples.length - kept.length,
      droppedMiss: samples.length - kept.length - (hits - keptHits),
      droppedHit: hits - keptHits,
      keptPrecision: kept.length === 0 ? 0 : keptHits / kept.length,
      hitRecallKept: hits === 0 ? 0 : keptHits / hits,
    };
  });
  const report = {
    dataset: options.dataset,
    questions: samples.length,
    hits,
    baselineHitRate: baseline,
    rows,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `${options.dataset}: ${samples.length} questions, ${hits} with gold (baseline hit rate ${baseline.toFixed(3)})\n` +
      `abstain when raw-scale cv < cut:\n` +
      `  ${"cut".padEnd(8)}${"abstained".padEnd(11)}${"dropMiss".padEnd(10)}${"dropHit".padEnd(9)}${"keptPrec".padEnd(10)}hitRecallKept\n`,
  );
  for (const row of rows) {
    process.stdout.write(
      `  ${row.cut.toFixed(3).padEnd(8)}${String(row.abstained).padEnd(11)}${String(row.droppedMiss).padEnd(10)}${String(row.droppedHit).padEnd(9)}${row.keptPrecision.toFixed(3).padEnd(10)}${row.hitRecallKept.toFixed(3)}\n`,
    );
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
