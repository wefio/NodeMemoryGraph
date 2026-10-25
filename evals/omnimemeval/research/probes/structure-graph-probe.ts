/**
 * Vector-index mechanisms applied to the structural layer.
 *
 * The structural index is usually a dictionary: you look a block up by id. The
 * proposal here is to make it searchable instead — blocks carry representative
 * vectors, boundary records are replicated into neighbouring blocks, and blocks
 * are wired into a bounded-degree graph that a greedy walk can navigate.
 *
 * To have anything to measure, the run pools all ten conversations into one
 * store (one user's whole memory) rather than one conversation at a time: at
 * ~60 blocks per conversation every strategy is cheap and the question is moot.
 *
 * Arms, all at the same budget of evaluated blocks:
 *   flat   score every block centroid, keep the best B (the current behaviour)
 *   graph  greedy walk from a medoid over the pruned block graph, B evaluations
 * and the reference: exhaustive record scoring (the recall ceiling).
 *
 * Reported: record-level full coverage / recall of the page, plus the two cost
 * currencies that actually differ — block comparisons and records scored.
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
const OUT = argOf("out", "evals/locomo/results/structure-graph-probe.json");
const LEAF_SIZE = Number(argOf("leaf-size", "16"));
const TAU = Number(argOf("tau", "0.9"));
const DEGREE = Number(argOf("degree", "8"));
const ALPHA = Number(argOf("alpha", "1.2"));
const BUDGETS = argOf("budgets", "8,16,32,64").split(",").map(Number);

function kmeans(vectors: readonly Float32Array[], k: number, iterations = 10) {
  if (vectors.length <= k) return vectors.map((_, index) => index);
  const centers: Float32Array[] = [centroidOf(vectors)];
  while (centers.length < k) {
    let bestIndex = 0;
    let bestDistance = -1;
    vectors.forEach((vector, index) => {
      let nearest = -Infinity;
      for (const center of centers) {
        const score = cosineSimilarity(vector, center);
        if (score > nearest) nearest = score;
      }
      if (1 - nearest > bestDistance) {
        bestDistance = 1 - nearest;
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
  groupId: string;
  normText: string;
  vector: Float32Array;
}

interface Block {
  id: string;
  centroid: Float32Array;
  memberIds: string[];
}

const docs: Doc[] = [];
const goldByQuestion = new Map<string, string[][]>();
const questionVector = new Map<string, Float32Array>();

function load(): void {
  const dataset = JSON.parse(fs.readFileSync(DATA, "utf8")) as Sample[];
  const queries = readVectors(`${BGE}/queries`);
  for (const sample of dataset) ingestSample(sample, queries);
}

/** Read one conversation's records and keep the local id map used for gold
 *  matching, so the gold matches only resolve inside their own conversation. */
function loadRecords(sample: Sample, file: string): Map<string, Doc> {
  const db = new DatabaseSync(`${STORE_DIR}/${file}`, { readOnly: true });
  const rows = db
    .prepare(
      "SELECT id, node_id nodeId, statement FROM memory_records ORDER BY node_id, created_at, rowid",
    )
    .all() as Array<{ id: string; nodeId: string; statement: string }>;
  db.close();
  const vectors = readVectors(`${BGE}/${file.replace(".sqlite", "")}`);
  const local = new Map<string, Doc>();
  for (const row of rows) {
    const vector = vectors.get(row.id);
    if (!vector) throw new Error(`missing vector ${row.id}`);
    const doc: Doc = {
      id: row.id,
      groupId: `${sample.sample_id}:${row.nodeId}`,
      normText: norm(row.statement),
      vector,
    };
    docs.push(doc);
    local.set(row.id, doc);
  }
  return local;
}

function loadTurns(sample: Sample): Map<string, { withSpeaker: string; body: string }> {
  const turns = new Map<string, { withSpeaker: string; body: string }>();
  for (const [key, list] of Object.entries(sample.conversation)) {
    if (!/^session_\d+$/u.test(key) || !Array.isArray(list)) continue;
    for (const turn of list) {
      const id = String(turn.dia_id ?? "");
      if (!id) continue;
      turns.set(id, {
        withSpeaker: norm(`${turn.speaker}: ${turn.text}`).slice(0, 70),
        body: norm(turn.text).slice(0, 60),
      });
    }
  }
  return turns;
}

/** Records whose text carries this turn: the speaker-prefixed form, or the bare
 *  body when it is long enough to identify the turn on its own. */
function goldIdsForTurn(turn: { withSpeaker: string; body: string }, local: Map<string, Doc>) {
  return [...local.values()]
    .filter(
      (doc) =>
        doc.normText.includes(turn.withSpeaker) ||
        (turn.body.length > 25 && doc.normText.includes(turn.body)),
    )
    .map((doc) => doc.id);
}

