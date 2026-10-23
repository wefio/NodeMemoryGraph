// Does a fourth retrieval dimension earn its request?
//
// The v4 multipath arm used three clauses: the question, its content words, and
// an entity-plus-aspect probe that only exists for Wh-type questions. This probe
// adds a different axis — the question's capitalised entities alone — retrieves
// it against the same captured store, and fuses four clauses by highest score
// per memory id, keeping the page at twenty.
//
// It self-checks by rebuilding the recorded three-clause arm from the recorded
// candidate lists and failing when it does not match, so a four-clause gain
// cannot come from a different fusion rule.
//
// Usage:
//   node --experimental-strip-types evals/omnimemeval/research/audits/clause-dimension-probe.ts --dry-run
//   node --experimental-strip-types evals/omnimemeval/research/audits/clause-dimension-probe.ts --out evals/locomo/results/clause-dimension-<runId>

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadEnvironmentFile } from "../../../local-env.ts";
import { loadLocomo } from "../../../benchmarks/loaders.ts";
import {
  buildEligibilityManifest,
  coverage,
  evidenceTextFor,
  hitPositions,
  pairedComparison,
} from "./locomo-audit-shared.ts";
import { pairedBinomialP } from "./clause-ablation.ts";

type Candidate = { id?: string; content?: string; statement?: string; score?: number };

const STOPWORDS = new Set([
  "where",
  "when",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "why",
  "how",
  "did",
  "does",
  "do",
  "was",
  "were",
  "is",
  "are",
  "has",
  "have",
  "had",
  "the",
  "a",
  "an",
  "in",
  "on",
  "at",
  "to",
  "for",
  "from",
  "by",
  "with",
  "about",
  "and",
  "or",
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
  "many",
  "much",
  "long",
  "often",
]);

/** The question's capitalised entity tokens, lowercased, in order. A question
 * without any capitalised token falls back to its longest content word, so the
 * clause always exists. */
