/**
 * SPANN-shaped routing, measured as what it can actually be: an index.
 *
 * Exhaustive scoring over a conversation's records is the recall ceiling, so a
 * cluster router cannot raise coverage — it can only approach the ceiling with
 * fewer distance computations. This probe measures exactly that trade:
 *
 *   regions = the stored session nodes (the semantic regions already in the store)
 *   leaves  = k-means clusters inside a region, target 16 records each
 *   route   = score region centroids → keep R; score leaf centroids → keep L;
 *             score the records of those leaves and keep the page
 *   boundary= a record joins its second-nearest leaf too when the two centroids
 *             are close (cosine ≥ tau), which is how SPANN stops a misassigned
 *             record from becoming unreachable
 *
 * Reported per configuration: full coverage (the exhaustive page as reference),
 * evidence recall, and the number of vectors compared — the currency that makes
 * a routing result meaningful at all.
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { cosineSimilarity } from "../../../../src/core/vector.ts";
import { centroidOf, norm, readVectors } from "./structure-shared.ts";

interface Turn {
  dia_id?: string;
  speaker?: string;
  text?: string;
}
interface Question {
  category?: number | string;
  question?: string;
  evidence?: string[];
}
interface Sample {
  sample_id: string;
  conversation: Record<string, Turn[] | undefined>;
  qa?: Question[];
}

const splitLabels = (value: unknown) =>
  String(value ?? "")
    .split(/[;,]\s*/u)
    .map((x) => x.trim())
    .filter((x) => /^D\d+:\d+$/u.test(x));

const STORES: Record<string, string> = {
  "conv-26": "0d7abe8198f2196bca477fed.sqlite",
  "conv-30": "473a734e4bd5ee879871549b.sqlite",
  "conv-41": "0d57eb5a0d03aadea54ac095.sqlite",
  "conv-42": "21153a2aed6f416b9b564690.sqlite",
  "conv-43": "40929626de08d686a5bd96d5.sqlite",
  "conv-44": "33a9865dc4020729db29f6f8.sqlite",
  "conv-47": "378996f95f0013e562c50830.sqlite",
  "conv-48": "34969029549adf4436e21263.sqlite",
  "conv-49": "0091975cdb0bc7554b6d22c1.sqlite",
  "conv-50": "7b62923acb915892a180156d.sqlite",
};

const argOf = (name: string, fallback?: string) => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
};

const DATA = argOf("data", process.env.NMG_LOCOMO_DATA);
const STORE_DIR = argOf("stores", process.env.NMG_STRUCTURE_STORES);
const BGE = argOf("bge", process.env.NMG_STRUCTURE_BGE);
const OUT = argOf("out", "evals/locomo/results/structure-routing-probe.json");
const TAU = Number(argOf("tau", "0.9"));
const LEAF_SIZE = Number(argOf("leaf-size", "16"));

