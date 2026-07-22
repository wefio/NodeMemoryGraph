import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { RpcClient } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { NmgStore } from "../../src/core/store.ts";
import { HashingVectorEmbedder, cosineSimilarity } from "../../src/core/vector.ts";
import { indexExternalEmbeddings } from "../external-embeddings.ts";
import {
  pairedAgainst,
  summarizeAccuracy,
  summarizeByMode,
  summarizeLatencyByMode,
  summarizePipelineByMode,
  summarizeRetrievalByMode,
} from "./report.ts";

type Role = "assistant" | "user";

interface Turn {
  role: Role;
  content: string;
}

interface LongMemExample {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_sessions: Turn[][];
}

interface SampleManifest {
  name: string;
  description?: string;
  questionIds: string[];
}

type Mode = "flat-hybrid" | "matched" | "nmg-auto" | "nmg-graph" | "nmg-lite" |
  "nmg-oracle" | "no-memory" | "oracle" | "raw-session" | "validate";
type MatchedMode = "flat-hybrid" | "nmg-auto" | "nmg-graph" | "nmg-lite" |
  "no-memory" | "raw-session";

const root = resolve(import.meta.dirname, "../..");
const dataDirectory = resolve(import.meta.dirname, "data");
const mode = parseMode(process.argv[2]);
const perType = positiveInteger(process.argv[3] ?? "1");
const sourceFile = mode === "oracle" || mode === "nmg-oracle"
  ? "longmemeval_oracle.json"
  : "longmemeval_s_cleaned.json";
const examples = JSON.parse(
  readFileSync(resolve(dataDirectory, sourceFile), "utf8"),
) as LongMemExample[];
const canonicalExamples = JSON.parse(
  readFileSync(
    resolve(dataDirectory, "longmemeval_s_cleaned.json"),
    "utf8",
  ),
) as LongMemExample[];
const manifest = loadSampleManifest();
const selectedIds = manifest?.questionIds ?? stratifiedSample(canonicalExamples, perType)
  .map((example) => example.question_id);
const examplesById = new Map(
  examples.map((example) => [example.question_id, example]),
);
const selectedSample = selectedIds.map((id) => {
  const example = examplesById.get(id);
  if (!example) throw new Error(`${sourceFile} is missing question ${id}`);
  return example;
});
const sample = process.env.NMG_LONGMEM_QUESTION
  ? selectedSample.filter((example) => example.question_id === process.env.NMG_LONGMEM_QUESTION)
  : selectedSample;
if (sample.length === 0) {
  throw new Error("NMG_LONGMEM_QUESTION did not match the selected sample");
}
if (mode === "validate") {
  process.stdout.write(`${JSON.stringify({
    benchmark: "longmemeval",
    cases: canonicalExamples.length,
    selected: sample.length,
    selectedIds: sample.map((example) => example.question_id),
    sampleManifest: manifest?.name ?? null,
    repeats: evalRepeats(),
    retrievalJudge: retrievalJudgeEnabled(),
    categories: Object.fromEntries([...new Set(canonicalExamples.map(benchmarkType))]
      .sort().map((type) => [
        type,
        canonicalExamples.filter((example) => benchmarkType(example) === type).length,
      ])),
  }, null, 2)}\n`);
  process.exit(0);
}
const runId = new Date().toISOString().replaceAll(":", "-");
const outputDirectory = resolve(import.meta.dirname, "results", runId);
mkdirSync(outputDirectory, { recursive: true });

const trials = sample.flatMap((example) =>
  Array.from({ length: evalRepeats() }, (_, repeat) => ({ example, repeat }))
);
const matchedRuns = mode === "matched"
  ? await mapConcurrent(trials, evalConcurrency(), ({ example, repeat }) =>
    runMatchedExample(example, repeat))
  : [];
const results = mode === "matched"
  ? matchedRuns.flatMap((run) => run.results)
  : await mapConcurrent(trials, evalConcurrency(), ({ example, repeat }) =>
    runExample(example, mode, undefined, 0, repeat));
