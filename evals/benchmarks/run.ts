import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { RpcClient } from "@earendil-works/pi-coding-agent";

import { NmgStore } from "../../src/core/store.ts";
import { HashingVectorEmbedder, cosineSimilarity } from "../../src/core/vector.ts";
import { indexExternalEmbeddings } from "../external-embeddings.ts";
import { computeCitationSignal } from "../official/citation.ts";
import { resolveBenchmarkData } from "../official/data-path.ts";
import { gitRevision, sampleFingerprint } from "../official/reproducibility.ts";
import { benchmarkParametersFromEnvironment } from "../official/parameters.ts";
import { benchmarkCredentialEnvironment } from "../local-env.ts";
import { collectAgentRunTelemetry } from "../agent-telemetry.ts";
import { loadBeam, loadLocomo, loadPersonaMem, stratifiedSample } from "./loaders.ts";
import {
  benchmarkIsolationArgs,
  controllerMatchedEnvironment,
  isMatchedMode,
  matchedUserPrompt,
  MATCHED_MODES,
} from "./matched.ts";
import {
  installControllerCandidate,
  loadControllerCandidate,
  readControllerActuation,
} from "./controller-candidate.ts";
import type { BenchmarkCase, BenchmarkSession } from "./types.ts";

type Benchmark = "beam" | "locomo" | "personamem";
type Mode =
  | "flat-hybrid"
  | "matched"
  | "nmg-auto"
  | "nmg-candidate"
  | "nmg-deterministic"
  | "nmg-graph"
  | "nmg-nodes"
  | "nmg-shadow"
  | "no-memory"
  | "raw-session"
  | "validate";
type EvaluationMode = Exclude<Mode, "matched" | "validate">;

const root = resolve(import.meta.dirname, "../..");
const benchmark = parseBenchmark(process.argv[2]);
const mode = parseMode(process.argv[3]);
const perCategory = positiveInteger(process.argv[4] ?? "1");
const allCases = loadCases(benchmark);
const stratified = stratifiedSample(allCases, perCategory);
const selected = process.env.NMG_BENCH_CASE
  ? stratified.filter((item) => item.id === process.env.NMG_BENCH_CASE)
  : stratified;
if (selected.length === 0) {
  throw new Error("NMG_BENCH_CASE did not match the selected stratified sample");
}

