// Capture LoCoMo retrieval through the onlion service entry (/add + /search).
//
// Runs `wrangler dev` (local simulated R2) on the built onlion worker, ingests
// each LoCoMo conversation as one user (mirroring the online full-run
// ingestion: speaker-prefixed content, role from the speaker mapping), then
// searches every question through POST /search with the deployed retrieval
// profile (QPP second pass, chain expansion, top-k 20). Output matches
// audit-locomo-retrieval.ts input plus a per-question detail file with
// evidence hit positions. No reader or judge model is called.
//
// Usage: node --experimental-strip-types evals/omnimemeval/research/audits/capture-locomo-retrieval-onlion.ts [search-concurrency]
// Requires: local BGE server on NMG_EMBED_BASE_URL (see .env.nmg-locomo-audit),
// a built onlion worker (onlion/dist/server).

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvironmentFile } from "../../../local-env.ts";
import { loadLocomo } from "../../../benchmarks/loaders.ts";
import { evidenceTextFor, hitPositions, locomoUserKey } from "./locomo-audit-shared.ts";

const root = resolve(import.meta.dirname, "../../../..");
const env = loadEnvironmentFile(resolve(root, ".env.nmg-locomo-audit"));
for (const key of ["NMG_EMBED_BASE_URL", "NMG_EMBED_MODEL"]) {
  if (!env[key])
    throw new Error(`${key} missing; start the local BGE server and check .env.nmg-locomo-audit`);
}

const dataPath = [
  env.NMG_LOCOMO_DATA,
  resolve(root, "evals/locomo/data/locomo10.json"),
  resolve(root, ".benchmarks/official/LoCoMo/data/locomo10.json"),
].find((path) => path && existsSync(path));
if (!dataPath) throw new Error("locomo10.json not found (set NMG_LOCOMO_DATA)");
const cases = loadLocomo(dataPath);
console.error(`loaded ${cases.length} questions from ${dataPath}`);

// One conversation per user_id, ingested once. officialMetadata.sampleId is
// the online run's user key (locomo_exp_user_N).
const conversations = new Map<
  string,
  { sampleId: string; sessions: (typeof cases)[number]["sessions"] }
>();
for (const item of cases) {
  const sampleId = String(item.officialMetadata.sampleId);
  if (!conversations.has(sampleId))
    conversations.set(sampleId, { sampleId, sessions: item.sessions });
}
const userKeyBySampleId = new Map(
  [...conversations.keys()].map((sampleId, index) => [sampleId, locomoUserKey(index)]),
);
console.error(`${conversations.size} conversations`);

const runId = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
const outputDirectory = resolve(root, "evals/locomo/results", `locomo-retrieval-onlion-${runId}`);
mkdirSync(outputDirectory, { recursive: true });

const onlion = resolve(root, "onlion");
const persist = resolve(onlion, ".runtime/locomo-capture-r2");
rmSync(persist, { recursive: true, force: true });
const port = 8791;
const base = `http://127.0.0.1:${port}`;
const wranglerArgs = [
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
];
const worker = spawn(process.execPath, wranglerArgs, {
  cwd: onlion,
  stdio: ["ignore", "pipe", "pipe"],
});
const workerOutput: string[] = [];
worker.stdout.on("data", (chunk) => workerOutput.push(chunk));
worker.stderr.on("data", (chunk) => workerOutput.push(chunk));
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
    /* not up yet */
  }
}
if (!ready) {
  console.error(workerOutput.join("").slice(-4000));
  throw new Error("wrangler dev did not become healthy");
}
console.error(`worker ready (pid ${worker.pid})`);