const report = {
  runId,
  mode,
  model: "deepseek/deepseek-v4-flash",
  concurrency: evalConcurrency(),
  sampleManifest: manifest?.name ?? null,
  questionCount: sample.length,
  repeats: evalRepeats(),
  retrievalJudge: retrievalJudgeEnabled(),
  trialCount: trials.length,
  sampleSize: results.length,
  ...summarizeAccuracy(results),
  byMode: summarizeByMode(results),
  retrievalByMode: summarizeRetrievalByMode(results),
  pipelineByMode: summarizePipelineByMode(results),
  latencyByMode: summarizeLatencyByMode(results),
  preparations: matchedRuns.map((run) => run.preparation),
  pairedAgainstFlatHybrid: mode === "matched"
    ? pairedAgainst(results, "flat-hybrid")
    : {},
  results,
};

writeFileSync(
  resolve(outputDirectory, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function runMatchedExample(example: LongMemExample, repeat: number) {
  const nmgDirectory = resolve(
    outputDirectory, "nmg", example.question_id, `repeat-${repeat}`,
  );
  mkdirSync(nmgDirectory, { recursive: true });
  const ingestStartedAt = performance.now();
  const remembered = ingestRawEvidence(example, nmgDirectory);
  const ingestMs = Math.round(performance.now() - ingestStartedAt);
  const indexStartedAt = performance.now();
  await indexExternalEmbeddings(nmgDirectory);
  const indexMs = Math.round(performance.now() - indexStartedAt);
  const modes: MatchedMode[] = [
    "no-memory", "raw-session", "flat-hybrid", "nmg-auto", "nmg-lite", "nmg-graph",
  ];
  const results = [];
  for (const matchedMode of modes) {
    results.push(await runExample(
      example, matchedMode, nmgDirectory, remembered, repeat,
    ));
  }
  return {
    results,
    preparation: {
      questionId: example.question_id,
      repeat,
      remembered,
      ingestMs,
      indexMs,
      totalMs: ingestMs + indexMs,
    },
  };
}

async function runExample(
  example: LongMemExample,
  runMode: Exclude<Mode, "matched">,
  sharedNmgDirectory?: string,
  sharedRemembered = 0,
  repeat = 0,
) {
  const startedAt = performance.now();
  const nmgDirectory = sharedNmgDirectory ??
    resolve(outputDirectory, "nmg", example.question_id);
  let remembered = sharedRemembered;
  if (runMode === "nmg-oracle" && !sharedNmgDirectory) {
    mkdirSync(nmgDirectory, { recursive: true });
    remembered = await ingestEvidence(example, nmgDirectory);
    await indexExternalEmbeddings(nmgDirectory);
  }

  const answerClient = createClient(
    runMode.startsWith("nmg-") ? nmgDirectory : undefined,
    runMode,
  );
  let hypothesis = "";
  let answerError: string | null = null;
  let answerEvents: AgentSessionEvent[] = [];
  try {
    await answerClient.start();
    await answerClient.setThinkingLevel("low");
    answerEvents = await answerClient.promptAndWait(
      answerPrompt(example, runMode), undefined, modelTimeout(),
    );
    hypothesis = (await answerClient.getLastAssistantText())?.trim() ?? "";
  } catch (error) {
    answerError = error instanceof Error ? error.message : String(error);
  } finally {
    await answerClient.stop();
  }
  const answerDurationMs = Math.round(performance.now() - startedAt);

  const retrievalContext = retrievalJudgeEnabled()
    ? retrievalEvidence(example, runMode, answerEvents)
    : null;
  const retrievalJudgement = retrievalContext === null
    ? null
    : await judgeRetrieval(example, retrievalContext.text);
  const judgement = await judgeAnswer(example, hypothesis);

  return {
    questionId: example.question_id,
    repeat,
    mode: runMode,
    questionType: benchmarkType(example),
    question: example.question,
    reference: example.answer,
    hypothesis,
    answerError,
    retrievalAvailable: retrievalContext !== null,
    retrievalContextChars: retrievalContext?.text.length ?? 0,
    retrievalToolCalls: retrievalContext?.toolCalls ?? 0,
    retrievalJudgement,
    retrievalPassed: retrievalJudgement === null
      ? null
      : judgementPassed(retrievalJudgement),
    judgement,
    passed: judgementPassed(judgement),
    remembered,
    durationMs: answerDurationMs,
    evaluationDurationMs: Math.round(performance.now() - startedAt),
  };
}

async function ingestEvidence(
  example: LongMemExample,
  nmgDirectory: string,
): Promise<number> {
  let remembered = 0;
  for (let index = 0; index < example.haystack_sessions.length; index += 1) {
    const client = createClient(nmgDirectory);
    try {
      await client.start();
      await client.setThinkingLevel("low");
      const events = await client.promptAndWait(
        ingestionPrompt(
          example.haystack_sessions[index],
          example.haystack_dates[index] ?? "unknown date",
        ),
        undefined,
        modelTimeout(),
      );
      remembered += events.filter(
        (event) =>
          event.type === "tool_execution_end" &&
          event.toolName === "nmg_remember" &&
          !event.isError,
      ).length;
    } finally {
      await client.stop();
    }
  }
  return remembered;
}

function ingestRawEvidence(example: LongMemExample, nmgDirectory: string): number {
  const store = new NmgStore(resolve(nmgDirectory, "nmg.sqlite"));
  let remembered = 0;
  let previousNodeId: string | undefined;
  try {
    for (let sessionIndex = 0;
      sessionIndex < example.haystack_sessions.length;
      sessionIndex += 1) {
      const session = example.haystack_sessions[sessionIndex]!;
      const date = example.haystack_dates[sessionIndex] ?? "unknown date";
      const nodeName = `LongMem session ${sessionIndex} ${date}`;
      const nodeSummary = session.map((turn) => turn.content).join(" ").slice(0, 1_500);
      let currentNodeId: string | undefined;
      for (let turnIndex = 0; turnIndex < session.length; turnIndex += 1) {
        const turn = session[turnIndex]!;
        const saved = store.remember({
          statement: turn.content,
          nodeName,
          nodeSummary,
          memoryType: "conversation_evidence",
          sourceActor: turn.role,
          truthStatus: turn.role === "user" ? "asserted" : "unverified",
          evidence: turn.content,
          eventTime: date,
          sourceRef: `longmemeval:${example.question_id}:${sessionIndex}:${turnIndex}`,
          tier: 2,
          importance: 0.5,
          scope: { benchmark: "LongMemEval", session: String(sessionIndex) },
        });
        currentNodeId = saved.node.id;
        remembered += 1;
      }
      if (previousNodeId && currentNodeId) {
        store.linkNodes({
          sourceNodeId: previousNodeId,
          targetNodeId: currentNodeId,
          type: "related_to",
        });
      }
      previousNodeId = currentNodeId;
    }
  } finally {
    store.close();
  }
  return remembered;
}

async function judgeAnswer(
  example: LongMemExample,
  hypothesis: string,
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const client = createClient();
    try {
      await client.start();
      await client.setThinkingLevel("low");
      try {
        await client.promptAndWait(
          judgePrompt(example, hypothesis),
          undefined,
          modelTimeout(),
        );
        const judgement = (await client.getLastAssistantText())?.trim() ?? "";
        if (judgement) return judgement;
      } catch {
        // A failed judge attempt is retried with a fresh Pi process. The final
        // report remains usable even when the model provider has a transient.
      }
    } finally {
      await client.stop();
    }
  }
  return "FAIL - Judge returned no response after two attempts.";
}

async function judgeRetrieval(
  example: LongMemExample,
  retrievedContext: string,
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const client = createClient();
    try {
      await client.start();
      await client.setThinkingLevel("low");
      try {
        await client.promptAndWait(
          retrievalJudgePrompt(example, retrievedContext),
          undefined,
          modelTimeout(),
        );
        const judgement = (await client.getLastAssistantText())?.trim() ?? "";
        if (judgement) return judgement;
      } catch {
        // Keep retrieval evaluation independent from transient judge failures.
      }
    } finally {
      await client.stop();
    }
  }
  return "FAIL - Retrieval judge returned no response after two attempts.";
}

