// Static multi-path arms over the onlion entry — v4, review-driven isolation.
//
// Arms (each scored through the frozen contract in locomo-audit-shared.ts, on
// the frozen eligible projection from buildEligibilityManifest):
//   A    original query, top-20                       (baseline reproduction)
//   B    original query, top-100 -> cut 20            (isolated depth variable)
//   D20  paths {original + derived} pools @20 fused -> 20
//   D100 paths {original + derived} pools @100 fused -> 20
// B and D are DIFFERENT variables and are never substituted for each other.
// Every arm also gets a paired fixed-text-budget view: the fused/fetched list
// sliced to arm A's per-question context characters.
//
// Outputs (evals/locomo/results/static-multipath-v4-<runId>/):
//   rows.jsonl            per-question hit positions + latencies per arm
//   raw-candidates.jsonl  per-question per-path AND final ranked
//                         {id, content, score} lists (offline recomputation)
//   summary.json          paired comparisons (all@20 win/loss vs A), coverage,
//                         text-budget views, latency means
// The worker user_id (dataset sample_id) and the file key
// (locomo_exp_user_<dataset index>) are recorded side by side; the capture R2
// namespace is untouched.
//
// Usage: node --experimental-strip-types evals/omnimemeval/research/audits/static-multipath-recall.ts [search-concurrency]

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvironmentFile } from "../../../local-env.ts";
import { loadLocomo } from "../../../benchmarks/loaders.ts";
import {
  buildEligibilityManifest,
  evidenceTextFor,
  hitPositions,
  locomoUserKey,
  pairedComparison,
  sliceByCharBudget,
} from "./locomo-audit-shared.ts";

const root = resolve(import.meta.dirname, "../../../..");
const env = loadEnvironmentFile(resolve(root, ".env.nmg-locomo-audit"));
const dataPath = env.NMG_LOCOMO_DATA;
if (!dataPath || !existsSync(dataPath)) throw new Error("NMG_LOCOMO_DATA missing");
const allCases = loadLocomo(dataPath);
const manifest = buildEligibilityManifest(allCases);
const eligible = new Set(manifest.eligibleIds);
console.error(
  `eligible questions: ${manifest.eligibleIds.length} (sha256 ${manifest.sha256.slice(0, 16)}…)`,
);

// Scope: eligible multi-hop + eligible deterministic regression sample.
const multiHop = allCases.filter(
  (item) => Number(item.officialMetadata.category) === 1 && eligible.has(item.id),
);
const regression = allCases
  .filter(
    (item) => [2, 4].includes(Number(item.officialMetadata.category)) && eligible.has(item.id),
  )
  .filter((_, index) => index % 8 === 0);
const scope = [...multiHop, ...regression];
console.error(`scope: ${multiHop.length} multi-hop + ${regression.length} regression`);