function ingestQuestions(
  sample: Sample,
  turns: Map<string, { withSpeaker: string; body: string }>,
  local: Map<string, Doc>,
  queries: Map<string, Float32Array>,
): void {
  for (const item of sample.qa ?? []) {
    if (Number(item.category) !== 1) continue;
    const labels = splitLabels((item.evidence ?? []).join(";"));
    if (labels.length === 0) continue;
    const goldSets: string[][] = [];
    for (const label of labels) {
      const turn = turns.get(label);
      if (!turn) continue;
      const ids = goldIdsForTurn(turn, local);
      if (ids.length > 0) goldSets.push(ids);
    }
    if (goldSets.length === 0) continue;
    const key = `${sample.sample_id}\u0000${String(item.question ?? "")}`;
    const vector = queries.get(key);
    if (!vector) continue;
    goldByQuestion.set(key, goldSets);
    questionVector.set(key, vector);
  }
}

function ingestSample(sample: Sample, queries: Map<string, Float32Array>): void {
  const file = STORES[sample.sample_id];
  if (!file) return;
  const local = loadRecords(sample, file);
  ingestQuestions(sample, loadTurns(sample), local, queries);
}

function buildBlocks(): Block[] {
  const byGroup = new Map<string, Doc[]>();
  for (const doc of docs) {
    const list = byGroup.get(doc.groupId) ?? [];
    list.push(doc);
    byGroup.set(doc.groupId, list);
  }
  const blocks: Block[] = [];
  for (const [groupId, members] of byGroup) {
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
    for (const [cluster, list] of clusters)
      blocks.push({
        id: `${groupId}#${cluster}`,
        centroid: centroidOf(list.map((member) => member.vector)),
        memberIds: list.map((member) => member.id),
      });
  }
  // Boundary replication: a record also joins a second block whose centroid is
  // within tau, so a boundary record cannot become unreachable through a
  // misassignment.
  const extra = new Map<number, string[]>();
  blocks.forEach((block, blockIndex) => {
    for (const id of block.memberIds) {
      const doc = docs.find((candidate) => candidate.id === id)!;
      let ownScore = -Infinity;
      let secondIndex = -1;
      let secondScore = -Infinity;
      blocks.forEach((candidate, candidateIndex) => {
        const score = cosineSimilarity(doc.vector, candidate.centroid);
        if (candidateIndex === blockIndex) {
          ownScore = score;
          return;
        }
        if (score > secondScore) {
          secondScore = score;
          secondIndex = candidateIndex;
        }
      });
      if (secondIndex >= 0 && secondScore >= TAU * ownScore) {
        const list = extra.get(secondIndex) ?? [];
        list.push(id);
        extra.set(secondIndex, list);
      }
    }
  });
  for (const [blockIndex, ids] of extra) blocks[blockIndex]!.memberIds.push(...ids);
  return blocks;
}

/** Bounded-degree navigable graph over block centroids.
 *
 * Top-R neighbours keep the walk cheap; the symmetrisation plus a medoid hub
 * keeps the graph connected, which the earlier robust-prune attempt lost (mean
 * out-degree collapsed to 1.8 and the walk stalled after two hops). */