if (mode === "validate") {
  const summary = {
    benchmark,
    cases: allCases.length,
    selected: selected.length,
    selectedIds: selected.map((item) => item.id),
    categories: Object.fromEntries(
      [...new Set(allCases.map((item) => item.category))]
        .sort()
        .map((category) => [
          category,
          allCases.filter((item) => item.category === category).length,
        ]),
    ),
    caseSessionReferences: allCases.reduce((sum, item) => sum + item.sessions.length, 0),
    caseTurnReferences: allCases.reduce(
      (sum, item) =>
        sum + item.sessions.reduce((count, session) => count + session.turns.length, 0),
      0,
    ),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(0);
}

const controllerCandidate =
  mode === "matched" || mode === "nmg-candidate"
    ? loadControllerCandidate(requiredControllerCandidatePath())
    : null;

const runId = new Date().toISOString().replaceAll(":", "-");
const outputDirectory = resolve(root, "evals", benchmark, "results", runId);
mkdirSync(outputDirectory, { recursive: true });
const modes: EvaluationMode[] = mode === "matched" ? [...MATCHED_MODES] : [mode];

const results = (
  await mapConcurrent(selected, concurrency(), async (item) => {
    const seedDirectory = resolve(outputDirectory, "nmg-seed", safeName(item.id));
    const needsNmg = modes.some((itemMode) => itemMode.startsWith("nmg-"));
    const remembered = needsNmg ? ingest(item, seedDirectory) : 0;
    if (needsNmg && process.env.NMG_EMBED_BASE_URL) await indexExternalEmbeddings(seedDirectory);
    const rows = [];
    for (let repeat = 0; repeat < repeats(); repeat += 1) {
      for (const itemMode of modes) {
        const dataDirectory = itemMode.startsWith("nmg-")
          ? resolve(outputDirectory, "arms", safeName(item.id), itemMode, String(repeat))
          : undefined;
        if (dataDirectory) cpSync(seedDirectory, dataDirectory, { recursive: true });
        if (dataDirectory && itemMode === "nmg-candidate") {
          installControllerCandidate(controllerCandidate!, dataDirectory);
        }
        process.stderr.write(`[${benchmark}] ${item.id} ${itemMode} repeat=${repeat}: start\n`);
        rows.push(await evaluate(item, itemMode, dataDirectory, remembered, repeat));
        process.stderr.write(`[${benchmark}] ${item.id} ${itemMode} repeat=${repeat}: done\n`);
      }
    }
    return rows;
  })
).flat();

const report = {
  runId,
  benchmark,
  model: "deepseek/deepseek-v4-flash",
  codeRevision: gitRevision(root),
  sampleFingerprint: sampleFingerprint(
    selected.map((item) => ({
      id: item.id,
      category: item.category,
      question: item.question,
      reference: item.reference,
    })),
  ),
  protocolScoring: "separate",
  scoringCommand: `npm run benchmark:score -- ${benchmark} ${outputDirectory}`,
  leaderboardComparable: false,
  perCategory,
  repeats: repeats(),
  contextCharacterBudget: contextBudget(),
  benchmarkParameters: benchmarkParametersFromEnvironment(),
  matchedProtocol:
    mode === "matched"
      ? {
          arms: modes,
          invariant: "same case, model, thinking level, user prompt, and initial NMG corpus",
          onlyDifference:
            "no extension vs deterministic NMG vs the same NMG path with one frozen trained controller candidate",
          controllerCandidate: controllerCandidate
            ? {
                sha256: controllerCandidate.sha256,
                featureProtocolVersion: controllerCandidate.featureProtocolVersion,
                trainingSteps: controllerCandidate.trainingSteps,
              }
            : null,
          armEnvironments: {
            "nmg-deterministic": controllerMatchedEnvironment("nmg-deterministic"),
            "nmg-candidate": controllerMatchedEnvironment("nmg-candidate"),
          },
          controllerAffectsRanking: results.some(
            (row) => row.mode === "nmg-candidate" && (row.controllerActuation?.changed ?? 0) > 0,
          ),
        }
      : null,
  results,
  byMode: Object.fromEntries(
    modes.map((itemMode) => {
      const rows = results.filter((row) => row.mode === itemMode);
      return [itemMode, { total: rows.length }];
    }),
  ),
};
writeFileSync(resolve(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(
  resolve(outputDirectory, "predictions.jsonl"),
  `${results.map((row) => JSON.stringify(row)).join("\n")}\n`,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function evaluate(
  item: BenchmarkCase,
  itemMode: EvaluationMode,
  dataDirectory: string | undefined,
  remembered: number,
  repeat: number,
) {
  const startedAt = performance.now();
  const retrieval = contextFor(item, itemMode);
  const client = createClient(dataDirectory, itemMode);
  const prompt = answerPrompt(item, itemMode, retrieval.text);
  let hypothesis = "";
  let answerError: string | null = null;
  let promptDurationMs: number | null = null;
  let telemetry = collectAgentRunTelemetry([]);
  try {
    await client.start();
    await client.setThinkingLevel("low");
    const promptStartedAt = performance.now();
    const events = await client.promptAndWait(prompt, undefined, timeout());
    promptDurationMs = Math.round(performance.now() - promptStartedAt);
    telemetry = collectAgentRunTelemetry(events);
    hypothesis = (await client.getLastAssistantText())?.trim() ?? "";
  } catch (error) {
    answerError = error instanceof Error ? error.message : String(error);
  } finally {
    await client.stop();
  }
  return {
    id: item.id,
    category: item.category,
    mode: itemMode,
    repeat,
    question: item.question,
    reference: item.reference,
    hypothesis,
    rubric: item.rubric,
    evidenceIds: item.evidenceIds,
    retrievedEvidenceIds: retrieval.sourceIds,
    officialMetadata: item.officialMetadata,
    answerError,
    remembered,
    injectedCharacters: retrieval.text.length,
    userPromptHash: createHash("sha256").update(prompt).digest("hex"),
    sourceTurns: item.sessions.reduce((sum, session) => sum + session.turns.length, 0),
    promptDurationMs,
    durationMs: Math.round(performance.now() - startedAt),
    toolCalls: telemetry.toolCalls,
    toolRounds: telemetry.toolRounds,
    tokenUsage: telemetry.tokenUsage,
    citation: retrieval.sourceIds
      ? {
          citedCount: computeCitationSignal(hypothesis, retrieval.evidenceById).citedCount,
          totalRetrieved: retrieval.sourceIds.length,
        }
      : null,
    controllerActuation: readControllerActuation(dataDirectory),
  };
}

function ingest(item: BenchmarkCase, dataDirectory: string): number {
  mkdirSync(dataDirectory, { recursive: true });
  const store = new NmgStore(resolve(dataDirectory, "nmg.sqlite"));
  let count = 0;
  let previousNodeId: string | undefined;
  try {
    for (const session of item.sessions) {
      const nodeName = `${item.benchmark} ${item.id} ${session.id}`;
      const nodeSummary = session.turns
        .map((turn) => `${turn.speaker ?? turn.role}: ${turn.content}`)
        .join(" ")
        .slice(0, 1_500);
      let nodeId: string | undefined;
      for (const turn of session.turns) {
        const saved = store.remember({
          statement: `${turn.speaker ?? turn.role}: ${turn.content}`,
          nodeName,
          nodeSummary,
          memoryType: "conversation_evidence",
          sourceActor: turn.role,
          truthStatus: turn.role === "user" ? "asserted" : "unverified",
          evidence: turn.content,
          eventTime: session.date,
          sourceRef: `${item.benchmark.toLocaleLowerCase()}:${item.id}:${turn.sourceId}`,
          tier: 2,
          importance: item.evidenceIds?.includes(turn.sourceId) ? 0.9 : 0.5,
          scope: {
            benchmark: item.benchmark,
            case: item.id,
          },
        });
        nodeId = saved.node.id;
        count += 1;
      }
      if (previousNodeId && nodeId) {
        store.linkNodes({ sourceNodeId: previousNodeId, targetNodeId: nodeId, type: "related_to" });
      }
      previousNodeId = nodeId;
    }
  } finally {
    store.close();
  }
  return count;
}

function contextFor(
  item: BenchmarkCase,
  itemMode: EvaluationMode,
): { text: string; sourceIds: string[] | null; evidenceById: Map<string, string> } {
  if (itemMode === "no-memory" || itemMode.startsWith("nmg-")) {
    return {
      text: "",
      sourceIds: itemMode === "no-memory" ? [] : null,
      evidenceById: new Map(),
    };
  }
  if (itemMode === "raw-session") {
    const ranked = item.sessions
      .map((session) => ({
        text: formatSession(session),
        sourceText: session.turns
          .map((turn) => `${turn.speaker ?? turn.role}: ${turn.content}`)
          .join(" "),
        score: lexicalOverlap(item.question, formatSession(session)),
      }))
      .sort((left, right) => right.score - left.score);
    return withinBudget(ranked);
  }
  const embedder = new HashingVectorEmbedder(256);
  const query = embedder.embed(item.question);
  const turns = item.sessions
    .flatMap((session) =>
      session.turns.map((turn) => {
        const text = `[${session.date ?? session.id}] ${turn.speaker ?? turn.role}: ${turn.content}`;
        return {
          text,
          sourceIds: [turn.sourceId],
          textForCitation: `${turn.speaker ?? turn.role}: ${turn.content}`,
          score:
            lexicalOverlap(item.question, text) * 0.55 +
            cosineSimilarity(query, embedder.embed(text)) * 0.45,
        };
      }),
    )
    .sort((left, right) => right.score - left.score);
  return withinBudget(turns);
}

function answerPrompt(item: BenchmarkCase, itemMode: EvaluationMode, context: string): string {
  if (isMatchedMode(itemMode) || itemMode === "nmg-auto") {
    return matchedUserPrompt(item);
  }
  return [
    "Answer concisely using only the available conversation evidence.",
    "If the evidence is missing, explicitly say you do not know.",
    ...(itemMode === "nmg-nodes" || itemMode === "nmg-graph"
      ? ["Search NMG through maxTier 3 and call nmg_get for selected evidence before answering."]
      : []),
    item.options?.length ? `Options:\n${item.options.join("\n")}` : "",
    context ? `Retrieved conversation evidence:\n${context}` : "",
    `Question: ${item.question}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function createClient(dataDirectory?: string, itemMode?: EvaluationMode): RpcClient {
  const piStateRoot = resolve(outputDirectory, "pi-state");
  mkdirSync(piStateRoot, { recursive: true });
  const piAgentDirectory = mkdtempSync(resolve(piStateRoot, "agent-"));
  return new RpcClient({
    cliPath: resolve(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    cwd: root,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    env: {
      ...definedEnvironment(),
      PI_CODING_AGENT_DIR: piAgentDirectory,
      ...(dataDirectory ? { NMG_DATA_DIR: dataDirectory } : {}),
      ...(isMatchedMode(itemMode) ? controllerMatchedEnvironment(itemMode) : {}),
      ...(itemMode === "nmg-shadow" ? { NMG_CONTROLLER_SHADOW: "1" } : {}),
      ...(itemMode === "nmg-nodes" ? { NMG_GRAPH_HOPS: "0" } : {}),
      ...(itemMode === "nmg-graph" ? { NMG_GRAPH_HOPS: "1" } : {}),
    },
    args: [
      "--offline",
      "--approve",
      "--no-session",
      ...benchmarkIsolationArgs(
        dataDirectory ? resolve(root, ".pi/extensions/nmg/index.ts") : undefined,
      ),
      "--model",
      "deepseek/deepseek-v4-flash",
      "--thinking",
      "off",
    ],
  });
}

function loadCases(value: Benchmark): BenchmarkCase[] {
  if (value === "locomo") {
    return loadLocomo(
      resolveBenchmarkData("LoCoMo", process.env.NMG_LOCOMO_DATA, [
        resolve(root, "evals/locomo/data/locomo10.json"),
        resolve(root, ".benchmarks/official/LoCoMo/data/locomo10.json"),
      ]),
    );
  }
  if (value === "personamem") {
    const size = process.env.NMG_PERSONAMEM_SIZE ?? "32k";
    return loadPersonaMem(
      resolveBenchmarkData("PersonaMem questions", process.env.NMG_PERSONAMEM_QUESTIONS, [
        resolve(root, `evals/personamem/data/questions_${size}.csv`),
      ]),
      resolveBenchmarkData("PersonaMem contexts", process.env.NMG_PERSONAMEM_CONTEXTS, [
        resolve(root, `evals/personamem/data/shared_contexts_${size}.jsonl`),
      ]),
    );
  }
  return loadBeam(
    resolveBenchmarkData("BEAM", process.env.NMG_BEAM_DATA, [
      resolve(root, "evals/beam/data/chats/100K"),
      resolve(root, ".benchmarks/official/BEAM/chats/100K"),
    ]),
  );
}

function formatSession(session: BenchmarkSession): string {
  return (
    `[${session.date ?? session.id}]\n` +
    session.turns.map((turn) => `${turn.speaker ?? turn.role}: ${turn.content}`).join("\n")
  );
}

function withinBudget(values: Array<{ text: string; sourceIds: string[] }>): {
  text: string;
  sourceIds: string[];
} {
  const selected: string[] = [];
  const sourceIds: string[] = [];
  const evidenceById = new Map<string, string>();
  let used = 0;
  for (const value of values) {
    if (selected.length > 0 && used + value.text.length > contextBudget()) continue;
    selected.push(value.text);
    sourceIds.push(...value.sourceIds);
    for (let i = 0; i < value.sourceIds.length; i += 1) {
      evidenceById.set(value.sourceIds[i]!, value.textForCitation ?? value.text);
    }
    used += value.text.length;
    if (used >= contextBudget()) break;
  }
  return { text: selected.join("\n\n"), sourceIds, evidenceById };
}

function lexicalOverlap(query: string, text: string): number {
  const queryTokens = new Set(tokens(query));
  const textTokens = new Set(tokens(text));
  if (queryTokens.size === 0) return 0;
  return [...queryTokens].filter((token) => textTokens.has(token)).length / queryTokens.size;
}

function tokens(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}_+.#-]+/gu) ?? [];
}

function parseBenchmark(value: string | undefined): Benchmark {
  if (value === "beam" || value === "locomo" || value === "personamem") return value;
  throw new Error("Benchmark must be beam, locomo, or personamem.");
}

function parseMode(value: string | undefined): Mode {
  const candidate = value ?? "validate";
  if (
    [
      "flat-hybrid",
      "matched",
      "nmg-auto",
      "nmg-candidate",
      "nmg-deterministic",
      "nmg-graph",
      "nmg-nodes",
      "nmg-shadow",
      "no-memory",
      "raw-session",
      "validate",
    ].includes(candidate)
  )
    return candidate as Mode;
  throw new Error(`Unknown benchmark mode: ${candidate}`);
}

function requiredControllerCandidatePath(): string {
  const path = process.env.NMG_CONTROLLER_CANDIDATE_STATE?.trim();
  if (!path) {
    throw new Error("Matched controller evaluation requires NMG_CONTROLLER_CANDIDATE_STATE");
  }
  return path;
}

function positiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`Expected positive integer: ${value}`);
  return parsed;
}

function contextBudget(): number {
  return Math.max(2_000, Number.parseInt(process.env.NMG_BENCH_CONTEXT_CHARS ?? "12000", 10));
}

function concurrency(): number {
  return Math.max(1, Math.min(positiveInteger(process.env.NMG_BENCH_CONCURRENCY ?? "4"), 16));
}

function timeout(): number {
  return Math.max(30_000, Number.parseInt(process.env.NMG_BENCH_TIMEOUT_MS ?? "300000", 10));
}

function repeats(): number {
  return Math.max(1, Math.min(positiveInteger(process.env.NMG_BENCH_REPEATS ?? "1"), 20));
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/giu, "_").slice(0, 120);
}

async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  limit: number,
  worker: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(values[index]!);
      }
    }),
  );
  return results;
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
