import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { RpcClient } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { cosineSimilarity, HashingVectorEmbedder } from "../../src/core/vector.ts";
import { benchmarkIsolationArgs, counterbalancedOrder } from "../benchmarks/matched.ts";
import { benchmarkCredentialEnvironment } from "../local-env.ts";
import { loadNamesakesEntities, type NamesakesEntity, type NamesakesMention } from "./namesakes.ts";

export type NamesakesAttributionArm = "clean" | "contaminated";

export interface NamesakesAttributionJob {
  testCase: NamesakesAttributionCase;
  arm: NamesakesAttributionArm;
  repeat: number;
}

export interface NamesakesAttributionRecord {
  id: string;
  text: string;
  tag: "Same" | "Other";
}

export interface NamesakesAttributionCase {
  caseId: string;
  pageId: string;
  target: string;
  foreignPageId: string;
  foreignTarget: string;
  candidateScore: number;
  cleanRecords: NamesakesAttributionRecord[];
  contaminatedRecords: NamesakesAttributionRecord[];
  expectedIds: string[];
}

export interface NamesakesAttributionScore {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  exact: boolean;
  acceptedContaminant: boolean;
}

interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

interface ArmResult {
  caseId: string;
  arm: NamesakesAttributionArm;
  repeat: number;
  selectedIds: string[];
  rawResponse: string;
  score: NamesakesAttributionScore;
  durationMs: number;
  tokenUsage?: TokenUsage;
  cached: boolean;
  error?: string;
}

interface NamesakesAgentReport {
  benchmark: "Namesakes-agent-attribution";
  protocolVersion: 2;
  source: string;
  model: string;
  threshold: number;
  cases: number;
  repeats: number;
  arms: number;
  concurrency: number;
  caseManifest: Array<{
    caseId: string;
    target: string;
    foreignTarget: string;
    candidateScore: number;
  }>;
  results: ArmResult[];
  summary: {
    clean: ReturnType<typeof summarizeArm>;
    contaminated: ReturnType<typeof summarizeArm>;
    paired: {
      exactAccuracyDelta: number;
      precisionDelta: number;
      recallDelta: number;
      newlyWrongPairs: number;
      newlyCorrectPairs: number;
      mcnemarExactPValue: number;
      contaminantAcceptanceRate: number;
    };
    byRepeat: Array<{
      repeat: number;
      cleanExactAccuracy: number;
      contaminatedExactAccuracy: number;
      delta: number;
    }>;
    providerTokens: TokenUsage;
    liveCalls: number;
    cacheHits: number;
  };
  limitations: string[];
}

const root = resolve(import.meta.dirname, "../..");
const PROMPT_VERSION = "namesakes-attribution-v3-cross-page-repeated";
const MODEL = "deepseek/deepseek-v4-flash";

/**
 * Construct paired clean/contaminated cases from official Same/Other labels.
 * An `Other` mention is used only to resolve a different row whose title is an
 * exact normalized match. The injected text then comes from that foreign
 * entity's own page; target-page paragraphs are never mislabeled as foreign.
 */
export function buildNamesakesAttributionCases(
  rows: readonly NamesakesEntity[],
  options: { threshold?: number; limit?: number; contextRadius?: number } = {},
): NamesakesAttributionCase[] {
  const threshold = options.threshold ?? 0.7;
  const limit = options.limit ?? 20;
  const radius = options.contextRadius ?? 240;
  const embedder = new HashingVectorEmbedder();
  const cases: NamesakesAttributionCase[] = [];
  const rowsByTitle = indexRowsByTitle(rows);

  for (const row of rows) {
    const same = row.entities.filter((mention) => mention.tag === "Same");
    const other = row.entities.filter((mention) => mention.tag === "Other");
    if (same.length < 2 || other.length === 0) continue;

    const anchor = same[0]!;
    const anchorVector = embedder.embed(contextFor(row.text, anchor, radius));
    const contaminant = other
      .flatMap((mention) => {
        const matches = (rowsByTitle.get(normalizeName(mention.text)) ?? []).filter(
          (candidate) => String(candidate.pageid) !== String(row.pageid),
        );
        if (matches.length !== 1) return [];
        const foreignRow = matches[0]!;
        const foreignAnchor = foreignRow.entities.find((candidate) => candidate.tag === "Same");
        if (!foreignAnchor) return [];
        return [
          {
            foreignRow,
            foreignAnchor,
            score: cosineSimilarity(
              anchorVector,
              embedder.embed(contextFor(foreignRow.text, foreignAnchor, radius)),
            ),
          },
        ];
      })
      .filter((candidate) => candidate.score >= threshold)
      .sort((left, right) => right.score - left.score)[0];
    if (!contaminant) continue;

    const selectedSame = same.slice(0, 3);
    const cleanRecords = selectedSame.map((mention, index) => ({
      id: `S${index + 1}`,
      text: contextFor(row.text, mention, radius),
      tag: "Same" as const,
    }));
    const contaminatedRecords = [
      ...cleanRecords,
      {
        id: "X1",
        text: contextFor(contaminant.foreignRow.text, contaminant.foreignAnchor, radius),
        tag: "Other" as const,
      },
    ];
    cases.push({
      caseId: `namesakes:${String(row.pageid)}`,
      pageId: String(row.pageid),
      target: row.title,
      foreignPageId: String(contaminant.foreignRow.pageid),
      foreignTarget: contaminant.foreignRow.title,
      candidateScore: contaminant.score,
      cleanRecords,
      contaminatedRecords,
      expectedIds: cleanRecords.map((record) => record.id),
    });
    if (cases.length >= limit) break;
  }
  return cases;
}