// ── Static decomposition (question text only; deterministic; auditable). ──
const stopwords = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "done",
  "have",
  "has",
  "had",
  "will",
  "would",
  "can",
  "could",
  "should",
  "may",
  "might",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "from",
  "by",
  "with",
  "about",
  "as",
  "into",
  "and",
  "or",
  "but",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "where",
  "when",
  "why",
  "how",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
  "his",
  "her",
  "their",
  "there",
  "here",
  "s",
]);
const aspectLexicon: Record<string, string[]> = {
  where: ["location", "place", "city", "country", "town", "moved", "lives", "visited", "trip"],
  when: [
    "date",
    "time",
    "year",
    "month",
    "week",
    "ago",
    "last",
    "before",
    "after",
    "birthday",
    "anniversary",
  ],
  who: ["person", "friend", "name", "met", "knows", "recommended", "told"],
};
function decompose(question: string): string[] {
  const tokens = question.split(/\s+/u);
  const contentWords = tokens
    .map((token) => token.replace(/[^\p{L}\p{N}'-]/gu, ""))
    .filter((token) => token && !stopwords.has(token.toLowerCase()));
  const entities = contentWords.filter((token, index) => index > 0 && /^[A-Z]/u.test(token));
  const wh = (tokens[0] ?? "").toLowerCase().replace(/\W/gu, "");
  const paths: string[] = [];
  const content = contentWords.slice(0, 10).join(" ");
  if (content && content.toLowerCase() !== question.toLowerCase()) paths.push(content);
  const aspect = aspectLexicon[wh];
  if (aspect)
    paths.push(
      [...new Set([...entities.map((token) => token.toLowerCase()), ...aspect])].join(" "),
    );
  return paths;
}

// ── Worker on the captured R2 state. ──
const onlion = resolve(root, "onlion");
const persist = resolve(onlion, ".runtime/locomo-capture-r2");
if (!existsSync(persist)) throw new Error("capture R2 state missing");
const port = 8791;
const base = `http://127.0.0.1:${port}`;
const worker = spawn(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--config",
    "dist/server/wrangler.json",
    "--local",
    "--persist-to",
    persist,
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--var",
    "NMG_API_KEY:capture-key",
    "--var",
    `NMG_EMBED_PROFILE:${env.NMG_EMBED_PROFILE}`,
    "--var",
    `NMG_EMBED_BASE_URL:${env.NMG_EMBED_BASE_URL}`,
    "--var",
    `NMG_EMBED_MODEL:${env.NMG_EMBED_MODEL}`,
    "--var",
    "NMG_EMBED_API_KEY:local",
  ],
  { cwd: onlion, stdio: ["ignore", "pipe", "pipe"] },
);
let workerLog = "";
worker.stdout.on("data", (chunk: string) => {
  workerLog += chunk;
});
worker.stderr.on("data", (chunk: string) => {
  workerLog += chunk;
});
const stop = () => {
  try {
    execSync(`taskkill /PID ${worker.pid} /T /F`, { stdio: "ignore" });
  } catch {
    /* gone */
  }
};
process.on("exit", stop);
let ready = false;
for (let i = 0; i < 90 && !ready; i += 1) {
  await new Promise((wait) => setTimeout(wait, 1000));
  try {
    ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    /* warming */
  }
}
if (!ready) {
  console.error(workerLog.slice(-3000));
  throw new Error("wrangler dev did not become healthy");
}
console.error("worker ready");

const auth = { "content-type": "application/json", "x-api-key": "capture-key" };
type Raw = { id?: string; content?: string; statement?: string; score?: number };
async function search(userId: string, query: string, requestId: string, topK: number) {
  const startedAt = performance.now();
  const response = await fetch(base + "/search", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ user_id: userId, query, top_k: topK, request_id: requestId }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.json();
  if (response.status !== 200) throw new Error(`search ${response.status}`);
  return {
    memories: (body.data ?? []) as Raw[],
    retrievalMode: body.retrieval_mode as string,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

const chars = (memories: readonly Raw[]) =>
  memories.reduce((sum, memory) => sum + (memory.content ?? memory.statement ?? "").length, 0);
function fuseMax(pathResults: Raw[][], budget: number): Raw[] {
  const byId = new Map<string, Raw>();
  for (const memories of pathResults) {
    for (const memory of memories) {
      const key = String(memory.id);
      const prior = byId.get(key);
      if (!prior || (memory.score ?? 0) > (prior.score ?? 0)) byId.set(key, memory);
    }
  }
  return [...byId.values()]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || String(a.id).localeCompare(String(b.id)))
    .slice(0, budget);
}
function fuseRoundRobin(pathResults: Raw[][], budget: number): Raw[] {
  const seen = new Set<string>();
  const fused: Raw[] = [];
  const depth = Math.max(...pathResults.map((memories) => memories.length), 0);
  for (let rank = 0; rank < depth && fused.length < budget; rank += 1) {
    for (const memories of pathResults) {
      const memory = memories[rank];
      if (!memory || seen.has(String(memory.id))) continue;
      seen.add(String(memory.id));
      fused.push(memory);
      if (fused.length >= budget) break;
    }
  }
  return fused;
}

const outputDirectory = resolve(
  root,
  "evals/locomo/results",
  `static-multipath-v4-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}`,
);
mkdirSync(outputDirectory, { recursive: true });
const rows: Array<Record<string, unknown>> = [];
const rawRows: Array<Record<string, unknown>> = [];
let done = 0;
const queue = [...scope];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const sampleId = String(item.officialMetadata.sampleId);
      const fileKey = locomoUserKey(conversationIndexBySampleId.get(sampleId) ?? -1);
      const derived = decompose(item.question);
      try {
        const armA = await search(sampleId, item.question, `v4-a-${item.id}`, 20);
        const armB = await search(sampleId, item.question, `v4-b-${item.id}`, 100);
        const derived20: Raw[][] = [];
        const derived100: Raw[][] = [];
        for (const [index, query] of derived.entries()) {
          derived20.push(
            (await search(sampleId, query, `v4-d20-${item.id}-${index}`, 20)).memories,
          );
          derived100.push(
            (await search(sampleId, query, `v4-d100-${item.id}-${index}`, 100)).memories,
          );
        }
        const B = armB.memories.slice(0, 20);
        const D20max = fuseMax([armA.memories, ...derived20], 20);
        const D20rr = fuseRoundRobin([armA.memories, ...derived20], 20);
        const D100max = fuseMax([armB.memories, ...derived100], 20);
        const D100rr = fuseRoundRobin([armB.memories, ...derived100], 20);
        const evidenceText = evidenceTextFor(item);
        const positions = (memories: Raw[]) => hitPositions(memories, item, evidenceText);
        const budgetA = chars(armA.memories);
        rows.push({
          id: item.id,
          workerUserId: sampleId,
          fileKey,
          category: item.officialMetadata.category,
          A: {
            hitPositions: positions(armA.memories),
            latencyMs: armA.durationMs,
            contextCharacters: budgetA,
            retrievalMode: armA.retrievalMode,
          },
          B: {
            hitPositions: positions(B),
            latencyMs: armB.durationMs,
            contextCharacters: chars(B),
          },
          D20max: { hitPositions: positions(D20max), contextCharacters: chars(D20max) },
          D20rr: { hitPositions: positions(D20rr), contextCharacters: chars(D20rr) },
          D100max: { hitPositions: positions(D100max), contextCharacters: chars(D100max) },
          D100rr: { hitPositions: positions(D100rr), contextCharacters: chars(D100rr) },
          budgetB: { hitPositions: positions(sliceByCharBudget(armB.memories, budgetA)) },
          budgetD20max: { hitPositions: positions(sliceByCharBudget(D20max, budgetA)) },
          budgetD100max: { hitPositions: positions(sliceByCharBudget(D100max, budgetA)) },
        });
        rawRows.push({
          id: item.id,
          workerUserId: sampleId,
          fileKey,
          raw: {
            A: armA.memories,
            B_full: armB.memories,
            derived20,
            derived100,
            D20max,
            D100max,
          },
        });
      } catch (error) {
        rows.push({ id: item.id, workerUserId: sampleId, fileKey, error: String(error) });
      }
      done += 1;
      if (done % 50 === 0) process.stderr.write(`done ${done}/${scope.length}\n`);
    }
  }),
);

