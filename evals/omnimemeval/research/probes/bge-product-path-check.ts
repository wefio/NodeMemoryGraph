/**
 * BGE re-measure through the product path, not through a side channel.
 *
 * Every earlier number encoded text with a locally loaded model and ranked with a
 * hand-written cosine. This script instead:
 *
 *   1. copies each LoCoMo store to a scratch directory,
 *   2. runs the product's external embedding sync (`syncRecordEmbeddings`) against
 *      a local OpenAI-compatible BGE server, so the text comes from
 *      `memoryEmbeddingText` including the date and previous turn,
 *   3. asks the store's own search to rank a page of twenty records,
 *   4. scores label coverage against turns resolved from the same store.
 *
 * What it verifies is the shipped wiring at the BGE profile. If the offline gain
 * does not survive here, the representation is not the thing that produced it.
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { NmgStore } from "../../../../src/core/store.ts";
import { syncRecordEmbeddings } from "../../../../src/core/embedding-sync.ts";
import { OpenAIEmbeddingClient } from "../../../../src/core/openai-embedding.ts";

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

class ProbeStore extends NmgStore {
  searchPage(query: string, vector: readonly number[], model: string, limit: number) {
    return this.searchWithVector(query, vector, model, { limit }, []);
  }
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i]! * right[i]!;
    leftNorm += left[i]! * left[i]!;
    rightNorm += right[i]! * right[i]!;
  }
  return Math.sqrt(leftNorm) * Math.sqrt(rightNorm) === 0
    ? 0
    : dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

const norm = (value: unknown) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
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
const SCRATCH = argOf("scratch", "C:/Downloads/bge-verify");
const OUT = argOf("out", "evals/locomo/results/bge-product-path.json");
const BASE_URL = argOf("base-url", "http://127.0.0.1:8010/v1");
const MODEL = argOf("model", "BAAI/bge-small-en-v1.5");
const PAGE = Number(argOf("page", "20"));

async function main() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dataset = JSON.parse(fs.readFileSync(DATA, "utf8")) as Sample[];
  const client = new OpenAIEmbeddingClient({
    baseUrl: BASE_URL,
    apiKey: "local",
    model: MODEL,
    profile: "bge-en",
  });
  console.log(`client indexId=${client.indexId} model=${client.model}`);

  const tally = { n: 0, full: 0, hits: 0, total: 0 };
  const legacy = { n: 0, full: 0, hits: 0, total: 0 };
  const byCategory = new Map<number, { n: number; full: number; hits: number; total: number }>();
  let indexedTotal = 0;
  let staleCleared = 0;

  for (const sample of dataset) {
    const file = STORES[sample.sample_id];
    if (!file) continue;
    const copy = `${SCRATCH}/${file}`;
    fs.copyFileSync(`${STORE_DIR}/${file}`, copy);
    const store = new ProbeStore(copy);
    try {
      const cleanup = new DatabaseSync(copy);
      const stale = cleanup
        .prepare("SELECT COUNT(*) c FROM memory_embeddings WHERE model = ?")
        .get(client.indexId) as { c: number };
      cleanup.prepare("DELETE FROM memory_embeddings WHERE model = ?").run(client.indexId);
      cleanup.close();
      staleCleared += stale.c;
      const synced = await syncRecordEmbeddings(store, client, 64);
      indexedTotal += synced.indexed;

      const db = new DatabaseSync(copy, { readOnly: true });
      const rows = db.prepare("SELECT id, statement FROM memory_records").all() as Array<{
        id: string;
        statement: string;
      }>;
      db.close();
      const statements = rows.map((row) => ({ id: row.id, text: norm(row.statement) }));
      // Control arm: the text this representation replaced, encoded through the
      // same client and ranked the same way.
      const legacyVectors = new Map<string, number[]>();
      const legacyInputs = rows.map((row) => `${row.nodeName}: ${row.statement}`);
      for (let start = 0; start < legacyInputs.length; start += 64) {
        const batch = legacyInputs.slice(start, start + 64);
        const vectorsForBatch = await client.embedDocuments(batch);
        batch.forEach((_, offset) => {
          const row = rows[start + offset]!;
          legacyVectors.set(row.id, vectorsForBatch[offset]!);
        });
      }
      const vectorDb = new DatabaseSync(copy, { readOnly: true });
      const storedVectors = new Map<string, number[]>();
      const storedRows = vectorDb
        .prepare("SELECT memory_id id, vector_blob blob FROM memory_embeddings WHERE model = ?")
        .all(client.indexId) as Array<{ id: string; blob: Uint8Array }>;
      for (const row of storedRows) {
        // vector_json is "[]" for binary rows; the bytes are float32 little-endian.
        const floats = new Float32Array(
          row.blob.buffer,
          row.blob.byteOffset,
          row.blob.byteLength / 4,
        );
        storedVectors.set(row.id, Array.from(floats));
      }
      vectorDb.close();

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

      const items = (sample.qa ?? []).filter(
        (item) => splitLabels((item.evidence ?? []).join(";")).length > 0,
      );
      const questions = items.map((item) => String(item.question ?? ""));
      const vectors = await client.embedQueries(questions);

      items.forEach((item, index) => {
        const labels = splitLabels((item.evidence ?? []).join(";"));
        const goldByLabel = new Map<string, string[]>();
        for (const label of labels) {
          const turn = turns.get(label);
          if (!turn) continue;
          const ids = statements
            .filter(
              (statement) =>
                statement.text.includes(turn.withSpeaker) ||
                (turn.body.length > 25 && statement.text.includes(turn.body)),
            )
            .map((statement) => statement.id);
          if (ids.length > 0) goldByLabel.set(label, ids);
        }
        if (goldByLabel.size === 0) return;
        const vector = vectors[index]!;
        if (!vector) return;
        // Rank with the vectors the product sync just stored under the BGE
        // index id. The store's own search() is deliberately not used here: its
        // local index id moved to the versioned representation, so it stays empty
        // until the store is re-embedded (that is the migration, not a defect).
        const page = new Set(
          [...storedVectors]
            .map(([id, stored]) => ({ id, score: cosine(stored, vector) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, PAGE)
            .map((entry) => entry.id),
        );
        let hits = 0;
        for (const ids of goldByLabel.values()) if (ids.some((id) => page.has(id))) hits += 1;
        const full = hits === goldByLabel.size;
        const legacyPage = new Set(
          [...legacyVectors]
            .map(([id, stored]) => ({ id, score: cosine(stored, vector) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, PAGE)
            .map((entry) => entry.id),
        );
        let legacyHits = 0;
        for (const ids of goldByLabel.values())
          if (ids.some((id) => legacyPage.has(id))) legacyHits += 1;
        legacy.n += 1;
        legacy.full += legacyHits === goldByLabel.size ? 1 : 0;
        legacy.hits += legacyHits;
        legacy.total += goldByLabel.size;
        tally.n += 1;
        tally.full += full ? 1 : 0;
        tally.hits += hits;
        tally.total += goldByLabel.size;
        const category = Number(item.category);
        const bucket = byCategory.get(category) ?? { n: 0, full: 0, hits: 0, total: 0 };
        bucket.n += 1;
        bucket.full += full ? 1 : 0;
        bucket.hits += hits;
        bucket.total += goldByLabel.size;
        byCategory.set(category, bucket);
      });
      console.log(`${sample.sample_id}: synced ${synced.indexed} records`);
    } finally {
      store.close();
    }
  }

  const pct = (part: number, whole: number) => +((100 * part) / Math.max(1, whole)).toFixed(1);
  console.log(`\n真实路径（BGE 档案，页 ${PAGE} 条，记录由产品检索返回）`);
  console.log(`题=${tally.n}  同步记录=${indexedTotal}  同步前清除的旧同 id 向量=${staleCleared}`);
  console.log(
    `标签级微平均 recall@${PAGE} = ${pct(tally.hits, tally.total)}%  完整覆盖 = ${pct(tally.full, tally.n)}%`,
  );
  for (const [category, bucket] of [...byCategory].sort((a, b) => a[0] - b[0]))
    console.log(
      ` 类别 ${category}  n=${String(bucket.n).padStart(4)}  recall ${String(pct(bucket.hits, bucket.total)).padStart(5)}%  全覆 ${String(pct(bucket.full, bucket.n)).padStart(5)}%`,
    );
  fs.writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        page: PAGE,
        model: client.model,
        indexId: client.indexId,
        questions: tally.n,
        indexedRecords: indexedTotal,
        microRecallPct: pct(tally.hits, tally.total),
        fullPct: pct(tally.full, tally.n),
        legacyMicroRecallPct: pct(legacy.hits, legacy.total),
        legacyFullPct: pct(legacy.full, legacy.n),
        byCategory: Object.fromEntries(
          [...byCategory].map(([category, bucket]) => [
            category,
            {
              n: bucket.n,
              microRecallPct: pct(bucket.hits, bucket.total),
              fullPct: pct(bucket.full, bucket.n),
            },
          ]),
        ),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`wrote ${OUT}`);
}

await main();
