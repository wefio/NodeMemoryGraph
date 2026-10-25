/**
 * Does structure help *select* records, now that it does not help *find* them?
 *
 * The headroom probe showed that on LoCoMo the twenty-record page already reaches
 * every gold session for 98.9% of multi-hop questions under BGE-small, so a
 * node/leaf/edge channel as a candidate *entry* has almost no blind spot left to
 * fix. What remains is that 40-45% of questions are only partially covered at
 * top-20: the gold turns sit across 2.7 sessions and the page takes some of them.
 *
 * This probe keeps the candidate generation identical and moves structure to the
 * selection signal, comparing five arms on the same 100 candidates:
 *
 *   A  page = RRF(BM25, BGE) top-20                  (the current behaviour)
 *   B  page = RRF + λ · block centroid cosine        (structure ranks the page)
 *   C  page = RRF + λ · session centroid cosine
 *   D  page = A top-20, supplement = 5 by B outside the page
 *   E  page = A top-20, supplement = 5 by A outside the page   (control for D)
 *
 * Coverage is measured at record granularity: a label counts as retrieved when a
 * record carrying that turn is inside the arm's page (for D/E: page ∪ supplement,
 * which is what a reader sees).
 *
 * λ is fixed at 0.25 before running, mirroring the propagation weight in the
 * earlier reconstructed prototype; the sensitivity line is labelled exploratory.
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { cosineSimilarity } from "../../../../src/core/vector.ts";
import { pairedComparison, splitEvidenceLabels } from "../audits/locomo-audit-shared.ts";

interface LocomoTurn {
  dia_id?: string;
  speaker?: string;
  text?: string;
}

interface LocomoQuestion {
  category?: number | string;
  question?: string;
  evidence?: string[];
}

interface LocomoSample {
  sample_id: string;
  conversation: Record<string, LocomoTurn[] | undefined>;
  qa?: LocomoQuestion[];
}

interface Args {
  data: string;
  stores: string;
  bge: string;
  out: string;
  lambda: number;
  pageSize: number;
  supplement: number;
}

const norm = (value: unknown) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
const tokenize = (value: string) => norm(value).match(/[a-z0-9']+/gu) ?? [];

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

function parseArgs(argv: readonly string[]): Args {
  const read = (name: string, fallback?: string) => {
    const index = argv.indexOf(`--${name}`);
    const value = index >= 0 ? argv[index + 1] : fallback;
    if (value === undefined) throw new Error(`missing --${name}`);
    return value;
  };
  return {
    data: read("data", process.env.NMG_LOCOMO_DATA),
    stores: read("stores", process.env.NMG_STRUCTURE_STORES),
    bge: read("bge", process.env.NMG_STRUCTURE_BGE),
    out: read("out", "evals/locomo/results/structure-selection-probe.json"),
    lambda: Number(read("lambda", "0.25")),
    pageSize: Number(read("page", "20")),
    supplement: Number(read("supplement", "5")),
  };
}

function readVectors(stem: string): Map<string, Float32Array> {
  const ids = JSON.parse(fs.readFileSync(`${stem}.ids.json`, "utf8")) as string[];
  const buffer = fs.readFileSync(`${stem}.vecs.f32`);
  const flat = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  const dims = ids.length === 0 ? 0 : flat.length / ids.length;
  const map = new Map<string, Float32Array>();
  ids.forEach((id, i) => map.set(id, flat.subarray(i * dims, (i + 1) * dims)));
  return map;
}

interface Doc {
  id: string;
  nodeId: string;
  blockId: string;
  normText: string;
  vector: Float32Array;
  tf: Map<string, number>;
  len: number;
}

function loadStore(file: string, args: Args): Doc[] {
  const db = new DatabaseSync(`${args.stores}/${file}`, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT id, node_id nodeId, statement FROM memory_records
        ORDER BY node_id, created_at, rowid`,
    )
    .all() as Array<{ id: string; nodeId: string; statement: string }>;
  db.close();
  const vectors = readVectors(`${args.bge}/${file.replace(".sqlite", "")}`);
  if (vectors.size !== rows.length)
    throw new Error(`${file}: ${vectors.size} vectors for ${rows.length} records`);
  const perNode = new Map<string, number>();
  return rows.map((row) => {
    const index = perNode.get(row.nodeId) ?? 0;
    perNode.set(row.nodeId, index + 1);
    const tokens = tokenize(row.statement);
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    const vector = vectors.get(row.id);
    if (!vector) throw new Error(`missing vector for ${row.id}`);
    return {
      id: row.id,
      nodeId: row.nodeId,
      blockId: `${row.nodeId}#${Math.floor(index / 16)}`,
      normText: norm(row.statement),
      vector,
      tf,
      len: tokens.length,
    };
  });
}

function bm25Scorer(docs: readonly Doc[]) {
  const df = new Map<string, number>();
  for (const doc of docs)
    for (const token of doc.tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  const average = docs.reduce((sum, doc) => sum + doc.len, 0) / Math.max(1, docs.length);
  return (doc: Doc, query: readonly string[]) => {
    let score = 0;
    for (const token of query) {
      const frequency = doc.tf.get(token);
      if (!frequency) continue;
      const seen = df.get(token) ?? 0;
      const idf = Math.log(1 + (docs.length - seen + 0.5) / (seen + 0.5));
      score += idf * ((frequency * 2.2) / (frequency + 1.2 * (0.25 + (0.75 * doc.len) / average)));
    }
    return score;
  };
}

function centroid(vectors: readonly Float32Array[]): Float32Array {
  const dims = vectors[0]?.length ?? 0;
  const sum = new Float32Array(dims);
  for (const vector of vectors) for (let i = 0; i < dims; i += 1) sum[i]! += vector[i]!;
  let norm = 0;
  for (let i = 0; i < dims; i += 1) norm += sum[i]! * sum[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i += 1) sum[i] = sum[i]! / norm;
  return sum;
}

function rrfScores(
  lists: readonly (readonly string[])[],
  weights: readonly number[] = lists.map(() => 1),
  k = 60,
): Map<string, number> {
  const scores = new Map<string, number>();
  lists.forEach((list, listIndex) => {
    const weight = weights[listIndex] ?? 1;
    list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + weight / (k + index + 1)));
  });
  return scores;
}

function normalise(scores: Map<string, number>): Map<string, number> {
  const values = [...scores.values()];
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;
  return new Map([...scores].map(([id, value]) => [id, (value - low) / span]));
}

function take(scores: Map<string, number>, size: number, exclude?: ReadonlySet<string>): string[] {
  return [...scores]
    .filter(([id]) => !exclude?.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, size)
    .map(([id]) => id);
}

function signTestP(wins: number, losses: number): number | null {
  const n = wins + losses;
  if (n === 0) return null;
  const choose = (k: number) => {
    let value = 1;
    for (let i = 1; i <= k; i += 1) value = (value * (n - k + i)) / i;
    return value;
  };
  let tail = 0;
  for (let k = 0; k <= Math.min(wins, losses); k += 1) tail += choose(k);
  return Math.min(1, (2 * tail) / 2 ** n);
}

function positionsFor(
  labelRecords: Map<string, readonly string[]>,
  page: readonly string[],
): number[] {
  const index = new Map(page.map((id, rank) => [id, rank]));
  return [...labelRecords].map(([, records]) => {
    let best = -1;
    for (const id of records) {
      const rank = index.get(id);
      if (rank !== undefined && (best === -1 || rank < best)) best = rank;
    }
    return best;
  });
}

type SamplePrep = {
  docs: Doc[];
  scorer: ReturnType<typeof bm25Scorer>;
  blockVectors: Map<string, Float32Array>;
  nodeVectors: Map<string, Float32Array>;
  turnText: Map<string, { withSpeaker: string; body: string }>;
};

/** Load one conversation and derive the structure centroids the arms blend with. */
function prepareSample(sample: LocomoSample, args: Args): SamplePrep {
  const docs = loadStore(STORES[sample.sample_id as string]!, args);
  const blockMembers = new Map<string, Float32Array[]>();
  const nodeMembers = new Map<string, Float32Array[]>();
  for (const doc of docs) {
    const block = blockMembers.get(doc.blockId) ?? [];
    block.push(doc.vector);
    blockMembers.set(doc.blockId, block);
    const node = nodeMembers.get(doc.nodeId) ?? [];
    node.push(doc.vector);
    nodeMembers.set(doc.nodeId, node);
  }
  const blockVectors = new Map<string, Float32Array>();
  const nodeVectors = new Map<string, Float32Array>();
  for (const [id, vectors] of blockMembers) blockVectors.set(id, centroid(vectors));
  for (const [id, vectors] of nodeMembers) nodeVectors.set(id, centroid(vectors));
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
  return { docs, scorer: bm25Scorer(docs), blockVectors, nodeVectors, turnText };
}