writeFileSync(
  resolve(outputDirectory, "rows.jsonl"),
  `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
);
writeFileSync(
  resolve(outputDirectory, "raw-candidates.jsonl"),
  `${rawRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
);

const valid = rows.filter((row) => !row.error) as Array<Record<string, unknown>>;
const multi = valid.filter((row) => Number(row.category) === 1);
const reg = valid.filter((row) => Number(row.category) !== 1);
const summary = {
  manifestSha256: manifest.sha256,
  eligibleQuestions: manifest.eligibleIds.length,
  scope: { multiHop: multi.length, regression: reg.length },
  multiHop: {
    B: pairedComparison(multi, "A", "B", eligible),
    D20max: pairedComparison(multi, "A", "D20max", eligible),
    D20rr: pairedComparison(multi, "A", "D20rr", eligible),
    D100max: pairedComparison(multi, "A", "D100max", eligible),
    D100rr: pairedComparison(multi, "A", "D100rr", eligible),
  },
  regression: {
    B: pairedComparison(reg, "A", "B", eligible),
    D20max: pairedComparison(reg, "A", "D20max", eligible),
    D100max: pairedComparison(reg, "A", "D100max", eligible),
  },
  textBudgetViews: {
    multiHop: {
      B: pairedComparison(multi, "A", "budgetB", eligible),
      D20max: pairedComparison(multi, "A", "budgetD20max", eligible),
      D100max: pairedComparison(multi, "A", "budgetD100max", eligible),
    },
    regression: {
      B: pairedComparison(reg, "A", "budgetB", eligible),
      D100max: pairedComparison(reg, "A", "budgetD100max", eligible),
    },
  },
};
console.log(JSON.stringify(summary, null, 2));
writeFileSync(resolve(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.error(`done: ${outputDirectory}`);
stop();
