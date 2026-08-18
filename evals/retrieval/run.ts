/**
 * Formalized retrieval-quality benchmark runner.
 *
 * Runs the production retrieval pipeline (OmniMemEval bridge → store.searchContext,
 * the same call path verified for the benchmark integration) against pinned
 * datasets and reports rank-aware metrics (recall@k, MRR) plus the legacy
 * audit-compatible coverage rates. Default mode is fully offline and
 * deterministic: lexical retrieval, no LLM judge, no embedding endpoint.
 *
 * Usage:
 *   npm run eval:retrieval -- [--dataset locomo,longmemeval,beam|all]
 *     [--full] [--limit N] [--skip-ingest] [--hybrid] [--summaries] [--topK N] [--out DIR]
 *
 * --summaries runs the leaf-block semantic-summary pass after ingest (NMG_SUMMARY_*
 * or NMG_JUDGE_* env) and routes queries over the block summary index.
 *
 * Stores live under .benchmarks/retrieval-stores/<dataset>/ (gitignored) and
 * are reused when the ingest manifest (dataset sha256 + sample rule) matches.
 * Reports land in evals/results/retrieval/<run-id>/ (gitignored).
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createEmbeddingClientFromEnv } from "../../src/core/embedding-provider.ts";
import { NmgStore } from "../../src/core/store.ts";
import {
  createLeafSummaryProviderFromEnv,
  drainLeafSummaries,
  LEAF_SUMMARY_PROMPT_VERSION,
} from "../../src/integration/leaf-summarizer.ts";
import {
  OmniMemEvalBridge,
  type OmniRetrievedMemory,
} from "../omnimemeval/bridge.ts";
import { loadDataset, type DatasetSpec } from "./datasets.ts";
import {
  aggregateByCategory,
  scoreQuestion,
  type AggregateMetrics,
  type ScoredQuestion,
} from "./score.ts";

const STORES_ROOT = resolve(".benchmarks/retrieval-stores");
const RESULTS_ROOT = resolve("evals/results/retrieval");
const RECALL_KS = [1, 5, 10, 20] as const;
const DEFAULT_TOP_K = 20;

/** Pinned retrieval configuration (bridge defaults), recorded in the manifest. */
const PINNED_RETRIEVAL = {
  secondPass: true,
  maxTier: 3,
  graphHops: 1,
  tieredDisclosure: true,
  progressiveWarmDisclosure: false,
  expandChains: true,
} as const;

interface CliOptions {
  datasets: Array<DatasetSpec["name"]>;
  full: boolean;
  limit?: number;
  skipIngest: boolean;
  hybrid: boolean;
  summaries: boolean;
  topK: number;
  out?: string;
}

interface BridgeSearchResult {
  text: string;
  retrievalMode: string;
  memories: OmniRetrievedMemory[];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const runId = new Date().toISOString().replace(/[:.]/gu, "-");
  const outDir = resolve(options.out ?? resolve(RESULTS_ROOT, runId));
  mkdirSync(outDir, { recursive: true });

  const embeddingClient = options.hybrid ? createEmbeddingClientFromEnv() : undefined;
  if (options.hybrid && !embeddingClient) {
    throw new Error("--hybrid requires NMG_EMBED_* environment variables");
  }
  const summaryProvider = options.summaries ? createLeafSummaryProviderFromEnv() : undefined;
  if (options.summaries && !summaryProvider) {
    throw new Error("--summaries requires NMG_SUMMARY_* (or NMG_JUDGE_*) environment variables");
  }

  const report: Record<string, unknown> = {
    manifest: buildManifest(options, embeddingClient?.indexId, summaryProvider?.model),
    datasets: {} as Record<string, unknown>,
  };
  const datasetReports = report.datasets as Record<string, unknown>;

  for (const name of options.datasets) {
    console.log(`\n== dataset: ${name} ==`);
    const spec = loadDataset(name, { full: options.full, limit: options.limit });
    console.log(
      `loaded ${spec.questions.length} questions, ${spec.conversations.length} conversations (${spec.sampleNote})`,
    );
    const storeRoot = await ensureIngested(spec, options.skipIngest);
    let summariesGenerated: number | undefined;
    if (summaryProvider) {
      summariesGenerated = await ensureSummaries(storeRoot, summaryProvider);
      console.log(`leaf summaries ready (+${summariesGenerated} generated this run)`);
    }
    const bridge = new OmniMemEvalBridge(storeRoot, {
      embeddingClient,
      leafBlockRouting: options.summaries,
    });
    try {
      const scored = await retrieveAndScore(bridge, spec, options.topK);
      const metrics = aggregateByCategory(scored, RECALL_KS);
      datasetReports[name] = { metrics, questions: scored, ...(summariesGenerated !== undefined ? { summariesGenerated } : {}) };
      printTable(name, metrics);
    } finally {
      bridge.close();
    }
  }

