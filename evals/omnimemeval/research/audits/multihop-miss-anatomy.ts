// Multi-hop failure anatomy on top of the onlion-entry capture.
//
// Restarts `wrangler dev` against the capture's persisted R2 state, re-searches
// every category-1 (multi-hop) question with top_k=100, and reports where the
// hops missing at top-20 land: ranks 21-100 (crowding-out — decomposition or a
// larger budget can recover them) versus not found at all (the query never
// reaches them — needs different query expression). Prints a small case sample
// for manual reading. No reader or judge model is called.
//
// Usage: node --experimental-strip-types evals/omnimemeval/research/audits/multihop-miss-anatomy.ts

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvironmentFile } from "../../../local-env.ts";
import { loadLocomo } from "../../../benchmarks/loaders.ts";
import { hitPositions } from "./locomo-audit-shared.ts";

const root = resolve(import.meta.dirname, "../../../..");
const env = loadEnvironmentFile(resolve(root, ".env.nmg-locomo-audit"));
const dataPath = env.NMG_LOCOMO_DATA;
if (!dataPath || !existsSync(dataPath)) throw new Error("NMG_LOCOMO_DATA missing");
const cases = loadLocomo(dataPath).filter((item) => Number(item.officialMetadata.category) === 1);
console.error(`${cases.length} multi-hop questions`);

const runId = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
const outputDirectory = resolve(root, "evals/locomo/results", `multihop-miss-anatomy-${runId}`);
mkdirSync(outputDirectory, { recursive: true });

const onlion = resolve(root, "onlion");
const persist = resolve(onlion, ".runtime/locomo-capture-r2");
if (!existsSync(persist)) throw new Error("capture R2 state missing; rerun capture first");
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
console.error("worker ready");

const auth = { "content-type": "application/json", "x-api-key": "capture-key" };
const normalize = (value) => value.toLowerCase().replace(/\s+/gu, " ").trim();

const rows: Array<{ id: string; question: string; ranks: number[]; top6: string[] }> = [];
let done = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (;;) {
      const item = cases.shift();
      if (!item) return;
      const sampleId = String(item.officialMetadata.sampleId);
      const response = await fetch(base + "/search", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          user_id: sampleId,
          query: item.question,
          top_k: 100,
          request_id: `mh-${item.id}`,
        }),
        signal: AbortSignal.timeout(180_000),
      });
      const body = await response.json();
      const memories = (body.data ?? []).map((memory) =>
        normalize(memory.content ?? memory.statement ?? ""),
      );
      const evidenceText = new Map();
      for (const session of item.sessions) {
        for (const turn of session.turns) {
          const ingested = turn.speaker ? `${turn.speaker}: ${turn.content}` : turn.content;
          evidenceText.set(turn.sourceId, normalize(ingested));
        }
      }
      const ranks = hitPositions(
        (body.data ?? []).map((memory: { content?: string; statement?: string }) => memory),
        item,
        evidenceText,
      );
      rows.push({
        id: item.id,
        question: item.question,
        ranks,
        top6: (body.data ?? [])
          .slice(0, 6)
          .map((memory) => memory.content ?? memory.statement ?? ""),
      });
      done += 1;
      if (done % 50 === 0) process.stderr.write(`searched ${done}/${cases.length + done}\n`);
    }
  }),
);

writeFileSync(
  resolve(outputDirectory, "multihop-k100.jsonl"),
  `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
);

// Aggregate: hops missing at top-20 — where do they sit at top-100?
let hops = 0,
  inTop20 = 0,
  crowded = 0,
  unreachable = 0,
  labelMissing = 0;
let questionsAll20 = 0,
  questionsAll100 = 0,
  questionsAny100 = 0;
for (const row of rows) {
  const valid = row.ranks.filter((rank) => rank !== -2);
  const missingAt20 = valid.filter((rank) => rank < 0).length;
  questionsAll20 += missingAt20 === 0 && valid.length > 0 ? 1 : 0;
  questionsAll100 += valid.every((rank) => rank >= 0) && valid.length > 0 ? 1 : 0;
  questionsAny100 += valid.some((rank) => rank >= 0) ? 1 : 0;
  labelMissing += row.ranks.length - valid.length;
  for (const rank of valid) {
    hops += 1;
    if (rank >= 0 && rank < 20) inTop20 += 1;
    else if (rank >= 20) crowded += 1;
    else unreachable += 1;
  }
}
const summary = {
  questions: rows.length,
  hops,
  hopRankSplit: { inTop20, ranks21to100: crowded, notFoundAt100: unreachable, labelMissing },

  allAt20: questionsAll20,
  allAt100: questionsAll100,
  anyAt100: questionsAny100,
};
console.log(JSON.stringify(summary, null, 2));
writeFileSync(resolve(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

// Case sample for manual reading: 3 miss-1, 3 miss-2+, 2 fully-missed.
const sample = [];
const pick = (count, filter) => rows.filter(filter).slice(0, count);
for (const row of [
  ...pick(2, (row) => row.ranks.every((rank) => rank === -1)),
  ...pick(3, (row) => row.ranks.filter((rank) => rank === -1).length === 1),
  ...pick(
    3,
    (row) =>
      row.ranks.filter((rank) => rank === -1).length >= 2 && row.ranks.some((rank) => rank >= 0),
  ),
]) {
  sample.push({ question: row.question, ranks: row.ranks, top6: row.top6 });
}
writeFileSync(resolve(outputDirectory, "case-sample.json"), `${JSON.stringify(sample, null, 2)}\n`);
console.error(`done: ${outputDirectory}`);
stop();