const auth = { "content-type": "application/json", "x-api-key": "capture-key" };
async function post(path: string, payload: unknown, timeoutMs = 180_000) {
  const startedAt = performance.now();
  const response = await fetch(base + path, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const responseBody = await response.json();
  return {
    status: response.status,
    body: responseBody,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

const isoTime = (value: string | undefined) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
};

// ── Ingestion: speaker-prefixed content, per-session batches of ≤32. ──
let added = 0;
for (const { sampleId, sessions } of conversations.values()) {
  for (const [sessionIndex, session] of sessions.entries()) {
    const chatTime = isoTime(session.date);
    for (let offset = 0; offset < session.turns.length; offset += 32) {
      const batch = session.turns.slice(offset, offset + 32).map((turn) => ({
        role: turn.role,
        content: turn.speaker ? `${turn.speaker}: ${turn.content}` : turn.content,
        ...(chatTime ? { chat_time: chatTime } : {}),
      }));
      const result = await post("/add", {
        user_id: sampleId,
        session_id: session.id,
        request_id: `locomo-capture-${sampleId}-${sessionIndex}-${offset}`,
        messages: batch,
      });
      if (result.status !== 200 || result.body.status !== "completed") {
        stop();
        throw new Error(
          `add failed ${result.status}: ${JSON.stringify(result.body).slice(0, 300)}`,
        );
      }
      added += result.body.added ?? 0;
    }
  }
  process.stderr.write(`[${sampleId}] ingested (${added} messages total)\n`);
}
console.error(`ingestion complete: ${added} messages`);
const datasetTurns = [...conversations.values()].reduce(
  (sum, conversation) =>
    sum + conversation.sessions.reduce((count, session) => count + session.turns.length, 0),
  0,
);
if (added !== datasetTurns) {
  throw new Error(
    `ingestion incomplete: worker accepted ${added} of ${datasetTurns} dataset turns`,
  );
}

// ── Search every scored question (category 5 is excluded by the audit). ──
const searchConcurrency = Number(process.argv[2] ?? "4");
const queue = cases.filter((item) => Number(item.officialMetadata.category) !== 5);
const results: Record<string, Array<{ query: string; context: string; duration_ms: number }>> = {};
const details: Array<Record<string, unknown>> = [];
let failures = 0;
let lexical = 0;
let done = 0;
await Promise.all(
  Array.from({ length: searchConcurrency }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const sampleId = String(item.officialMetadata.sampleId);
      let response;
      try {
        response = await post("/search", {
          user_id: sampleId,
          query: item.question,
          top_k: 20,
          request_id: `locomo-q-${item.id}`,
        });
        if (response.status !== 200)
          throw new Error(
            `status ${response.status}: ${JSON.stringify(response.body).slice(0, 200)}`,
          );
      } catch (error) {
        failures += 1;
        details.push({
          id: item.id,
          category: item.officialMetadata.category,
          error: String(error),
        });
        continue;
      }
      const memories = response.body.data ?? [];
      if (response.body.retrieval_mode !== "records") lexical += 1;
      const context = memories
        .map(
          (memory: { content?: string; statement?: string }) => memory.content ?? memory.statement,
        )
        .join("\n");
      const userKey = userKeyBySampleId.get(sampleId) ?? sampleId;
      (results[userKey] ??= []).push({
        query: item.question,
        context,
        duration_ms: response.durationMs,
      });
      details.push({
        id: item.id,
        category: item.officialMetadata.category,
        evidenceIds: item.evidenceIds,
        hitPositions: hitPositions(memories, item, evidenceTextFor(item)),
        retrieved: memories.length,
        retrievalMode: response.body.retrieval_mode,
        durationMs: response.durationMs,
      });
      done += 1;
      if (done % 100 === 0)
        process.stderr.write(
          `searched ${done}/${queue.length} (failures ${failures}, lexical ${lexical})\n`,
        );
    }
  }),
);

writeFileSync(
  resolve(outputDirectory, "search-results.json"),
  `${JSON.stringify(results, null, 2)}\n`,
);
writeFileSync(
  resolve(outputDirectory, "details.jsonl"),
  `${details.map((row) => JSON.stringify(row)).join("\n")}\n`,
);
writeFileSync(
  resolve(outputDirectory, "capture-summary.json"),
  `${JSON.stringify({ runId, added, failures, lexical, questions: details.length }, null, 2)}\n`,
);
console.log(
  JSON.stringify({ outputDirectory, added, failures, lexical, questions: details.length }, null, 2),
);
stop();