  writeFileSync(resolve(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(resolve(outDir, "table.md"), renderMarkdown(report), "utf8");
  console.log(`\nreport written to ${outDir}`);
}

async function retrieveAndScore(
  bridge: OmniMemEvalBridge,
  spec: DatasetSpec,
  topK: number,
): Promise<Array<ScoredQuestion & { id: string; query: string }>> {
  const scored: Array<ScoredQuestion & { id: string; query: string }> = [];
  let requestId = 0;
  for (const [index, question] of spec.questions.entries()) {
    const startedAt = performance.now();
    const result = (await bridge.handle({
      id: requestId += 1,
      op: "search",
      userId: question.userId,
      query: question.query,
      topK,
    })) as BridgeSearchResult;
    const durationMs = performance.now() - startedAt;
    const candidates = result.memories.map((memory) =>
      [memory.statement, memory.evidenceExcerpt ?? ""].filter((part) => part.length > 0),
    );
    scored.push({
      id: question.id,
      query: question.query,
      ...scoreQuestion(
        {
          category: question.category,
          golds: question.golds,
          candidates,
          contextText: result.text,
          durationMs,
        },
        spec.direction,
      ),
    });
    if ((index + 1) % 100 === 0) console.log(`  searched ${index + 1}/${spec.questions.length}`);
  }
  return scored;
}

async function ensureIngested(spec: DatasetSpec, skipIngest: boolean): Promise<string> {
  const storeRoot = resolve(STORES_ROOT, spec.name);
  const manifestPath = resolve(STORES_ROOT, `${spec.name}.ingest.json`);
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>)
    : null;
  const reusable =
    manifest !== null &&
    manifest.sha256 === spec.sha256 &&
    manifest.sampleNote === spec.sampleNote &&
    existsSync(storeRoot);

  if (reusable) {
    console.log(`reusing ingested stores at ${storeRoot}`);
    return storeRoot;
  }
  if (skipIngest) {
    throw new Error(
      `--skip-ingest: no matching ingest manifest at ${manifestPath} (run without it first)`,
    );
  }

  console.log(`ingesting ${spec.conversations.length} conversations into ${storeRoot} …`);
  rmSync(storeRoot, { recursive: true, force: true });
  mkdirSync(storeRoot, { recursive: true });
  return ingestNow(spec, storeRoot, manifestPath);
}

/** Ingestion runs in its own bridge instance so it can be async without
 *  entangling the retrieval bridge's store cache. */
async function ingestNow(
  spec: DatasetSpec,
  storeRoot: string,
  manifestPath: string,
): Promise<string> {
  const bridge = new OmniMemEvalBridge(storeRoot);
  try {
    let requestId = 0;
    for (const [index, conversation] of spec.conversations.entries()) {
      await bridge.handle({
        id: requestId += 1,
        op: "add",
        userId: conversation.userId,
        conversationId: conversation.conversationId,
        messages: conversation.messages,
      });
      if ((index + 1) % 200 === 0) {
        console.log(`  ingested ${index + 1}/${spec.conversations.length}`);
      }
    }
  } finally {
    bridge.close();
  }
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        sha256: spec.sha256,
        sampleNote: spec.sampleNote,
        conversations: spec.conversations.length,
        questions: spec.questions.length,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return storeRoot;
}

/** Post-ingest summary pass: rebuild leaf blocks (ingestion only enqueues
 *  write deltas) and drain pending semantic summaries for every per-user
 *  store. Idempotent — on reused stores only stale/new blocks cost LLM calls.
 *  Returns how many summaries were generated this run. */
async function ensureSummaries(
  storeRoot: string,
  provider: NonNullable<ReturnType<typeof createLeafSummaryProviderFromEnv>>,
): Promise<number> {
  const databases = readdirSync(storeRoot).filter((entry) => entry.endsWith(".sqlite"));
  let generated = 0;
  for (const [index, database] of databases.entries()) {
    const store = new NmgStore(resolve(storeRoot, database));
    try {
      store.rebuildLeafBlocks();
      const result = await drainLeafSummaries(store, provider, { batch: 32 });
      generated += result.summarized;
    } finally {
      store.close();
    }
    if ((index + 1) % 50 === 0) {
      console.log(`  summarized stores ${index + 1}/${databases.length} (+${generated})`);
    }
  }
  return generated;
}

function buildManifest(
  options: CliOptions,
  indexId: string | undefined,
  summaryModel: string | undefined,
): Record<string, unknown> {
  return {
    createdAt: new Date().toISOString(),
    nmg: nmgVersion(),
    git: gitState(),
    node: process.version,
    retrieval: {
      mode: options.hybrid ? "hybrid" : "lexical",
      ...(indexId ? { indexId } : {}),
      topK: options.topK,
      recallKs: [...RECALL_KS],
      ...PINNED_RETRIEVAL,
      leafBlockRouting: options.summaries,
      ...(options.summaries
        ? {
            leafSummaries: {
              model: summaryModel ?? "unknown",
              promptVersion: LEAF_SUMMARY_PROMPT_VERSION,
            },
          }
        : {}),
    },
    sampling: {
      full: options.full,
      limit: options.limit ?? null,
      pinnedDefaults: "locomo=all 10 users, longmemeval=first 100 questions, beam=all 20 conversations",
    },
  };
}

function nmgVersion(): string {
  try {
    return (JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version?: string })
      .version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function gitState(): { commit: string; dirty: boolean } {
  try {
    const commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim().length > 0;
    return { commit, dirty };
  } catch {
    return { commit: "unknown", dirty: true };
  }
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function metricRow(label: string, metrics: AggregateMetrics): string {
  const cells = [
    label,
    String(metrics.questionsWithGolds),
    ...RECALL_KS.map((k) => percent(metrics.recallAt[String(k)] ?? 0)),
    percent(metrics.anyEvidenceRate),
    percent(metrics.allEvidenceRate),
    metrics.mrrQuestion.toFixed(3),
    percent(metrics.legacy.evidenceRecall),
    String(Math.round(metrics.meanContextChars)),
    metrics.latencyMs.p50.toFixed(0),
  ];
  return `| ${cells.join(" | ")} |`;
}

const TABLE_HEADER =
  "| slice | questions | R@1 | R@5 | R@10 | R@20 | any@20 | all@20 | MRR(Q) | legacy evid | ctx chars | p50 ms |\n" +
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";

function printTable(name: string, metrics: Record<string, AggregateMetrics>): void {
  console.log(TABLE_HEADER);
  for (const [category, value] of Object.entries(metrics)) {
    console.log(metricRow(category === "overall" ? `${name} (overall)` : category, value));
  }
}

function renderMarkdown(report: Record<string, unknown>): string {
  const lines = ["# NMG retrieval quality (pinned protocol)", ""];
  const manifest = report.manifest as Record<string, unknown>;
  lines.push("```json", JSON.stringify(manifest, null, 2), "```", "");
  const datasets = report.datasets as Record<string, { metrics: Record<string, AggregateMetrics> }>;
  for (const [name, dataset] of Object.entries(datasets)) {
    lines.push(`## ${name}`, "", TABLE_HEADER);
    for (const [category, metrics] of Object.entries(dataset.metrics)) {
      lines.push(metricRow(category, metrics));
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    datasets: ["locomo", "longmemeval", "beam"],
    full: false,
    skipIngest: false,
    hybrid: false,
    summaries: false,
    topK: DEFAULT_TOP_K,
  };
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case "--dataset": {
        const value = args[++index];
        if (!value) throw new Error("--dataset requires a value");
        if (value !== "all") {
          options.datasets = value.split(",").map((name) => {
            const trimmed = name.trim();
            if (trimmed !== "locomo" && trimmed !== "longmemeval" && trimmed !== "beam") {
              throw new Error(`unknown dataset: ${trimmed}`);
            }
            return trimmed;
          });
        }
        break;
      }
      case "--full":
        options.full = true;
        break;
      case "--limit":
        options.limit = Number(args[++index]);
        if (!Number.isInteger(options.limit) || options.limit <= 0) {
          throw new Error("--limit requires a positive integer");
        }
        break;
      case "--skip-ingest":
        options.skipIngest = true;
        break;
      case "--hybrid":
        options.hybrid = true;
        break;
      case "--summaries":
        options.summaries = true;
        break;
      case "--topK":
        options.topK = Number(args[++index]);
        if (!Number.isInteger(options.topK) || options.topK <= 0) {
          throw new Error("--topK requires a positive integer");
        }
        break;
      case "--out":
        options.out = args[++index];
        if (!options.out) throw new Error("--out requires a directory");
        break;
      default:
        throw new Error(`unknown option: ${args[index]}`);
    }
  }
  return options;
}

await main();