function retrievalEvidence(
  example: LongMemExample,
  runMode: Exclude<Mode, "matched">,
  events: AgentSessionEvent[],
): { text: string; toolCalls: number } | null {
  if (runMode === "oracle") {
    return { text: formatHistory(example), toolCalls: 0 };
  }
  if (runMode === "raw-session") {
    return { text: retrieveRawSessions(example), toolCalls: 0 };
  }
  if (runMode === "flat-hybrid") {
    return { text: retrieveFlatTurns(example), toolCalls: 0 };
  }
  if (runMode === "nmg-lite" || runMode === "nmg-graph" || runMode === "nmg-oracle") {
    const outputs = events.flatMap((event) => {
      if (event.type !== "tool_execution_end" || event.toolName !== "nmg_get" || event.isError) {
        return [];
      }
      const result = event.result as {
        content?: Array<{ type?: string; text?: string }>;
      } | undefined;
      return result?.content?.flatMap((content) =>
        content.type === "text" && content.text ? [content.text] : []) ?? [];
    });
    return { text: outputs.join("\n\n"), toolCalls: outputs.length };
  }
  // Automatic recall is injected before the model call and is not exposed by
  // Pi's RPC event stream. Report it as unavailable instead of guessing.
  return null;
}

function answerPrompt(example: LongMemExample, runMode: Exclude<Mode, "matched">): string {
  if (runMode === "nmg-auto") {
    return `Question date: ${example.question_date}\nQuestion: ${example.question}`;
  }
  const history = runMode === "oracle"
    ? `\nRelevant conversation history:\n${formatHistory(example)}\n`
    : runMode === "raw-session"
    ? `\nRetrieved raw sessions:\n${retrieveRawSessions(example)}\n`
    : runMode === "flat-hybrid"
    ? `\nRetrieved flat hybrid turns:\n${retrieveFlatTurns(example)}\n`
    : "\nNo conversation history is directly injected; use available memory tools.\n";
  return [
    "Answer the question concisely using only information available to you.",
    "If the requested past information is unavailable, say that you do not know.",
    "For a recommendation question, use remembered preferences to generate useful",
    "new recommendations. The exact recommended resources need not have appeared",
    "in the past conversation; do not confuse preference recall with item recall.",
    ...(runMode === "nmg-lite" || runMode === "nmg-graph" || runMode === "nmg-oracle"
      ? ["Search NMG through maxTier 3 and call nmg_get for selected evidence before answering."]
      : []),
    history,
    `Question date: ${example.question_date}`,
    `Question: ${example.question}`,
  ].join("\n");
}