export function namesakesAttributionPrompt(
  testCase: NamesakesAttributionCase,
  arm: NamesakesAttributionArm,
): string {
  const records = arm === "clean" ? testCase.cleanRecords : testCase.contaminatedRecords;
  return [
    "You audit retrieved long-term memory records for entity attribution.",
    "Select every record that describes the target entity itself, and reject records about a different entity with a similar or identical name.",
    'Use only the supplied text. Do not use tools. Return exactly one JSON object in this shape: {"selected_ids":["R1"]}.',
    `Target entity: ${testCase.target}`,
    "Candidate records:",
    ...records.map((record) => `[${record.id}] ${record.text}`),
  ].join("\n\n");
}

export function parseSelectedIds(response: string): string[] {
  const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  const object = (fenced ?? response).match(/\{[\s\S]*\}/u)?.[0];
  if (!object) throw new Error("response does not contain a JSON object");
  const parsed = JSON.parse(object) as { selected_ids?: unknown };
  if (
    !Array.isArray(parsed.selected_ids) ||
    parsed.selected_ids.some((id) => typeof id !== "string")
  ) {
    throw new Error("selected_ids must be an array of strings");
  }
  return [...new Set(parsed.selected_ids.map((id) => id.trim()).filter(Boolean))];
}

export function scoreNamesakesAttribution(
  selectedIds: readonly string[],
  expectedIds: readonly string[],
): NamesakesAttributionScore {
  const selected = new Set(selectedIds);
  const expected = new Set(expectedIds);
  const truePositives = [...selected].filter((id) => expected.has(id)).length;
  const falsePositives = selected.size - truePositives;
  const falseNegatives = expected.size - truePositives;
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision: ratio(truePositives, selected.size),
    recall: ratio(truePositives, expected.size),
    exact: falsePositives === 0 && falseNegatives === 0,
    acceptedContaminant: selected.has("X1"),
  };
}

export function buildNamesakesAttributionJobs(
  cases: readonly NamesakesAttributionCase[],
  repeats: number,
): NamesakesAttributionJob[] {
  const jobs: NamesakesAttributionJob[] = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    for (const testCase of cases) {
      const arms = counterbalancedOrder<NamesakesAttributionArm>(
        ["clean", "contaminated"],
        `${testCase.caseId}:${repeat}`,
      );
      jobs.push(...arms.map((arm) => ({ testCase, arm, repeat })));
    }
  }
  return jobs;
}