/** Deterministic k-means: seed with the point farthest from the running set. */
function kmeans(vectors: readonly Float32Array[], k: number, iterations = 12) {
  if (vectors.length <= k) return vectors.map((_, index) => index);
  const centers: Float32Array[] = [centroidOf(vectors)];
  while (centers.length < k) {
    let bestIndex = 0;
    let bestDistance = -1;
    vectors.forEach((vector, index) => {
      const nearest = Math.max(...centers.map((center) => cosineSimilarity(vector, center)));
      const distance = 1 - nearest;
      if (distance > bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    centers.push(vectors[bestIndex]!);
  }
  const assignment = new Array<number>(vectors.length).fill(0);
  for (let round = 0; round < iterations; round += 1) {
    vectors.forEach((vector, index) => {
      let best = 0;
      let bestScore = -Infinity;
      centers.forEach((center, centerIndex) => {
        const score = cosineSimilarity(vector, center);
        if (score > bestScore) {
          bestScore = score;
          best = centerIndex;
        }
      });
      assignment[index] = best;
    });
    for (let centerIndex = 0; centerIndex < centers.length; centerIndex += 1) {
      const members = vectors.filter((_, index) => assignment[index] === centerIndex);
      if (members.length > 0) centers[centerIndex] = centroidOf(members);
    }
  }
  return assignment;
}

interface Doc {
  id: string;
  nodeId: string;
  normText: string;
  vector: Float32Array;
}

interface Leaf {
  id: string;
  regionId: string;
  centroid: Float32Array;
  memberIds: string[];
}

function buildLeaves(docs: readonly Doc[], tau: number) {
  const byRegion = new Map<string, Doc[]>();
  for (const doc of docs) {
    const list = byRegion.get(doc.nodeId) ?? [];
    list.push(doc);
    byRegion.set(doc.nodeId, list);
  }
  const leaves: Leaf[] = [];
  for (const [regionId, members] of byRegion) {
    const k = Math.max(1, Math.ceil(members.length / LEAF_SIZE));
    const assignment = kmeans(
      members.map((member) => member.vector),
      k,
    );
    const clusters = new Map<number, Doc[]>();
    members.forEach((member, index) => {
      const cluster = assignment[index]!;
      const list = clusters.get(cluster) ?? [];
      list.push(member);
      clusters.set(cluster, list);
    });
    for (const [cluster, list] of clusters) {
      leaves.push({
        id: `${regionId}#${cluster}`,
        regionId,
        centroid: centroidOf(list.map((member) => member.vector)),
        memberIds: list.map((member) => member.id),
      });
    }
  }
  // Boundary replication: a record also joins a second leaf whose centroid is
  // within tau of its own, so a misplaced boundary record stays reachable.
  const byLeaf = new Map(leaves.map((leaf) => [leaf.memberIds, leaf]));
  for (const leaf of leaves) {
    for (const id of [...leaf.memberIds]) {
      const doc = docs.find((candidate) => candidate.id === id)!;
      const scores = leaves
        .map((candidate) => ({
          leaf: candidate,
          score: cosineSimilarity(doc.vector, candidate.centroid),
        }))
        .sort((a, b) => b.score - a.score);
      const own = scores.find((entry) => entry.leaf.id === leaf.id)!;
      const second = scores.find((entry) => entry.leaf.id !== leaf.id);
      if (second && second.score >= tau * own.score) second.leaf.memberIds.push(id);
    }
  }
  void byLeaf;
  return leaves;
}

/** Score every routing configuration for one question and fold the outcome into
 *  the tallies. Kept out of `main` so each routing variant is one branch in a
 *  testable helper instead of a branch inside the driver loop. */
type SampleContext = {
  docs: Doc[];
  leavesWithBoundary: Leaf[];
  leavesNoBoundary: Leaf[];
  regionCentroids: Map<string, Float32Array>;
  turnText: Map<string, { withSpeaker: string; body: string }>;
};

function loadDocs(file: string): Doc[] {
  const db = new DatabaseSync(`${STORE_DIR}/${file}`, { readOnly: true });
  const raw = db
    .prepare(
      "SELECT id, node_id nodeId, statement FROM memory_records ORDER BY node_id, created_at, rowid",
    )
    .all() as Array<{ id: string; nodeId: string; statement: string }>;
  db.close();
  const vectors = readVectors(`${BGE}/${file.replace(".sqlite", "")}`);
  return raw.map((row) => {
    const vector = vectors.get(row.id);
    if (!vector) throw new Error(`missing vector ${row.id}`);
    return { id: row.id, nodeId: row.nodeId, normText: norm(row.statement), vector };
  });
}

function loadTurnText(sample: Sample): Map<string, { withSpeaker: string; body: string }> {
  const turnText = new Map<string, { withSpeaker: string; body: string }>();
  for (const [key, turns] of Object.entries(sample.conversation)) {
    if (!/^session_\d+$/u.test(key) || !Array.isArray(turns)) continue;
    for (const turn of turns) {
      const id = String(turn.dia_id ?? "");
      if (!id) continue;
      turnText.set(id, {
        withSpeaker: norm(`${turn.speaker}: ${turn.text}`).slice(0, 70),
        body: norm(turn.text).slice(0, 60),
      });
    }
  }
  return turnText;
}

function goldByLabelFor(
  labels: string[],
  turnText: Map<string, { withSpeaker: string; body: string }>,
  docs: Doc[],
): Map<string, string[]> {
  const goldByLabel = new Map<string, string[]>();
  for (const label of labels) {
    const turn = turnText.get(label);
    if (!turn) continue;
    const ids = docs
      .filter(
        (doc) =>
          doc.normText.includes(turn.withSpeaker) ||
          (turn.body.length > 25 && doc.normText.includes(turn.body)),
      )
      .map((doc) => doc.id);
    if (ids.length > 0) goldByLabel.set(label, ids);
  }
  return goldByLabel;
}

function prepareSample(sample: Sample, file: string): SampleContext {
  const docs = loadDocs(file);
  const regionCentroids = new Map<string, Float32Array>();
  for (const [regionId, members] of Map.groupBy(docs, (doc) => doc.nodeId))
    regionCentroids.set(regionId, centroidOf(members.map((member) => member.vector)));
  return {
    docs,
    leavesWithBoundary: buildLeaves(docs, TAU),
    leavesNoBoundary: buildLeaves(docs, 2), // tau > 1 disables replication
    regionCentroids,
    turnText: loadTurnText(sample),
  };
}

/** One question: resolve its gold labels and query vector, then score every
 *  routing configuration against them. */
function runQuestion(
  sample: Sample,
  item: NonNullable<Sample["qa"]>[number],
  context: SampleContext,
  queryVectors: Map<string, Float32Array>,
  configs: ReadonlyArray<{ name: string; regions: number; leaves: number; boundary: boolean }>,
  tallies: Map<string, { n: number; full: number; hits: number; total: number; compared: number }>,
  rows: Array<{ id: string; sample: string; gold: number; at: Record<string, boolean> }>,
): void {
  if (Number(item.category) !== 1) return;
  const labels = splitLabels((item.evidence ?? []).join(";"));
  if (labels.length === 0) return;
  const goldByLabel = goldByLabelFor(labels, context.turnText, context.docs);
  if (goldByLabel.size === 0) return;
  const question = String(item.question ?? "");
  const queryVector = queryVectors.get(`${sample.sample_id}\u0000${question}`);
  if (!queryVector) return;
  runConfigs(
    sample,
    question,
    context.docs,
    context.leavesWithBoundary,
    context.leavesNoBoundary,
    context.regionCentroids,
    queryVector,
    goldByLabel,
    configs,
    tallies,
    rows,
  );
}

function report(
  rows: Array<{ id: string; sample: string; gold: number; at: Record<string, boolean> }>,
  tallies: Map<string, { n: number; full: number; hits: number; total: number; compared: number }>,
  configs: ReadonlyArray<{ name: string }>,
): void {
  console.log(`多跳题: ${rows.length}  tau=${TAU}  leaf 目标=${LEAF_SIZE}`);
  console.log(
    "config".padEnd(20) + "全覆%".padStart(8) + "recall%".padStart(9) + "平均比较向量".padStart(13),
  );
  const summary = configs.map((config) => {
    const tally = tallies.get(config.name)!;
    console.log(
      config.name.padEnd(20) +
        ((100 * tally.full) / tally.n).toFixed(1).padStart(8) +
        ((100 * tally.hits) / tally.total).toFixed(1).padStart(9) +
        (tally.compared / tally.n).toFixed(0).padStart(13),
    );
    return {
      name: config.name,
      fullPct: +((100 * tally.full) / tally.n).toFixed(1),
      recallPct: +((100 * tally.hits) / tally.total).toFixed(1),
      vectorsCompared: Math.round(tally.compared / tally.n),
    };
  });
  fs.writeFileSync(
    OUT,
    `${JSON.stringify(
      { questions: rows.length, tau: TAU, leafSize: LEAF_SIZE, configs: summary },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`wrote ${OUT}`);
}

/** Score every routing configuration for one question and fold the outcome into
 *  the tallies. Kept out of `main` so each routing variant is one branch in a
 *  testable helper instead of a branch inside the driver loop. */
function runConfigs(
  sample: Sample,
  question: string,
  docs: Doc[],
  leavesWithBoundary: Leaf[],
  leavesNoBoundary: Leaf[],
  regionCentroids: Map<string, Float32Array>,
  queryVector: Float32Array,
  goldByLabel: Map<string, string[]>,
  configs: ReadonlyArray<{
    name: string;
    regions: number;
    leaves: number;
    boundary: boolean;
  }>,
  tallies: Map<string, { n: number; full: number; hits: number; total: number; compared: number }>,
  rows: Array<{ id: string; sample: string; gold: number; at: Record<string, boolean> }>,
): void {
  const recordScores = new Map(
    docs.map((doc) => [doc.id, cosineSimilarity(queryVector, doc.vector)]),
  );
  const key = `${sample.sample_id}\u0000${question}`;
  for (const config of configs) {
    const leaves = config.boundary ? leavesWithBoundary : leavesNoBoundary;
    const { candidates, compared } = routingCandidates(
      config,
      docs,
      leaves,
      regionCentroids,
      queryVector,
    );
    const page = candidates
      .map((id) => ({ id, score: recordScores.get(id) ?? -1 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((entry) => entry.id);
    const pageSet = new Set(page);
    let hits = 0;
    let total = 0;
    let all = true;
    for (const ids of goldByLabel.values()) {
      const found = ids.some((id) => pageSet.has(id));
      if (found) hits += 1;
      total += 1;
      if (!found) all = false;
    }
    const tally = tallies.get(config.name) ?? { n: 0, full: 0, hits: 0, total: 0, compared: 0 };
    tally.n += 1;
    tally.full += all ? 1 : 0;
    tally.hits += hits;
    tally.total += total;
    tally.compared += compared;
    tallies.set(config.name, tally);
    const row = rows.find((entry) => entry.id === key);
    const target = row ?? { id: key, sample: sample.sample_id, gold: 0, at: {} };
    target.gold = goldByLabel.size;
    target.at[config.name] = all;
    if (!row) rows.push(target);
  }
}

/** Candidates one routing configuration compares, and the vector-comparison cost
 *  of producing them. */
function routingCandidates(
  config: { regions: number; leaves: number },
  docs: Doc[],
  leaves: Leaf[],
  regionCentroids: Map<string, Float32Array>,
  queryVector: Float32Array,
): { candidates: string[]; compared: number } {
  if (!Number.isFinite(config.regions)) {
    return { candidates: docs.map((doc) => doc.id), compared: docs.length };
  }
  const regionScored = [...regionCentroids]
    .map(([id, centroid]) => ({ id, score: cosineSimilarity(queryVector, centroid) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, config.regions);
  const chosenRegions = new Set(regionScored.map((entry) => entry.id));
  const inChosenRegions = leaves.filter((leaf) => chosenRegions.has(leaf.regionId));
  const leafScored = inChosenRegions
    .map((leaf) => ({ leaf, score: cosineSimilarity(queryVector, leaf.centroid) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, config.leaves);
  const ids = new Set<string>();
  for (const entry of leafScored) for (const id of entry.leaf.memberIds) ids.add(id);
  // The records inside the selected leaves are scored too; leaving them out was
  // understating the routed cost by an order of magnitude.
  return {
    candidates: [...ids],
    compared: regionCentroids.size + inChosenRegions.length + ids.size,
  };
}

function main(): void {
  const configs = [
    { name: "exhaustive", regions: Infinity, leaves: Infinity, boundary: false },
    { name: "R=all L=all +边界", regions: Infinity, leaves: Infinity, boundary: true },
    { name: "R=8 L=12", regions: 8, leaves: 12, boundary: false },
    { name: "R=8 L=12 +边界", regions: 8, leaves: 12, boundary: true },
    { name: "R=4 L=6", regions: 4, leaves: 6, boundary: false },
    { name: "R=4 L=6 +边界", regions: 4, leaves: 6, boundary: true },
  ];
  const dataset = JSON.parse(fs.readFileSync(DATA, "utf8")) as Sample[];
  const queryVectors = readVectors(`${BGE}/queries`);
  const tallies = new Map<
    string,
    { n: number; full: number; hits: number; total: number; compared: number }
  >();
  const rows: Array<{ id: string; sample: string; gold: number; at: Record<string, boolean> }> = [];
  for (const sample of dataset) {
    const file = STORES[sample.sample_id];
    if (!file) continue;
    const context = prepareSample(sample, file);
    for (const item of sample.qa ?? [])
      runQuestion(sample, item, context, queryVectors, configs, tallies, rows);
  }
  report(rows, tallies, configs);
}

main();