function ingestionPrompt(session: Turn[], date: string): string {
  return [
    "The following is a past conversation session being imported into NMG.",
    "Use nmg_remember as many times as needed to preserve durable user facts,",
    "preferences, constraints, timestamped events, updates, and useful assistant",
    "statements. Assistant statements are conversational evidence, not verified truth.",
    "Store separately countable entities and pending actions as separate memories.",
    "For example, an item to return and its replacement to pick up are two actions.",
    "For each user-stated memory, pass evidence as the shortest exact quote from",
    "the user turn that supports it; do not replace evidence with a paraphrase.",
    "Preserve the date and narrow scope. Do not answer the conversation itself.",
    `Session date: ${date}`,
    session.map((turn) => `${turn.role}: ${turn.content}`).join("\n"),
    "After all useful memories are stored, answer only INGESTED.",
  ].join("\n");
}

function judgePrompt(example: LongMemExample, hypothesis: string): string {
  return [
    "Judge whether the candidate answer is semantically correct given the reference.",
    "Accept concise paraphrases and equivalent answers.",
    "Treat the reference answer as authoritative. If it contains a concrete answer,",
    "a candidate saying unknown or unavailable MUST fail. Only accept unknown when",
    "the reference itself explicitly says the information was never provided.",
    "Respond with exactly PASS or FAIL followed by one short reason.",
    `Question: ${example.question}`,
    `Reference answer: ${example.answer}`,
    `Candidate answer: ${hypothesis}`,
  ].join("\n");
}