export function entityClause(question: string): string {
  const tokens = question
    .split(/\s+/u)
    .map((token) => token.replace(/[^\p{L}\p{N}'-]/gu, ""))
    .filter(Boolean);
  const entities = tokens.filter((token, index) => index > 0 && /^[A-Z]/u.test(token));
  // Possessives name the same entity: "Caroline's" becomes "caroline".
  if (entities.length > 0)
    return [...new Set(entities.map((token) => token.toLowerCase().replace(/'s$/u, "")))].join(" ");
  const content = tokens.filter((token) => token && !STOPWORDS.has(token.toLowerCase()));
  const longest = content.sort((a, b) => b.length - a.length)[0];
  if (!longest) throw new Error(`no usable token in question: ${question}`);
  return longest.toLowerCase();
}

/** Reciprocal-rank fusion: each list contributes 1/(60+rank), so a clause that
 * returns high raw scores for a short query cannot dominate the page. */
export function fuseByRank(lists: readonly (readonly Candidate[])[], budget: number): Candidate[] {
  const byId = new Map<string, { candidate: Candidate; score: number }>();
  for (const list of lists) {
    list.forEach((candidate, rank) => {
      const key = String(candidate.id);
      const prior = byId.get(key);
      const contribution = 1 / (60 + rank);
      if (!prior) byId.set(key, { candidate, score: contribution });
      else prior.score += contribution;
    });
  }
  return [...byId.values()]
    .sort(
      (a, b) => b.score - a.score || String(a.candidate.id).localeCompare(String(b.candidate.id)),
    )
    .slice(0, budget)
    .map((entry) => entry.candidate);
}

/** Min-max normalise each list to [0,1] before taking the highest score, so
 * score scale differences between clauses do not decide the page. */
export function fuseByNormalizedScore(
  lists: readonly (readonly Candidate[])[],
  budget: number,
): Candidate[] {
  const normalised: Candidate[][] = lists.map((list) => {
    const scores = list.map((candidate) => candidate.score ?? 0);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const span = max - min || 1;
    return list.map((candidate) => ({
      ...candidate,
      score: ((candidate.score ?? 0) - min) / span,
    }));
  });
  return fuseByMaxScore(normalised, budget);
}

export function fuseByMaxScore(
  lists: readonly (readonly Candidate[])[],
  budget: number,
): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const list of lists) {
    for (const candidate of list) {
      const key = String(candidate.id);
      const prior = byId.get(key);
      if (!prior || (candidate.score ?? 0) > (prior.score ?? 0)) byId.set(key, candidate);
    }
  }
  return [...byId.values()]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || String(a.id).localeCompare(String(b.id)))
    .slice(0, budget);
}

type Args = {
  out: string;
  workers: number;
  port: number;
  topK: number;
  pageBudget: number;
  envFile: string;
  dryRun: boolean;
  limit: number;
};

function readCli(): Args {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      workers: { type: "string", default: "4" },
      port: { type: "string", default: "8795" },
      "top-k": { type: "string", default: "100" },
      "page-budget": { type: "string", default: "20" },
      "env-file": { type: "string", default: ".env.nmg-locomo-audit" },
      limit: { type: "string", default: "0" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const int = (value: string | undefined, fallback: number, name: string): number => {
    const parsed = Number(value ?? fallback);
    if (!Number.isInteger(parsed) || parsed < 0)
      throw new Error(`${name} must be a non-negative integer`);
    return parsed;
  };
  return {
    out:
      values.out ??
      `evals/locomo/results/clause-dimension-${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}`,
    workers: int(values.workers, 4, "--workers") || 1,
    port: int(values.port, 8795, "--port"),
    topK: int(values["top-k"], 100, "--top-k"),
    pageBudget: int(values["page-budget"], 20, "--page-budget") || 20,
    envFile: values["env-file"]!,
    dryRun: values["dry-run"] === true,
    limit: int(values.limit, 0, "--limit"),
  };
}

async function main(): Promise<void> {
  const args = readCli();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const env = loadEnvironmentFile(resolve(root, args.envFile));
  const dataPath = env.NMG_LOCOMO_DATA;
  if (!dataPath) throw new Error(`${args.envFile} must set NMG_LOCOMO_DATA`);

  const cases = loadLocomo(dataPath);
  const byId = new Map(cases.map((item) => [item.id, item]));
  const manifest = buildEligibilityManifest(cases);
  const eligible = new Set(manifest.eligibleIds);

  const recorded = new Map<
    string,
    { A?: Candidate[]; B_full?: Candidate[]; derived100?: Candidate[][]; D100max?: Candidate[] }
  >();
  const rawPath = resolve(
    root,
    "evals/locomo/results/static-multipath-v4-2026-10-23T10-29-58/raw-candidates.jsonl",
  );
  for (const line of readFileSync(rawPath, "utf8").trim().split("\n")) {
    const row = JSON.parse(line) as { id: string; raw: Record<string, unknown> };
    recorded.set(row.id, row.raw as never);
  }

  const scope = cases.filter(
    (item) =>
      Number(item.officialMetadata.category) === 1 &&
      eligible.has(item.id) &&
      recorded.has(item.id),
  );
  const selected = args.limit > 0 ? scope.slice(0, args.limit) : scope;
  if (selected.length === 0) throw new Error("no multi-hop questions in scope");

  const clauses = selected.map((item) => ({
    id: item.id,
    question: item.question,
    clause: entityClause(item.question),
  }));
  console.log(
    JSON.stringify(
      { scope: scope.length, selected: selected.length, topK: args.topK, port: args.port },
      null,
      2,
    ),
  );
  if (args.dryRun) {
    console.log(JSON.stringify(clauses.slice(0, 6), null, 2));
    return;
  }

  const onlion = resolve(root, "onlion");
  const persist = resolve(onlion, ".runtime/locomo-capture-r2");
  if (!existsSync(persist)) throw new Error("capture R2 state missing");
  const base = `http://127.0.0.1:${args.port}`;
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
      String(args.port),
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
  worker.stdout.on("data", (chunk: Buffer) => {
    workerLog += chunk;
  });
  worker.stderr.on("data", (chunk: Buffer) => {
    workerLog += chunk;
  });
  const stop = (): void => {
    try {
      execSync(`taskkill /PID ${worker.pid} /T /F`, { stdio: "ignore" });
    } catch {
      // already gone
    }
  };
  process.on("exit", stop);

  let ready = false;
  for (let attempt = 0; attempt < 90 && !ready; attempt += 1) {
    await new Promise((wait) => setTimeout(wait, 1_000));
    try {
      ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })).ok;
    } catch {
      // warming
    }
  }
  if (!ready) {
    console.error(workerLog.slice(-3_000));
    throw new Error("wrangler dev did not become healthy");
  }
  console.error("worker ready");

  const auth = { "content-type": "application/json", "x-api-key": "capture-key" };
  const rows: Array<Record<string, unknown>> = [];
  const queue = [...clauses];
  let done = 0;
  await Promise.all(
    Array.from({ length: args.workers }, async () => {
      for (;;) {
        const entry = queue.shift();
        if (!entry) return;
        const item = byId.get(entry.id)!;
        const sampleId = String(item.officialMetadata.sampleId);
        const response = await fetch(`${base}/search`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            user_id: sampleId,
            query: entry.clause,
            top_k: args.topK,
            request_id: `cd-${entry.id}`,
          }),
          signal: AbortSignal.timeout(180_000),
        });
        if (response.status !== 200) throw new Error(`search ${response.status} for ${entry.id}`);
        const body = (await response.json()) as { data?: Candidate[] };
        const fourth = body.data ?? [];
        const recordedRow = recorded.get(entry.id)!;
        const three = [recordedRow.B_full ?? [], ...(recordedRow.derived100 ?? [])];
        const evidence = evidenceTextFor(item);
        const fused3 = fuseByMaxScore(three, args.pageBudget);
        const fused4 = fuseByMaxScore([...three, fourth], args.pageBudget);
        const fused4rrf = fuseByRank([...three, fourth], args.pageBudget);
        const fused4norm = fuseByNormalizedScore([...three, fourth], args.pageBudget);
        // Self-check: three clauses rebuilt from the recording must equal the
        // recorded three-clause arm; otherwise four clauses is a different rule.
        if (
          JSON.stringify(hitPositions(fused3, item, evidence)) !==
          JSON.stringify(hitPositions(recordedRow.D100max ?? [], item, evidence))
        ) {
          throw new Error(`${entry.id}: recorded three-clause arm does not reproduce`);
        }
        rows.push({
          id: entry.id,
          clause: entry.clause,
          fourthLength: fourth.length,
          fourth,
          A: { hitPositions: hitPositions(recordedRow.A ?? [], item, evidence) },
          fused3: { hitPositions: hitPositions(fused3, item, evidence) },
          fused4: { hitPositions: hitPositions(fused4, item, evidence) },
          fused4rrf: { hitPositions: hitPositions(fused4rrf, item, evidence) },
          fused4norm: { hitPositions: hitPositions(fused4norm, item, evidence) },
        });
        done += 1;
        if (done % 50 === 0) process.stderr.write(`searched ${done}/${done + queue.length}\n`);
      }
    }),
  );
  stop();

  const withP = (arm: string, base_: string) => {
    const paired = pairedComparison(rows, base_, arm, eligible);
    return { ...paired, p: pairedBinomialP(paired.wins, paired.losses) };
  };
  const summary = {
    measuredAt: new Date().toISOString(),
    scope: "multi-hop",
    questions: rows.length,
    pageBudget: args.pageBudget,
    topK: args.topK,
    clause: "question entities alone",
    fourVsThreeMax: withP("fused4", "fused3"),
    fourVsThreeRrf: withP("fused4rrf", "fused3"),
    fourVsThreeNormalized: withP("fused4norm", "fused3"),
    fourVsA: withP("fused4", "A"),
    threeVsA: withP("fused3", "A"),
    coverage: {
      A: coverage(rows, "A"),
      fused3: coverage(rows, "fused3"),
      fused4: coverage(rows, "fused4"),
      fused4rrf: coverage(rows, "fused4rrf"),
      fused4norm: coverage(rows, "fused4norm"),
    },
    fourthEmptyClauses: rows.filter((row) => Number(row.fourthLength) === 0).length,
  };
  const outDir = resolve(root, args.out);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    resolve(outDir, "rows.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
  writeFileSync(resolve(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ out: outDir, summary }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
