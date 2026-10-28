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
import { poolQueryVectors, splitQueryChunks } from "../../../../onlion/backend/query-chunks.mjs";

/** The bge-en query template: chunk vectors must come from the same view as the
 *  baked record vectors or the comparison would measure a template change. */
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const CONDITIONS = ["short", "long", "mixed", "tail"] as const;
type Condition = (typeof CONDITIONS)[number];

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
  aAll?: number;
  cAll?: number;
  dAll?: number;
  eAll?: number;
  identical?: boolean;
}
interface Options {
  page: number;
  candidates: number;
  longChars: number;
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
): Record<Condition, string> {
  const padding = fillerText(Math.max(0, longChars - question.length));
  const mixed = [question, ...others.filter((text) => text !== question).slice(0, 6)]
    .join("\n")
    .slice(0, longChars)
    .padEnd(longChars, " .");
  // `tail` puts the question after the padding: with no splitting the model only
  // sees its head window, so this condition separates "truncation works" from
  // "truncation worked because the question happened to be first".
  return {
    short: question,
    long: `${question}\n${padding}`,
    mixed,
    tail: `${padding}\n${question}`,
  };
}

/** Three arms per condition:
 *  A = mean-pooled chunk vector, B rounds the page (shipped);
 *  C = same pooled vector for a candidate pool, reranked by per-chunk max;
 *  D = no chunking at all — the whole query as one text, so the embedding model
 *      applies its own token window. D is the baseline for "is chunking worth it". */
/** A = mean-pooled chunk vector (shipped); C = pooled candidate pool reranked by
 *  per-chunk max; D = no chunking at all — the whole query as one text, so the
 *  embedding model applies its own token window. D is the baseline for "is
 *  chunking worth it". */
async function evaluateQuestion(
  question: string,
  gold: string[][],
  others: string[],
  docs: Doc[],
  embedBase: string,
  options: Options,
): Promise<Row[]> {
  const texts = queryTexts(question, others, options.longChars);
  const wantChunks = options.arms.has("a") || options.arms.has("c") || options.arms.has("e");
  const wantWhole = options.arms.has("d") || options.arms.has("e");
  const chunksBy = Object.fromEntries(
    CONDITIONS.map((condition) => [
      condition,
      wantChunks ? (splitQueryChunks(texts[condition]) as string[]) : [],
    ]),
  ) as Record<Condition, string[]>;
  const chunkTexts = wantChunks
    ? CONDITIONS.flatMap((condition) => chunksBy[condition])
    : ([] as string[]);
  const wholeTexts = wantWhole ? CONDITIONS.map((condition) => texts[condition]) : [];
  const vectors = await embed(embedBase, [...chunkTexts, ...wholeTexts]);
  const whole = vectors.slice(chunkTexts.length);
  const rows: Row[] = [];
  let offset = 0;
  for (const [index, condition] of CONDITIONS.entries()) {
    const count = chunksBy[condition].length;
    const chunks = vectors.slice(offset, offset + count);
    offset += count;
    const row: Row = { condition, total: gold.length };
    if (wantChunks) {
      const pooled = count === 1 ? chunks[0]! : poolQueryVectors(chunks);
      const aPage = rankByVector(pooled, docs, options.page);
      const a = recallOf(gold, aPage);
      row.aHits = a.hits;
      row.aAll = a.all;
      if (options.arms.has("c")) {
        const cPage = rankByChunkMax(pooled, chunks, docs, options);
        const c = recallOf(gold, cPage);
        row.cHits = c.hits;
        row.cAll = c.all;
        row.identical = aPage.join(",") === cPage.join(",");
      }
    }
    if (wantWhole) {
      const d = recallOf(gold, rankByVector(whole[index]!, docs, options.page));
      row.dHits = d.hits;
      row.dAll = d.all;
    }
    if (options.arms.has("e")) {
      const { page } = rankByFeatureMax([whole[index]!, ...chunks], docs, options.page);
      const e = recallOf(gold, page);
      row.eHits = e.hits;
      row.eAll = e.all;
    }
    rows.push(row);
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
    const pct = (key: "aHits" | "cHits" | "dHits" | "eHits") => {
      const present = slice.filter((row) => row[key] !== undefined);
      if (present.length === 0) return null;
      const hits = present.reduce((sum, row) => sum + Number(row[key]), 0);
      return Number(((100 * hits) / totalLabels).toFixed(2));
    };
    const share = (key: "aAll" | "cAll" | "dAll" | "eAll") => {
      const present = slice.filter((row) => row[key] !== undefined);
      if (present.length === 0) return null;
      return Number(
        ((100 * present.reduce((sum, row) => sum + Number(row[key]), 0)) / n).toFixed(2),
      );
    };
    const paired = (left: "aAll" | "cAll" | "eAll", right: "dAll" | "aAll" | "cAll") => {
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
    return {
      condition,
      n: slice.length,
      aRecall: pct("aHits"),
      cRecall: pct("cHits"),
      dRecall: pct("dHits"),
      eRecall: pct("eHits"),
      aAll: share("aAll"),
      cAll: share("cAll"),
      dAll: share("dAll"),
      eAll: share("eAll"),
      identical: slice.filter((row) => row.identical).length,
      cOverD,
      aOverD,
      eOverD,
      eOverA,
      eOverC,
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
      arms: { type: "string", default: "a,c,d" },
    },
  });
  if (!values.data || !values.stores || !values.bge || !values.embed)
    throw new Error("--data, --stores, --bge and --embed are required");
  const options: Options = {
    page: Number(values.page),
    candidates: Number(values.candidates),
    longChars: Number(values["long-chars"]),
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
        `E>D ${row.eOverD} | E>A ${row.eOverA} | E>C ${row.eOverC}`,
    );
  console.log(`wrote ${values.out}`);
}

await main();
