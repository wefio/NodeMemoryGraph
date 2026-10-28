/** A vs C query-vector strategies for long queries, measured on gold evidence.
 *
 * A (shipped): split a long query into windows, embed each, mean-pool into one
 * unit vector, rank the whole store with that single vector.
 * C (candidate): use the same pooled vector to take a candidate page, then rerank
 * only that page by the *max* cosine over the chunk vectors, so several aspects of
 * a long query are not averaged into a compromise direction.
 *
 * Zero LLM cost: recall against the LoCoMo gold labels only. The control
 * condition is the un-chunked question, where A and C must produce an identical
 * page, because a single chunk makes `max` and `mean` the same vector.
 *
 *   node --experimental-strip-types evals/omnimemeval/research/probes/query-chunk-pooling-ab.ts \
 *     --data D:/Github/.benchmarks/official/LoCoMo/data/locomo10.json \
 *     --stores D:/Github/.benchmarks/omnimemeval-nmg \
 *     --bge C:/Downloads/bge --embed http://127.0.0.1:8000
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { cosineSimilarity } from "../../../../src/core/vector.ts";

/** The bge-en query template: chunk vectors must come from the same view as the
 *  baked record vectors or the comparison would measure a template change. */
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

/** Unit-length mean of window vectors. Kept here, not imported: the product no
 *  longer pools windows, and this arm exists only as the record of what was
 *  compared. */
function poolQueryVectors(vectors: Float32Array[]): Float32Array {
  const first = vectors[0];
  if (!first) throw new Error("poolQueryVectors requires at least one vector");
  const pooled = new Float32Array(first.length);
  for (const vector of vectors) for (let i = 0; i < first.length; i += 1) pooled[i] += vector[i];
  let norm = 0;
  for (let i = 0; i < pooled.length; i += 1) {
    pooled[i] /= vectors.length;
    norm += pooled[i] * pooled[i];
  }
  norm = Math.sqrt(norm);
  if (norm) for (let i = 0; i < pooled.length; i += 1) pooled[i] /= norm;
  return pooled;
}

/** Arm E's layout, kept here as the baseline it measures against: tile forward from
 *  the start with boundary-snapped cuts, then append one end-anchored window. This is
 *  the shape the product shipped before the planned layout replaced it, so the probe
 *  must keep its own copy rather than importing whatever the product does today. */
const LEGACY_CHUNK_CHARS = 2000;
const LEGACY_MAX_CHUNKS = 8;
function legacyBoundaryBefore(window: string): number {
  const candidates = [
    window.lastIndexOf("\n"),
    window.lastIndexOf(". "),
    window.lastIndexOf("? "),
    window.lastIndexOf("! "),
    window.lastIndexOf("。"),
    window.lastIndexOf("；"),
    window.lastIndexOf("，"),
  ].filter((index) => index > 0);
  const best = Math.max(-1, ...candidates);
  return best > window.length / 2 ? best + 1 : window.length;
}
function legacyFirstBoundary(window: string): number {
  const candidates = [
    window.indexOf("\n"),
    window.indexOf(". "),
    window.indexOf("? "),
    window.indexOf("! "),
    window.indexOf("。"),
    window.indexOf("；"),
    window.indexOf("，"),
  ].filter((index) => index > 0);
  const best = candidates.length === 0 ? -1 : Math.min(...candidates);
  return best > 0 && best < window.length / 2 ? best + 1 : 0;
}
function legacyForwardWindows(text: string): string[] {
  const size = LEGACY_CHUNK_CHARS;
  const limit = LEGACY_MAX_CHUNKS;
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length && chunks.length < Math.max(1, limit - 1)) {
    if (chunks.length > 0 && text.length - start <= size / 4) {
      chunks[chunks.length - 1] += text.slice(start);
      break;
    }
    const window = text.slice(start, Math.min(start + size, text.length));
    const cut = legacyBoundaryBefore(window);
    chunks.push(text.slice(start, start + cut));
    start += cut;
  }
  if (start >= text.length) return chunks;
  if (text.length - start < size / 4) {
    chunks[chunks.length - 1] += text.slice(start);
    return chunks;
  }
  const tail = text.slice(Math.max(0, text.length - size));
  const from = legacyFirstBoundary(tail);
  chunks.push(from > 0 ? tail.slice(from) : tail);
  return chunks;
}