async function main(): Promise<void> {
  const source = resolve(
    process.env.NMG_NAMESAKES_DATA ?? ".benchmarks/namesakes/data/Namesakes_entities.jsonl",
  );
  const threshold = finiteNumber(process.env.NMG_NAMESAKES_AGENT_THRESHOLD, 0.7);
  const limit = positiveInteger(process.env.NMG_NAMESAKES_AGENT_CASES, 20);
  const repeats = Math.min(10, positiveInteger(process.env.NMG_NAMESAKES_AGENT_REPEATS, 1));
  const concurrency = Math.min(4, positiveInteger(process.env.NMG_NAMESAKES_AGENT_CONCURRENCY, 2));
  const rows = await loadNamesakesEntities(source);
  const cases = buildNamesakesAttributionCases(rows, { threshold, limit });
  if (cases.length === 0) throw new Error("Namesakes produced no attribution cases");

  const jobs = buildNamesakesAttributionJobs(cases, repeats);
  const results = await runJobs(jobs, concurrency);
  results.sort(
    (left, right) =>
      left.caseId.localeCompare(right.caseId) ||
      left.repeat - right.repeat ||
      left.arm.localeCompare(right.arm),
  );
  const clean = results.filter((result) => result.arm === "clean");
  const contaminated = results.filter((result) => result.arm === "contaminated");
  const cleanSummary = summarizeArm(clean);
  const contaminatedSummary = summarizeArm(contaminated);
  const newlyWrongPairs = pairedCount(clean, contaminated, true, false);
  const newlyCorrectPairs = pairedCount(clean, contaminated, false, true);
  const report: NamesakesAgentReport = {
    benchmark: "Namesakes-agent-attribution",
    protocolVersion: 2,
    source,
    model: MODEL,
    threshold,
    cases: cases.length,
    repeats,
    arms: results.length,
    concurrency,
    caseManifest: cases.map((testCase) => ({
      caseId: testCase.caseId,
      target: testCase.target,
      foreignTarget: testCase.foreignTarget,
      candidateScore: testCase.candidateScore,
    })),
    results,
    summary: {
      clean: cleanSummary,
      contaminated: contaminatedSummary,
      paired: {
        exactAccuracyDelta: contaminatedSummary.exactAccuracy - cleanSummary.exactAccuracy,
        precisionDelta: contaminatedSummary.meanPrecision - cleanSummary.meanPrecision,
        recallDelta: contaminatedSummary.meanRecall - cleanSummary.meanRecall,
        newlyWrongPairs,
        newlyCorrectPairs,
        mcnemarExactPValue: mcnemarExactPValue(newlyWrongPairs, newlyCorrectPairs),
        contaminantAcceptanceRate: ratio(
          contaminated.filter((result) => result.score.acceptedContaminant).length,
          contaminated.length,
        ),
      },
      byRepeat: Array.from({ length: repeats }, (_, repeat) => {
        const cleanAccuracy = summarizeArm(
          clean.filter((result) => result.repeat === repeat),
        ).exactAccuracy;
        const contaminatedAccuracy = summarizeArm(
          contaminated.filter((result) => result.repeat === repeat),
        ).exactAccuracy;
        return {
          repeat,
          cleanExactAccuracy: cleanAccuracy,
          contaminatedExactAccuracy: contaminatedAccuracy,
          delta: contaminatedAccuracy - cleanAccuracy,
        };
      }),
      providerTokens: sumUsage(results),
      liveCalls: results.filter((result) => !result.cached).length,
      cacheHits: results.filter((result) => result.cached).length,
    },
    limitations: [
      "The official labels score attribution, not complete open-domain question answering.",
      "Each contaminated arm injects one high-scoring record from a uniquely resolved foreign page; real nodes may contain several contaminants.",
      "A small fixed entity sample with repeated stochastic model calls is diagnostic, not a population estimate.",
    ],
  };
  const output = resolve(
    process.env.NMG_NAMESAKES_AGENT_REPORT ?? "evals/topology/results/namesakes-agent-latest.json",
  );
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output, ...report.summary }, null, 2)}\n`);
}

async function runJobs(
  jobs: readonly NamesakesAttributionJob[],
  concurrency: number,
): Promise<ArmResult[]> {
  const results = new Array<ArmResult>(jobs.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      const client = createClient();
      await client.start();
      try {
        while (true) {
          const index = cursor++;
          if (index >= jobs.length) return;
          const job = jobs[index]!;
          results[index] = await runArm(client, job.testCase, job.arm, job.repeat);
        }
      } finally {
        await client.stop();
      }
    }),
  );
  return results;
}

async function runArm(
  client: RpcClient,
  testCase: NamesakesAttributionCase,
  arm: NamesakesAttributionArm,
  repeat: number,
): Promise<ArmResult> {
  const prompt = namesakesAttributionPrompt(testCase, arm);
  const cachePath = cacheFile(testCase, arm, repeat, prompt);
  if (existsSync(cachePath)) {
    return { ...(JSON.parse(readFileSync(cachePath, "utf8")) as ArmResult), cached: true };
  }
  await client.newSession();
  const started = performance.now();
  let rawResponse = "";
  let selectedIds: string[] = [];
  let events: AgentSessionEvent[] = [];
  let error: string | undefined;
  try {
    events = await client.promptAndWait(prompt, undefined, 300_000);
    rawResponse = (await client.getLastAssistantText())?.trim() ?? "";
    selectedIds = parseSelectedIds(rawResponse);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const result: ArmResult = {
    caseId: testCase.caseId,
    arm,
    repeat,
    selectedIds,
    rawResponse,
    score: scoreNamesakesAttribution(selectedIds, testCase.expectedIds),
    durationMs: Math.round(performance.now() - started),
    tokenUsage: collectTokenUsage(events),
    cached: false,
    ...(error ? { error } : {}),
  };
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function createClient(): RpcClient {
  const stateRoot = resolve(root, ".benchmarks/namesakes/pi-state");
  mkdirSync(stateRoot, { recursive: true });
  return new RpcClient({
    cliPath: resolve(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    cwd: root,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    env: {
      ...definedEnvironment(),
      PI_CODING_AGENT_DIR: mkdtempSync(resolve(stateRoot, "agent-")),
    },
    args: [
      "--offline",
      "--approve",
      "--no-session",
      ...benchmarkIsolationArgs(),
      "--model",
      MODEL,
      "--thinking",
      "off",
    ],
  });
}

function cacheFile(
  testCase: NamesakesAttributionCase,
  arm: NamesakesAttributionArm,
  repeat: number,
  prompt: string,
): string {
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        version: PROMPT_VERSION,
        model: MODEL,
        caseId: testCase.caseId,
        arm,
        repeat,
        prompt,
      }),
    )
    .digest("hex");
  return resolve(root, ".benchmarks/namesakes/agent-cache", `${key}.json`);
}

function contextFor(text: string, mention: NamesakesMention, radius: number): string {
  const start = Math.max(0, mention.start - radius);
  const end = Math.min(text.length, mention.end + radius);
  return `${text.slice(start, mention.start)}[MENTION: ${mention.text}]${text.slice(mention.end, end)}`
    .replace(/\s+/gu, " ")
    .trim();
}

function indexRowsByTitle(rows: readonly NamesakesEntity[]): Map<string, NamesakesEntity[]> {
  const index = new Map<string, NamesakesEntity[]>();
  for (const row of rows) {
    for (const name of new Set([row.title, row.pagename])) {
      const key = normalizeName(name);
      const matches = index.get(key) ?? [];
      if (!matches.some((candidate) => String(candidate.pageid) === String(row.pageid))) {
        matches.push(row);
      }
      index.set(key, matches);
    }
  }
  return index;
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "");
}

function collectTokenUsage(events: readonly AgentSessionEvent[]): TokenUsage | undefined {
  const total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let found = false;
  for (const event of events) {
    if (event.type !== "message_end" || event.message.role !== "assistant") continue;
    found = true;
    total.input += event.message.usage.input;
    total.output += event.message.usage.output;
    total.cacheRead += event.message.usage.cacheRead;
    total.cacheWrite += event.message.usage.cacheWrite;
    total.total += event.message.usage.totalTokens;
  }
  return found ? total : undefined;
}

function summarizeArm(results: readonly ArmResult[]) {
  const exact = results.filter((result) => result.score.exact).length;
  return {
    observations: results.length,
    exactAccuracy: ratio(exact, results.length),
    exactAccuracyWilson95: wilson95(exact, results.length),
    meanPrecision: mean(results.map((result) => result.score.precision)),
    meanRecall: mean(results.map((result) => result.score.recall)),
    meanDurationMs: mean(results.map((result) => result.durationMs)),
    errors: results.filter((result) => result.error).length,
  };
}

function pairedCount(
  clean: readonly ArmResult[],
  contaminated: readonly ArmResult[],
  cleanExact: boolean,
  contaminatedExact: boolean,
): number {
  const contaminatedByPair = new Map(
    contaminated.map((result) => [`${result.caseId}:${result.repeat}`, result]),
  );
  return clean.filter((result) => {
    const paired = contaminatedByPair.get(`${result.caseId}:${result.repeat}`);
    return result.score.exact === cleanExact && paired?.score.exact === contaminatedExact;
  }).length;
}

function wilson95(successes: number, total: number): { lower: number; upper: number } {
  if (total === 0) return { lower: 0, upper: 0 };
  const z = 1.959963984540054;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = proportion + (z * z) / (2 * total);
  const margin =
    z * Math.sqrt((proportion * (1 - proportion)) / total + (z * z) / (4 * total * total));
  return {
    lower: (centre - margin) / denominator,
    upper: (centre + margin) / denominator,
  };
}

export function mcnemarExactPValue(leftOnly: number, rightOnly: number): number {
  const discordant = leftOnly + rightOnly;
  if (discordant === 0) return 1;
  const tail = Math.min(leftOnly, rightOnly);
  let cumulative = 0;
  for (let successes = 0; successes <= tail; successes += 1) {
    cumulative += binomialCoefficient(discordant, successes) / 2 ** discordant;
  }
  return Math.min(1, 2 * cumulative);
}

function binomialCoefficient(n: number, k: number): number {
  const smaller = Math.min(k, n - k);
  let value = 1;
  for (let index = 1; index <= smaller; index += 1) {
    value = (value * (n - smaller + index)) / index;
  }
  return value;
}

function sumUsage(results: readonly ArmResult[]): TokenUsage {
  return results.reduce<TokenUsage>(
    (total, result) => ({
      input: total.input + (result.tokenUsage?.input ?? 0),
      output: total.output + (result.tokenUsage?.output ?? 0),
      cacheRead: total.cacheRead + (result.tokenUsage?.cacheRead ?? 0),
      cacheWrite: total.cacheWrite + (result.tokenUsage?.cacheWrite ?? 0),
      total: total.total + (result.tokenUsage?.total ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  );
}

function definedEnvironment(): Record<string, string> {
  return {
    ...benchmarkCredentialEnvironment(root),
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