function retrievalJudgePrompt(example: LongMemExample, retrievedContext: string): string {
  return [
    "Judge only whether the retrieved context contains enough evidence to produce",
    "the reference answer. Ignore any candidate answer and do not penalize uncertainty",
    "wording if the required fact is present. For an abstention reference, PASS only",
    "when the retrieved context contains no conflicting answer to the question.",
    "Respond with exactly PASS or FAIL followed by one short reason.",
    `Question: ${example.question}`,
    `Reference answer: ${example.answer}`,
    `Retrieved context:\n${retrievedContext || "<empty>"}`,
  ].join("\n");
}

function judgementPassed(judgement: string): boolean {
  const verdicts = judgement.split(/\r?\n/u).flatMap((line) => {
    const match = line.trim().match(/^(PASS|FAIL)\b/i);
    return match ? [match[1]!.toUpperCase()] : [];
  });
  return verdicts.at(-1) === "PASS";
}

function formatHistory(example: LongMemExample): string {
  return example.haystack_sessions.map((session, index) => {
    const turns = session
      .map((turn) => `${turn.role}: ${turn.content}`)
      .join("\n");
    return `[${example.haystack_dates[index] ?? "unknown date"}]\n${turns}`;
  }).join("\n\n");
}

function retrieveRawSessions(example: LongMemExample): string {
  const budget = contextBudget();
  const ranked = example.haystack_sessions.map((session, index) => {
    const text = `[${example.haystack_dates[index] ?? "unknown date"}]\n` +
      session.map((turn) => `${turn.role}: ${turn.content}`).join("\n");
    return { text, score: lexicalOverlap(example.question, text) };
  }).sort((left, right) => right.score - left.score);
  return takeWithinBudget(ranked.map((item) => item.text), budget);
}