const CONDITIONS_BASE = ["short", "long", "mixed", "tail", "mid"] as const;
/** Built in `main`: the base conditions, or a position sweep when `--offsets` is
 *  given. A sweep is what separates the two layouts: E tiles forward from the start,
 *  so how well it does depends on *where* the informative part sits, while a plan
 *  that spreads its windows should be nearly flat. */
let CONDITIONS: string[] = [...CONDITIONS_BASE];
type Condition = string;

interface Qa {
  category?: number | string;
  question?: string;
  evidence?: string[];
}
interface Sample {
  sample_id: string;
  conversation: Record<string, unknown>;
  qa?: Qa[];
}
interface Doc {
  id: string;
  normText: string;
  vector: Float32Array;
}
interface Row {
  condition: Condition;
  total: number;
  aHits?: number;
  cHits?: number;
  dHits?: number;
  eHits?: number;
  fHits?: number;
  gHits?: number;
  hHits?: number;
  aAll?: number;
  cAll?: number;
  dAll?: number;
  eAll?: number;
  fAll?: number;
  gAll?: number;
  hAll?: number;
  identical?: boolean;
}
interface Options {
  page: number;
  candidates: number;
  longChars: number;
  /** Force a segment count for arm F instead of `ceil(L / W)`; 0 keeps the
   *  adaptive count. Sweeping it answers "how long should one window be". */
  planCount: number;
  /** Percentage offsets for the position sweep; empty uses the base conditions. */
  offsets: number[];
  /** Which vector strategies to compute: `a` mean-pool, `c` max-rerank over a
   *  pooled candidate pool, `d` no splitting, `e` search with the head vector and
   *  every chunk as separate features, reduced by max. Only the requested arms are
   *  embedded; `e` needs both the head and the chunks, so it covers `a`/`c`/`d`. */
  arms: Set<string>;
}

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

const norm = (value: unknown) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();

function readVectors(stem: string): Map<string, Float32Array> {
  const ids = JSON.parse(fs.readFileSync(`${stem}.ids.json`, "utf8")) as string[];
  const buffer = fs.readFileSync(`${stem}.vecs.f32`);
  const flat = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  const dims = ids.length === 0 ? 0 : flat.length / ids.length;
  const map = new Map<string, Float32Array>();
  ids.forEach((id, i) => map.set(id, flat.subarray(i * dims, (i + 1) * dims)));
  return map;
}

function loadDocs(stores: string, bge: string, file: string): Doc[] {
  const db = new DatabaseSync(`${stores}/${file}`, { readOnly: true });
  const rows = db
    .prepare("SELECT id, statement FROM memory_records ORDER BY node_id, created_at, rowid")
    .all() as Array<{ id: string; statement: string }>;
  db.close();
  const vectors = readVectors(`${bge}/${file.replace(".sqlite", "")}`);
  return rows.map((row) => {
    const vector = vectors.get(row.id);
    if (!vector) throw new Error(`missing vector for ${row.id}`);
    return { id: row.id, normText: norm(row.statement), vector };
  });
}