function buildGraph(blocks: readonly Block[], degree: number) {
  const neighbours: number[][] = blocks.map(() => []);
  blocks.forEach((block, index) => {
    const scored = blocks
      .map((other, otherIndex) => ({
        index: otherIndex,
        score: otherIndex === index ? -Infinity : cosineSimilarity(block.centroid, other.centroid),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, degree);
    neighbours[index] = scored.map((entry) => entry.index);
  });
  blocks.forEach((_, index) => {
    for (const target of neighbours[index]!) {
      if (!neighbours[target]!.includes(index)) neighbours[target]!.push(index);
    }
  });
  return neighbours.map((list) => [...new Set(list)]);
}

function main() {
  load();
  const blocks = buildBlocks();
  const neighbours = buildGraph(blocks, DEGREE);
  const blockOfRecord = new Map<string, number>();
  blocks.forEach((block, index) => {
    for (const id of block.memberIds) if (!blockOfRecord.has(id)) blockOfRecord.set(id, index);
  });
  const recordScore = (query: Float32Array, id: string) => {
    const doc = docsById.get(id);
    if (!doc) throw new Error(`unknown record ${id}`);
    return cosineSimilarity(query, doc.vector);
  };
  const docsById = new Map(docs.map((doc) => [doc.id, doc]));

  const medoid = blocks.reduce(
    (best, block, index) => {
      const sum = block.centroid.reduce((total, value) => total + value, 0);
      return sum > best.sum ? { index, sum } : best;
    },
    { index: 0, sum: -Infinity },
  ).index;

  const arms = new Map<
    string,
    { full: number; hits: number; total: number; blocks: number; records: number; n: number }
  >();
  const bump = (
    key: string,
    full: boolean,
    hits: number,
    total: number,
    blockCount: number,
    recordCount: number,
  ) => {
    const arm = arms.get(key) ?? { full: 0, hits: 0, total: 0, blocks: 0, records: 0, n: 0 };
    arm.n += 1;
    arm.full += full ? 1 : 0;
    arm.hits += hits;
    arm.total += total;
    arm.blocks += blockCount;
    arm.records += recordCount;
    arms.set(key, arm);
  };

  for (const [key, goldSets] of goldByQuestion) {
    const query = questionVector.get(key)!;
    // reference: exhaustive over the whole pooled store
    const exhaustive = docs
      .map((doc) => ({ id: doc.id, score: cosineSimilarity(query, doc.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((entry) => entry.id);

    const blockScores = blocks.map((block) => cosineSimilarity(query, block.centroid));
    const pageOf = (candidateIds: string[]) => {
      const set = new Set(candidateIds);
      return [...set]
        .map((id) => ({ id, score: recordScore(query, id) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map((entry) => entry.id);
    };
    const evaluate = (
      key2: string,
      page: readonly string[],
      blockCount: number,
      recordCount: number,
    ) => {
      const pageSet = new Set(page);
      let hits = 0;
      let all = true;
      for (const ids of goldSets) {
        const found = ids.some((id) => pageSet.has(id));
        if (found) hits += 1;
        else all = false;
      }
      bump(key2, all, hits, goldSets.length, blockCount, recordCount);
    };

    evaluate("exhaustive", exhaustive, 0, docs.length);

    for (const budget of BUDGETS) {
      // flat: score every block centroid (that is the cost), keep the best B
      const order = blockScores
        .map((score, index) => ({ index, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, budget);
      const flatRecords: string[] = [];
      for (const entry of order) flatRecords.push(...blocks[entry.index]!.memberIds);
      evaluate(`flat B=${budget}`, pageOf(flatRecords), blocks.length, flatRecords.length);

      // graph: best-first expansion from the medoid; the budget counts blocks
      // whose centroid was scored, which is the currency flat pays in full.
      const scored = new Set<number>([medoid]);
      const frontier = new Set<number>(neighbours[medoid]!);
      const picked: number[] = [medoid];
      while (picked.length < budget && frontier.size > 0) {
        let next = -1;
        let nextScore = -Infinity;
        for (const candidate of frontier) {
          const score = blockScores[candidate]!;
          if (score > nextScore) {
            nextScore = score;
            next = candidate;
          }
        }
        if (next < 0) break;
        frontier.delete(next);
        scored.add(next);
        picked.push(next);
        for (const neighbour of neighbours[next]!)
          if (!scored.has(neighbour)) frontier.add(neighbour);
      }
      const graphRecords: string[] = [];
      for (const index of picked) graphRecords.push(...blocks[index]!.memberIds);
      evaluate(
        `graph B=${budget}`,
        pageOf(graphRecords),
        picked.length * (DEGREE + 2),
        graphRecords.length,
      );
    }
  }

  const n = goldByQuestion.size;
  console.log(
    `池化: ${docs.length} 条记录 / ${blocks.length} 个叶块  题=${n}  平均出度=${(neighbours.reduce((sum, list) => sum + list.length, 0) / blocks.length).toFixed(1)}`,
  );
  console.log(
    "arm".padEnd(16) +
      "全覆%".padStart(8) +
      "recall%".padStart(9) +
      "块比较".padStart(9) +
      "记录打分".padStart(10),
  );
  for (const [key, arm] of arms)
    console.log(
      key.padEnd(16) +
        ((100 * arm.full) / arm.n).toFixed(1).padStart(8) +
        ((100 * arm.hits) / arm.total).toFixed(1).padStart(9) +
        (arm.blocks / arm.n).toFixed(0).padStart(9) +
        (arm.records / arm.n).toFixed(0).padStart(10),
    );

  fs.writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        records: docs.length,
        blocks: blocks.length,
        questions: n,
        degree: DEGREE,
        alpha: ALPHA,
        arms: [...arms].map(([name, arm]) => ({
          name,
          fullPct: +((100 * arm.full) / arm.n).toFixed(1),
          recallPct: +((100 * arm.hits) / arm.total).toFixed(1),
          blockComparisons: Math.round(arm.blocks / arm.n),
          recordsScored: Math.round(arm.records / arm.n),
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`wrote ${OUT}`);
}

main();
