// Pseudo-relevance-feedback recall path over the onlion entry (no LLM, no gold).
//
// The question-derived static paths (static-multipath-recall.ts) were flat:
// missing hops share no surface with the question at all. This probe tests the
// remaining deterministic lever: query expansion from the retrieval itself
// (classic PRF). Path 1 = original query; path 2 = content words of the top-3
// hits of path 1 (pseudo-relevance feedback). Fuse under the same final top-20.
//
// Usage: node --experimental-strip-types evals/omnimemeval/research/audits/static-prf-recall.ts

import { spawn, execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvironmentFile } from "../../../local-env.ts";
import { loadLocomo } from "../../../benchmarks/loaders.ts";

const root = resolve(import.meta.dirname, "../../../..");
const env = loadEnvironmentFile(resolve(root, ".env.nmg-locomo-audit"));
const allCases = loadLocomo(env.NMG_LOCOMO_DATA);
const multiHop = allCases.filter((item) => Number(item.officialMetadata.category) === 1);

const captureDir = resolve(
  root,
  "evals/locomo/results/locomo-retrieval-onlion-2026-10-23T08-30-01",
);
const baselineRows = readFileSync(resolve(captureDir, "details.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const baselineByQuestion = new Map(baselineRows.map((row) => [row.id, row]));

const onlion = resolve(root, "onlion");
const persist = resolve(onlion, ".runtime/locomo-capture-r2");
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
worker.stdout.on("data", (chunk) => {
  workerLog += chunk;
});
worker.stderr.on("data", (chunk) => {
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

const auth = { "content-type": "application/json", "x-api-key": "capture-key" };
async function search(userId, query, requestId) {
  const response = await fetch(base + "/search", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ user_id: userId, query, top_k: 20, request_id: requestId }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.json();
  if (response.status !== 200) throw new Error(`search ${response.status}`);
  return body.data ?? [];
}

const normalize = (value) => value.toLowerCase().replace(/\s+/gu, " ").trim();
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
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "will",
  "would",
  "can",
  "could",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "from",
  "by",
  "with",
  "and",
  "or",
  "but",
  "that",
  "this",
  "it",
  "its",
  "his",
  "her",
  "their",
  "there",
  "so",
  "just",
  "really",
  "very",
  "much",
  "lot",
  "like",
  "get",
  "got",
  "one",
  "you",
  "your",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "yeah",
  "okay",
  "well",
  "thanks",
  "thank",
  "wow",
  "hey",
  "oh",
]);
function contentWords(text, limit = 14) {
  return [
    ...new Set(
      text
        .split(/\s+/u)
        .map((token) => token.replace(/[^\p{L}\p{N}'-]/gu, ""))
        .filter((token) => token.length > 2 && !stopwords.has(token.toLowerCase())),
    ),
  ]
    .slice(0, limit)
    .join(" ");
}
function evidenceTextFor(item) {
  const map = new Map();
  for (const session of item.sessions) {
    for (const turn of session.turns) {
      map.set(
        turn.sourceId,
        normalize(turn.speaker ? `${turn.speaker}: ${turn.content}` : turn.content),
      );
    }
  }
  return map;
}
function hitPositions(memories, item, evidenceText) {
  const contents = memories.map((memory) => normalize(memory.content ?? memory.statement ?? ""));
  return (item.evidenceIds ?? []).map((evidenceId) => {
    const text = evidenceText.get(evidenceId);
    return text === undefined ? -2 : contents.findIndex((content) => content.includes(text));
  });
}
function fuseMax(lists, budget) {
  const byId = new Map();
  for (const memories of lists) {
    for (const memory of memories) {
      const prior = byId.get(memory.id);
      if (!prior || (memory.score ?? 0) > (prior.score ?? 0)) byId.set(memory.id, memory);
    }
  }
  return [...byId.values()]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || String(a.id).localeCompare(String(b.id)))
    .slice(0, budget);
}

const outputDirectory = resolve(
  root,
  "evals/locomo/results",
  `static-prf-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}`,
);
mkdirSync(outputDirectory, { recursive: true });
const rows = [];
let done = 0;
const queue = [...multiHop];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const sampleId = String(item.officialMetadata.sampleId);
      try {
        const first = await search(sampleId, item.question, `prf1-${item.id}`);
        const feedback = first
          .slice(0, 3)
          .map((memory) => memory.content ?? memory.statement ?? "")
          .join(" ");
        const expansion = contentWords(feedback);
        let second = [];
        if (expansion) second = await search(sampleId, expansion, `prf2-${item.id}`);
        const fused = fuseMax([first, second], 20);
        const evidenceText = evidenceTextFor(item);
        rows.push({
          id: item.id,
          expansion,
          baseline: baselineByQuestion.get(item.id)?.hitPositions ?? null,
          prf: { hitPositions: hitPositions(fused, item, evidenceText), fused: fused.length },
        });
      } catch (error) {
        rows.push({ id: item.id, error: String(error) });
      }
      done += 1;
      if (done % 60 === 0) process.stderr.write(`done ${done}/${multiHop.length}\n`);
    }
  }),
);

writeFileSync(
  resolve(outputDirectory, "prf-rows.jsonl"),
  `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
);
function coverage(rowsSubset, key) {
  let any = 0,
    all = 0,
    hits = 0,
    total = 0,
    n = 0;
  for (const row of rowsSubset) {
    const value = row[key];
    const positions = Array.isArray(value) ? value : value?.hitPositions;
    if (!Array.isArray(positions) || positions.some((rank) => rank === -2)) continue;
    const found = positions.filter((rank) => rank >= 0);
    n += 1;
    any += found.length > 0 ? 1 : 0;
    all += found.length === positions.length ? 1 : 0;
    hits += found.length;
    total += positions.length;
  }
  return {
    n,
    anyPct: +((100 * any) / n).toFixed(1),
    allPct: +((100 * all) / n).toFixed(1),
    recallPct: +((100 * hits) / total).toFixed(1),
  };
}
const valid = rows.filter((row) => !row.error);
const summary = {
  multiHop: {
    baseline: coverage(valid, "baseline"),
    prfFused: coverage(valid, "prf"),
  },
};
console.log(JSON.stringify(summary, null, 2));
writeFileSync(resolve(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.error(`done: ${outputDirectory}`);
stop();