function turnText(sample: Sample): Map<string, { withSpeaker: string; body: string }> {
  const turns = new Map<string, { withSpeaker: string; body: string }>();
  for (const [key, value] of Object.entries(sample.conversation)) {
    if (!/^session_\d+$/u.test(key) || !Array.isArray(value)) continue;
    for (const turn of value as Array<{ dia_id?: string; speaker?: string; text?: string }>) {
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

function goldSetsFor(
  labels: string[],
  turns: Map<string, { withSpeaker: string; body: string }>,
  docs: Doc[],
): string[][] {
  const sets: string[][] = [];
  for (const label of labels) {
    const turn = turns.get(label);
    if (!turn) continue;
    const ids = docs
      .filter(
        (doc) =>
          doc.normText.includes(turn.withSpeaker) ||
          (turn.body.length > 25 && doc.normText.includes(turn.body)),
      )
      .map((doc) => doc.id);
    if (ids.length > 0) sets.push(ids);
  }
  return sets;
}

async function embed(base: string, texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32).map((text) => QUERY_PREFIX + text);
    const response = await fetch(`${base}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "bge-small-en-v1.5", input: batch }),
    });
    if (!response.ok) throw new Error(`embedding failed: ${response.status}`);
    const payload = (await response.json()) as { data: Array<{ embedding: number[] }> };
    for (const row of payload.data) out.push(Float32Array.from(row.embedding));
  }
  return out;
}

function rankByVector(vector: Float32Array, docs: Doc[], limit: number): string[] {
  return docs
    .map((doc) => ({ id: doc.id, score: cosineSimilarity(vector, doc.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.id);
}

/** Every feature searched independently, reduced by max: a document's score is
 *  its best similarity to any feature (head vector or any chunk). This keeps the
 *  head as "what the query is about" while letting a later chunk match on its own,
 *  so neither a head-aligned nor a tail-aligned long query is penalised. */
function rankByFeatureMax(
  features: Float32Array[],
  docs: Doc[],
  limit: number,
): { page: string[]; perFeature: string[][] } {
  const perFeature = features.map((feature) => rankByVector(feature, docs, limit));
  const page = docs
    .map((doc) => {
      let best = -Infinity;
      for (const feature of features) best = Math.max(best, cosineSimilarity(feature, doc.vector));
      return { id: doc.id, score: best };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.id);
  return { page, perFeature };
}

/** Page from the pooled vector, then reranked by the best single chunk. */
function rankByChunkMax(
  pooled: Float32Array,
  chunks: Float32Array[],
  docs: Doc[],
  options: Options,
): string[] {
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  return rankByVector(pooled, docs, options.candidates)
    .map((id) => {
      const doc = byId.get(id)!;
      let best = -Infinity;
      for (const chunk of chunks) best = Math.max(best, cosineSimilarity(chunk, doc.vector));
      return { id, score: best };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, options.page)
    .map((row) => row.id);
}

/** Last measurement arm: the window layout itself, independent of pooling.
 *
 *  F keeps the head and the tail by construction and never overlaps: with
 *  `n = min(ceil(L / W), maxWindows)` windows of budget `W`,
 *  - `L <= n*W` (the budget covers the text) cuts the text into `n` equal,
 *    contiguous, disjoint segments that share one boundary-snapped cut point per
 *    seam, so nothing is dropped and nothing is embedded twice;
 *  - `L > n*W` (budget-bound) uses `n` windows of `W`, the first at 0 and the last
 *    anchored at the end, with the uncovered text spread evenly between them
 *    instead of leaving one block at the far end unsearched.
 *
 *  E, by contrast, tiles forward from the start and then appends the end-anchored
 *  window, so its blind region is a single contiguous block in the middle. */
const BOUNDARIES = ["\n", ". ", "? ", "! "];
function snapCut(text: string, ideal: number, previous: number, end: number): number {
  const ceiling = Math.min(end - 1, ideal + 400);
  for (let at = Math.max(ideal, previous + 1); at <= ceiling; at += 1) {
    const tail = text.slice(at, at + 2);
    if (BOUNDARIES.some((boundary) => tail.startsWith(boundary))) return at + 1;
  }
  return Math.min(Math.max(ideal, previous + 1), ceiling);
}
function planQueryWindows(
  text: string,
  windowChars = 2000,
  maxWindows = 9,
  forcedCount = 0,
): string[] {
  const length = text.length;
  if (length <= windowChars) return [text];
  const count =
    forcedCount > 0
      ? Math.min(forcedCount, Math.max(2, maxWindows))
      : Math.min(Math.ceil(length / windowChars), Math.max(2, maxWindows));
  if (length <= count * windowChars) {
    const cuts = [0];
    for (let i = 1; i < count; i += 1)
      cuts.push(snapCut(text, Math.round((i * length) / count), cuts[i - 1]!, length));
    cuts.push(length);
    const segments = cuts.slice(1).map((end, i) => text.slice(cuts[i]!, end));
    return segments.filter((segment) => segment.length > 0);
  }
  const stride = (length - count * windowChars) / (count - 1) + windowChars;
  return Array.from({ length: count }, (_unused, i) => {
    const start = i === 0 ? 0 : i === count - 1 ? length - windowChars : Math.round(i * stride);
    return text.slice(start, start + windowChars);
  });
}

function recallOf(gold: string[][], page: string[]): { hits: number; total: number; all: number } {
  const set = new Set(page);
  let hits = 0;
  let all = true;
  for (const ids of gold) {
    if (ids.some((id) => set.has(id))) hits += 1;
    else all = false;
  }
  return { hits, total: gold.length, all: all ? 1 : 0 };
}

/** Two-sided exact sign test over paired wins/losses. */
function signTestP(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const logFact = (value: number) => {
    let sum = 0;
    for (let i = 2; i <= value; i += 1) sum += Math.log(i);
    return sum;
  };
  const tail = (k: number) => {
    let sum = 0;
    for (let i = 0; i <= k; i += 1)
      sum += Math.exp(logFact(n) - logFact(i) - logFact(n - i) - n * Math.log(2));
    return sum;
  };
  return Math.min(1, 2 * tail(Math.min(wins, losses)));
}

function fillerText(size: number): string {
  const sentence = "The weather that afternoon was mild and the bus arrived a little late again. ";
  return sentence.repeat(Math.ceil(size / sentence.length)).slice(0, size);
}

/** Three query texts for one question: the control and two long variants. */
function queryTexts(
  question: string,
  others: string[],
  longChars: number,
  offsets: number[],
): Record<string, string> {
  const padding = fillerText(Math.max(0, longChars - question.length));
  const mixed = [question, ...others.filter((text) => text !== question).slice(0, 6)]
    .join("\n")
    .slice(0, longChars)
    .padEnd(longChars, " .");
  // `tail` puts the question after the padding: with no splitting the model only
  // sees its head window, so this condition separates "truncation works" from
  // "truncation worked because the question happened to be first".
  const texts: Record<string, string> = {
    short: question,
    long: `${question}\n${padding}`,
    mixed,
    tail: `${padding}\n${question}`,
    // A percentage condition: the question sits at that fraction of the text. The
    // padding is filler either way, so the only thing that moves is the offset.
    mid: midText(question, longChars, 0.5),
  };
  for (const offset of offsets)
    texts[`pos-${String(offset).padStart(3, "0")}`] = midText(question, longChars, offset / 100);
  return texts;
}

/** Question at `fraction` of the padded text. */
function midText(question: string, longChars: number, fraction: number): string {
  if (longChars <= question.length + 2) return question;
  const before = Math.round(Math.min(Math.max(fraction, 0), 1) * (longChars - question.length - 1));
  const after = Math.max(0, longChars - question.length - 1 - before);
  return `${fillerText(before)}\n${question}\n${fillerText(after)}`;
}

/** Feature texts for every condition, and their vectors.
 *
 *  Each arm needs a different subset, so the sets are gathered once per question and
 *  sliced back in the same order. Keeping the gathering here leaves the per-condition
 *  loop reading as a list of arms rather than a list of bookkeeping. */
async function prepareVectors(
  texts: Record<Condition, string>,
  embedBase: string,
  options: Options,
) {
  const wantChunks = options.arms.has("a") || options.arms.has("c") || options.arms.has("e");
  const wantWhole =
    options.arms.has("d") ||
    options.arms.has("e") ||
    options.arms.has("g") ||
    options.arms.has("h");
  const wantPlan = options.arms.has("f") || options.arms.has("g") || options.arms.has("h");
  const chunksBy = Object.fromEntries(
    CONDITIONS.map((condition) => [
      condition,
      wantChunks ? legacyForwardWindows(texts[condition]) : [],
    ]),
  ) as Record<Condition, string[]>;
  const planBy = Object.fromEntries(
    CONDITIONS.map((condition) => [
      condition,
      wantPlan ? planQueryWindows(texts[condition], 2000, 9, options.planCount) : [],
    ]),
  ) as Record<Condition, string[]>;
  const chunkTexts = CONDITIONS.flatMap((condition) => chunksBy[condition]);
  const wholeTexts = wantWhole ? CONDITIONS.map((condition) => texts[condition]) : [];
  const planTexts = wantPlan ? CONDITIONS.flatMap((condition) => planBy[condition]) : [];
  const vectors = await embed(embedBase, [...chunkTexts, ...wholeTexts, ...planTexts]);
  return {
    chunksBy,
    planBy,
    chunks: vectors.slice(0, chunkTexts.length),
    whole: vectors.slice(chunkTexts.length, chunkTexts.length + wholeTexts.length),
    plans: vectors.slice(chunkTexts.length + wholeTexts.length),
    wantChunks,
    wantWhole,
    wantPlan,
  };
}

interface ArmInput {
  gold: string[][];
  docs: Doc[];
  options: Options;
  whole?: Float32Array;
  chunks: Float32Array[];
  plans: Float32Array[];
  arms: Set<string>;
}

/** Every arm's page for one condition. One function per arm would be six functions of
 *  four lines; the branches below are the arms themselves. */
function scoreCondition(input: ArmInput): Partial<Row> {
  const { gold, docs, options, whole, chunks, plans } = input;
  const { page, arms } = options;
  const row: Partial<Row> = {};
  const record = (name: string, recall: ReturnType<typeof recallOf>) => {
    row[`${name}Hits` as keyof Row] = recall.hits as never;
    row[`${name}All` as keyof Row] = recall.all as never;
  };
  if (arms.has("a") || arms.has("c") || arms.has("e")) {
    const pooled = chunks.length === 1 ? chunks[0]! : poolQueryVectors(chunks);
    const aPage = rankByVector(pooled, docs, page);
    record("a", recallOf(gold, aPage));
    if (arms.has("c")) {
      const cPage = rankByChunkMax(pooled, chunks, docs, options);
      record("c", recallOf(gold, cPage));
      row.identical = aPage.join(",") === cPage.join(",");
    }
  }
  if (arms.has("d") && whole) record("d", recallOf(gold, rankByVector(whole, docs, page)));
  if (arms.has("e") && whole)
    record("e", recallOf(gold, rankByFeatureMax([whole, ...chunks], docs, page).page));
  if (arms.has("f")) record("f", recallOf(gold, rankByFeatureMax(plans, docs, page).page));
  if (arms.has("g") && whole)
    record("g", recallOf(gold, rankByFeatureMax([whole, ...plans], docs, page).page));
  // H drops the first planned window: the clause itself already covers the opening
  // with the model's own token window, which is longer than one character window.
  if (arms.has("h") && whole)
    record("h", recallOf(gold, rankByFeatureMax([whole, ...plans.slice(1)], docs, page).page));
  return row;
}

async function evaluateQuestion(
  question: string,
  gold: string[][],
  others: string[],
  docs: Doc[],
  embedBase: string,
  options: Options,
): Promise<Row[]> {
  const texts = queryTexts(question, others, options.longChars, options.offsets);
  const prepared = await prepareVectors(texts, embedBase, options);
  const rows: Row[] = [];
  let chunkOffset = 0;
  let planOffset = 0;
  for (const [index, condition] of CONDITIONS.entries()) {
    const chunkCount = prepared.chunksBy[condition].length;
    const planCount = prepared.planBy[condition].length;
    const chunks = prepared.chunks.slice(chunkOffset, chunkOffset + chunkCount);
    const plans = prepared.plans.slice(planOffset, planOffset + planCount);
    chunkOffset += chunkCount;
    planOffset += planCount;
    rows.push({
      condition,
      total: gold.length,
      ...scoreCondition({
        gold,
        docs,
        options,
        whole: prepared.whole[index],
        chunks,
        plans,
        arms: options.arms,
      }),
    });
  }
  return rows;
}

async function runSample(
  sample: Sample,
  paths: { stores: string; bge: string; embed: string },
  options: Options,
): Promise<Row[]> {
  const file = STORES[sample.sample_id];
  if (!file) return [];
  const docs = loadDocs(paths.stores, paths.bge, file);
  const turns = turnText(sample);
  const questions = (sample.qa ?? []).filter((item) => Number(item.category) === 1);
  const others = questions.map((item) => String(item.question ?? ""));
  const rows: Row[] = [];
  for (const item of questions) {
    const question = String(item.question ?? "");
    const labels = (item.evidence ?? []).filter(Boolean);
    if (!question || labels.length === 0) continue;
    const gold = goldSetsFor(labels, turns, docs);
    if (gold.length === 0) continue;
    rows.push(...(await evaluateQuestion(question, gold, others, docs, paths.embed, options)));
  }
  return rows;
}

function summarize(rows: Row[]): Array<Record<string, string | number>> {
  return CONDITIONS.map((condition) => {
    const slice = rows.filter((row) => row.condition === condition);
    const n = Math.max(1, slice.length);
    const totalLabels = Math.max(
      1,
      slice.reduce((sum, row) => sum + row.total, 0),
    );
    const pct = (key: "aHits" | "cHits" | "dHits" | "eHits" | "fHits" | "gHits" | "hHits") => {
      const present = slice.filter((row) => row[key] !== undefined);
      if (present.length === 0) return null;
      const hits = present.reduce((sum, row) => sum + Number(row[key]), 0);
      return Number(((100 * hits) / totalLabels).toFixed(2));
    };
    const share = (key: "aAll" | "cAll" | "dAll" | "eAll" | "fAll" | "gAll" | "hAll") => {
      const present = slice.filter((row) => row[key] !== undefined);
      if (present.length === 0) return null;
      return Number(
        ((100 * present.reduce((sum, row) => sum + Number(row[key]), 0)) / n).toFixed(2),
      );
    };
    const paired = (
      left: "aAll" | "cAll" | "eAll" | "fAll" | "gAll" | "hAll" | "dAll",
      right: "dAll" | "aAll" | "cAll" | "eAll" | "fAll" | "gAll" | "hAll",
    ) => {
      const usable = slice.filter((row) => row[left] !== undefined && row[right] !== undefined);
      if (usable.length === 0) return "-";
      const wins = usable.filter((row) => Number(row[left]) > Number(row[right])).length;
      const losses = usable.filter((row) => Number(row[left]) < Number(row[right])).length;
      return `${wins}W/${losses}L p=${signTestP(wins, losses).toFixed(4)}`;
    };
    const cOverD = paired("cAll", "dAll");
    const aOverD = paired("aAll", "dAll");
    const eOverD = paired("eAll", "dAll");
    const eOverA = paired("eAll", "aAll");
    const eOverC = paired("eAll", "cAll");
    const fOverD = paired("fAll", "dAll");
    const fOverE = paired("fAll", "eAll");
    const gOverE = paired("gAll", "eAll");
    const gOverF = paired("gAll", "fAll");
    const hOverG = paired("hAll", "gAll");
    const hOverE = paired("hAll", "eAll");
    return {
      condition,
      n: slice.length,
      aRecall: pct("aHits"),
      cRecall: pct("cHits"),
      dRecall: pct("dHits"),
      eRecall: pct("eHits"),
      fRecall: pct("fHits"),
      gRecall: pct("gHits"),
      hRecall: pct("hHits"),
      aAll: share("aAll"),
      cAll: share("cAll"),
      dAll: share("dAll"),
      eAll: share("eAll"),
      fAll: share("fAll"),
      gAll: share("gAll"),
      hAll: share("hAll"),
      identical: slice.filter((row) => row.identical).length,
      cOverD,
      aOverD,
      eOverD,
      eOverA,
      eOverC,
      fOverD,
      fOverE,
      gOverE,
      gOverF,
      hOverG,
      hOverE,
    };
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      data: { type: "string" },
      stores: { type: "string" },
      bge: { type: "string" },
      embed: { type: "string" },
      out: { type: "string", default: "evals/locomo/results/query-chunk-pooling-ab.json" },
      page: { type: "string", default: "20" },
      candidates: { type: "string", default: "100" },
      "long-chars": { type: "string", default: "6000" },
      offsets: { type: "string", default: "" },
      "plan-count": { type: "string", default: "0" },
      arms: { type: "string", default: "a,c,d" },
    },
  });
  if (!values.data || !values.stores || !values.bge || !values.embed)
    throw new Error("--data, --stores, --bge and --embed are required");
  const options: Options = {
    page: Number(values.page),
    candidates: Number(values.candidates),
    longChars: Number(values["long-chars"]),
    planCount: Number(values["plan-count"]),
    offsets: values.offsets
      .split(",")
      .filter((value) => value.trim().length > 0)
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value >= 0 && value <= 100),
    arms: new Set(
      values.arms
        .split(",")
        .map((arm) => arm.trim())
        .filter(Boolean),
    ),
  };
  const paths = {
    stores: values.stores,
    bge: values.bge,
    embed: values.embed.replace(/\/$/u, ""),
  };
  const samples = JSON.parse(fs.readFileSync(values.data, "utf8")) as Sample[];
  // A position sweep replaces the long-form conditions: the offsets themselves are
  // the variable, and the short control stays so the sweep can be sanity-checked.
  if (options.offsets.length > 0)
    CONDITIONS = [
      "short",
      ...options.offsets.map((offset) => `pos-${String(offset).padStart(3, "0")}`),
    ];
  const rows: Row[] = [];
  for (const sample of samples) rows.push(...(await runSample(sample, paths, options)));
  const summary = summarize(rows);
  fs.mkdirSync(values.out.replace(/[\\/][^\\/]+$/u, ""), { recursive: true });
  fs.writeFileSync(values.out, `${JSON.stringify({ ...options, summary }, null, 2)}\n`);
  console.log(
    `questions=${summary[0]?.n ?? 0} page=${options.page} candidates=${options.candidates} longChars=${options.longChars}`,
  );
  for (const row of summary)
    console.log(
      `${String(row.condition).padEnd(6)} n=${row.n} | ` +
        `D(no-split) all=${row.dAll}% rec=${row.dRecall}% | ` +
        `A(pool) all=${row.aAll}% rec=${row.aRecall}% | ` +
        `C(max-rerank) all=${row.cAll}% rec=${row.cRecall}% | ` +
        `E(head+chunks max) all=${row.eAll}% rec=${row.eRecall}% | ` +
        `F(plan windows) all=${row.fAll}% rec=${row.fRecall}% | ` +
        `G(whole+plan) all=${row.gAll}% rec=${row.gRecall}% | ` +
        `H(whole+plan-no-first) all=${row.hAll}% rec=${row.hRecall}% | ` +
        `E>D ${row.eOverD} | G>E ${row.gOverE} | H>G ${row.hOverG}`,
    );
  console.log(`wrote ${values.out}`);
}

await main();