function labelRecordsFor(
  labels: string[],
  turnText: Map<string, { withSpeaker: string; body: string }>,
  docs: Doc[],
): Map<string, string[]> {
  const labelRecords = new Map<string, string[]>();
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
    if (ids.length > 0) labelRecords.set(label, ids);
  }
  return labelRecords;
}

/** Every arm of the ladder for one question. The branch count stays here rather
 *  than in the driver loop, so the driver reads as answer-and-record. */
function buildArms(
  prep: SamplePrep,
  queryVector: Float32Array,
  tokens: string[],
  args: Args,
): Record<string, readonly string[]> {
  const { docs, scorer, blockVectors, nodeVectors } = prep;
  const lexical = docs
    .map((doc) => ({ id: doc.id, score: scorer(doc, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 100)
    .map((entry) => entry.id);
  const vectorList = docs
    .map((doc) => ({ id: doc.id, score: cosineSimilarity(queryVector, doc.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 100)
    .map((entry) => entry.id);
  const vectorScores = new Map<string, number>();
  for (const doc of docs) vectorScores.set(doc.id, cosineSimilarity(queryVector, doc.vector));
  const fused = rrfScores([vectorList, lexical], [0.5, 0.5]);
  // Vector quality dominates lexical on this corpus, so equal weights are a
  // strawman; these two arms ask whether a weighted lexical signal still adds
  // anything over the vector channel alone.
  const fused73 = rrfScores([vectorList, lexical], [0.7, 0.3]);
  const fused91 = rrfScores([vectorList, lexical], [0.9, 0.1]);
  const fusedNormalised = normalise(fused);
  const blockActivation = new Map<string, number>();
  for (const doc of docs) {
    const center = blockVectors.get(doc.blockId);
    if (center) blockActivation.set(doc.id, cosineSimilarity(queryVector, center));
  }
  const nodeActivation = new Map<string, number>();
  for (const doc of docs) {
    const center = nodeVectors.get(doc.nodeId);
    if (center) nodeActivation.set(doc.id, cosineSimilarity(queryVector, center));
  }
  const blend = (activation: Map<string, number>, weight: number) =>
    new Map(
      [...fusedNormalised].map(([id, value]) => [id, value + weight * (activation.get(id) ?? 0)]),
    );
  const pageA = take(fused, args.pageSize);
  const pageV = vectorList.slice(0, args.pageSize);
  const pageL = lexical.slice(0, args.pageSize);
  return {
    // the ladder: each channel alone, then fusion at three weights
    V: pageV,
    L: pageL,
    A: pageA,
    A73: take(fused73, args.pageSize),
    A91: take(fused91, args.pageSize),
    // structure on top of the best base (V), not on top of a degraded fusion
    BV: take(blend(blockActivation, args.lambda), args.pageSize),
    CV: take(blend(nodeActivation, args.lambda), args.pageSize),
    DV: [...pageV, ...take(blend(blockActivation, args.lambda), args.supplement, new Set(pageV))],
    EV: [...pageV, ...take(vectorScores, args.supplement, new Set(pageV))],
  };
}

/** One multi-hop question, or null when it has no resolvable gold or vector. */
function selectionRow(
  sample: LocomoSample,
  qi: number,
  item: LocomoQuestion,
  prep: SamplePrep,
  args: Args,
): Record<string, unknown> | null {
  if (Number(item.category) !== 1) return null;
  const labels = splitEvidenceLabels((item.evidence ?? []) as string[]);
  if (labels.length === 0) return null;
  const labelRecords = labelRecordsFor(labels, prep.turnText, prep.docs);
  if (labelRecords.size === 0) return null;
  const question = String(item.question);
  const queryVector = readQueryVector(args, sample.sample_id as string, question);
  if (!queryVector) return null;
  const arms = buildArms(prep, queryVector, tokenize(question), args);
  const row: Record<string, unknown> = {
    id: `${sample.sample_id}:${qi}`,
    sample: sample.sample_id,
  };
  for (const [name, page] of Object.entries(arms))
    row[name] = { hitPositions: positionsFor(labelRecords, page) };
  return row;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataset = JSON.parse(fs.readFileSync(args.data, "utf8")) as LocomoSample[];
  const rows: Array<Record<string, unknown>> = [];
  const eligible = new Set<string>();

  for (const sample of dataset) {
    if (!STORES[sample.sample_id as string]) continue;
    const prep = prepareSample(sample, args);
    for (const [qi, item] of (sample.qa ?? []).entries()) {
      const row = selectionRow(sample, qi, item, prep, args);
      if (!row) continue;
      rows.push(row);
      eligible.add(String(row.id));
    }
  }

  const report = (key: string) => {
    const arm = pairedComparison(rows, "V", key, eligible);
    const p = key === "V" ? null : signTestP(arm.wins, arm.losses);
    return {
      arm: key,
      n: arm.n,
      all: arm.allPct,
      any: arm.anyPct,
      recall: arm.recallPct,
      wins: arm.wins,
      losses: arm.losses,
      ties: arm.ties,
      p: p === null ? null : +p.toFixed(4),
    };
  };

  const lines = ["V", "L", "A", "A73", "A91", "BV", "CV", "DV", "EV"].map(report);
  // The question that decides whether structure earns a place at all: does a
  // structure-picked supplement beat a similarity-picked one of the same size?
  const structureVsSimilarity = pairedComparison(rows, "EV", "DV", eligible);
  const supplementP = signTestP(structureVsSimilarity.wins, structureVsSimilarity.losses);
  const out = {
    questions: rows.length,
    lambda: args.lambda,
    pageSize: args.pageSize,
    supplement: args.supplement,
    arms: lines,
    supplementStructureVersusSimilarity: {
      ...structureVsSimilarity,
      p: supplementP === null ? null : +supplementP.toFixed(4),
    },
  };
  console.log(
    [
      `多跳题: ${out.questions}  λ=${out.lambda}  page=${out.pageSize}  supplement=${out.supplement}`,
      "arm".padEnd(7) +
        "全覆%".padStart(8) +
        "any%".padStart(7) +
        "recall%".padStart(9) +
        "胜".padStart(5) +
        "负".padStart(4) +
        "平".padStart(5) +
        "p".padStart(9),
      ...lines.map(
        (line) =>
          String(line.arm).padEnd(7) +
          String(line.all).padStart(8) +
          String(line.any).padStart(7) +
          String(line.recall).padStart(9) +
          String(line.wins).padStart(5) +
          String(line.losses).padStart(4) +
          String(line.ties).padStart(5) +
          String(line.p ?? "-").padStart(9),
      ),
    ].join("\n"),
  );
  fs.writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(
    `补充段：结构挑选 vs 相似度挑选  ${structureVsSimilarity.allPct}% vs ${
      lines.find((line) => line.arm === "EV")!.all
    }%  ${structureVsSimilarity.wins}胜/${structureVsSimilarity.losses}负/${structureVsSimilarity.ties}平  p=${
      supplementP === null ? "-" : supplementP.toFixed(4)
    }`,
  );
  console.log(`wrote ${args.out}`);
}

let queryVectors: Map<string, Float32Array> | undefined;
function readQueryVector(args: Args, sample: string, question: string): Float32Array | undefined {
  queryVectors ??= readVectors(`${args.bge}/queries`);
  return queryVectors.get(`${sample}\u0000${question}`);
}

main();