function retrieveFlatTurns(example: LongMemExample): string {
  const embedder = new HashingVectorEmbedder(256);
  const queryVector = embedder.embed(example.question);
  const ranked = example.haystack_sessions.flatMap((session, sessionIndex) =>
    session.map((turn) => {
      const text = `[${example.haystack_dates[sessionIndex] ?? "unknown date"}] ` +
        `${turn.role}: ${turn.content}`;
      return {
        text,
        score: lexicalOverlap(example.question, text) * 0.55 +
          cosineSimilarity(queryVector, embedder.embed(text)) * 0.45,
      };
    }))
    .sort((left, right) => right.score - left.score);
  return takeWithinBudget(ranked.map((item) => item.text), contextBudget());
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

function contextBudget(): number {
  return Math.max(2_000, Number.parseInt(
    process.env.NMG_LONGMEM_CONTEXT_CHARS ?? "12000",
    10,
  ));
}

function takeWithinBudget(values: string[], budget: number): string {
  const selected: string[] = [];
  let used = 0;
  for (const value of values) {
    if (selected.length > 0 && used + value.length > budget) continue;
    selected.push(value);
    used += value.length;
    if (used >= budget) break;
  }
  return selected.join("\n\n");
}

function stratifiedSample(
  examples: LongMemExample[],
  count: number,
): LongMemExample[] {
  const grouped = new Map<string, LongMemExample[]>();
  for (const example of examples) {
    const type = benchmarkType(example);
    const group = grouped.get(type) ?? [];
    group.push(example);
    grouped.set(type, group);
  }
  return [...grouped.keys()].sort().flatMap(
    (type) => grouped.get(type)!.slice(0, count),
  );
}

function loadSampleManifest(): SampleManifest | null {
  const configuredPath = process.env.NMG_LONGMEM_SAMPLE_FILE;
  if (!configuredPath) return null;
  const manifestPath = resolve(root, configuredPath);
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as SampleManifest;
  if (!parsed.name || !Array.isArray(parsed.questionIds) || parsed.questionIds.length === 0) {
    throw new Error(`Invalid LongMemEval sample manifest: ${manifestPath}`);
  }
  if (new Set(parsed.questionIds).size !== parsed.questionIds.length) {
    throw new Error(`LongMemEval sample manifest contains duplicate question IDs: ${manifestPath}`);
  }
  return parsed;
}

function benchmarkType(example: LongMemExample): string {
  return example.question_id.endsWith("_abs")
    ? "abstention"
    : example.question_type;
}

function createClient(nmgDirectory?: string, runMode?: Exclude<Mode, "matched">): RpcClient {
  return new RpcClient({
    cliPath: resolve(
      root,
      "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    ),
    cwd: root,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    env: {
      ...definedEnvironment(),
      ...(nmgDirectory ? { NMG_DATA_DIR: nmgDirectory } : {}),
      ...(runMode === "nmg-lite"
        ? { NMG_GRAPH_HOPS: "0" }
        : runMode === "nmg-graph"
        ? { NMG_GRAPH_HOPS: "1" }
        : {}),
    },
    args: [
      "--offline",
      "--approve",
      "--no-session",
      "--no-extensions",
      "--model",
      "deepseek/deepseek-v4-flash",
      "--thinking",
      "off",
      ...(nmgDirectory
        ? [
            "--tools",
            "nmg_remember,nmg_search,nmg_get",
            "--extension",
            resolve(root, ".pi/extensions/nmg/index.ts"),
          ]
        : ["--tools", "read"]),
    ],
  });
}

function parseMode(value: string | undefined): Mode {
  if (value === undefined || value === "no-memory") return "no-memory";
  if (value === "oracle") return "oracle";
  if (value === "nmg-oracle") return "nmg-oracle";
  if (value === "nmg-auto") return "nmg-auto";
  if (value === "raw-session") return "raw-session";
  if (value === "flat-hybrid") return "flat-hybrid";
  if (value === "nmg-lite") return "nmg-lite";
  if (value === "nmg-graph") return "nmg-graph";
  if (value === "matched") return "matched";
  if (value === "validate") return "validate";
  throw new Error(
    `Unknown mode: ${value}. Use validate, matched, no-memory, raw-session, nmg-auto, ` +
      `flat-hybrid, nmg-lite, nmg-graph, oracle, or nmg-oracle.`,
  );
}

function positiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive sample count, received: ${value}`);
  }
  return parsed;
}

function evalConcurrency(): number {
  return Math.max(1, Math.min(
    positiveInteger(process.env.NMG_LONGMEM_CONCURRENCY ?? "4"),
    16,
  ));
}

function evalRepeats(): number {
  return Math.min(positiveInteger(process.env.NMG_LONGMEM_REPEATS ?? "1"), 20);
}

function retrievalJudgeEnabled(): boolean {
  const configured = process.env.NMG_LONGMEM_RETRIEVAL_JUDGE?.trim().toLocaleLowerCase();
  return configured !== "0" && configured !== "false" && configured !== "off";
}

function modelTimeout(): number {
  return Math.max(30_000, Number.parseInt(
    process.env.NMG_LONGMEM_TIMEOUT_MS ?? "300000",
    10,
  ) || 300_000);
}

async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  worker: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= values.length) return;
        results[index] = await worker(values[index]!);
      }
    },
  ));
  return results;
}

function definedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
