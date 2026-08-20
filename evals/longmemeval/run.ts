import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { RpcClient } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { collectAgentRunTelemetry } from "../agent-telemetry.ts";
import { NmgStore } from "../../src/core/store.ts";
import { HashingVectorEmbedder, cosineSimilarity } from "../../src/core/vector.ts";
import { indexExternalEmbeddings } from "../external-embeddings.ts";
import { benchmarkCredentialEnvironment } from "../local-env.ts";
import {
  BACKEND_ABLATION_MODES,
  benchmarkIsolationArgs,
  counterbalancedOrder,
  controllerMatchedEnvironment,
  isMatchedMode,
  matchedUserPrompt,
  MATCHED_MODES,
} from "../benchmarks/matched.ts";
import {
  installControllerCandidate,
  loadControllerCandidate,
  readControllerActuation,
} from "../benchmarks/controller-candidate.ts";
import { gitRevision, sampleFingerprint } from "../official/reproducibility.ts";
import { benchmarkParametersFromEnvironment } from "../official/parameters.ts";
import {
  pairedAgainst,
  summarizeAnswerTimingByMode,
  summarizeAccuracy,
  summarizeByMode,
  summarizeLatencyByMode,
  summarizeInjectedContextByMode,
  summarizeOfficialRetrievalByMode,
  summarizePipelineByMode,
  summarizeRetrievalByMode,
  summarizeTokenUsageByMode,
} from "./report.ts";
import { loadLongMemEval, scoreLongMemRetrieval } from "./official.ts";
import type { LongMemExample, LongMemTurn } from "./official.ts";
import {
  latestAutomaticRecallEvidence,
  officialRetrievalForMemoryIds,
} from "./retrieval-evidence.ts";

interface SampleManifest {
  name: string;
  description?: string;
  questionIds: string[];
}

type Mode =
  | "backend-ablation"
  | "flat-hybrid"
  | "matched"
  | "nmg-auto"
  | "nmg-candidate"
  | "nmg-graph"
  | "nmg-lite"
  | "nmg-deterministic"
  | "nmg-oracle"
  | "nmg-shadow"
  | "no-memory"
  | "oracle"
  | "raw-session"
  | "validate";

const root = resolve(import.meta.dirname, "../..");
const dataDirectory = resolve(import.meta.dirname, "data");
const mode = parseMode(process.argv[2]);
const perType = positiveInteger(process.argv[3] ?? "1");
const sourceFile =
  mode === "oracle" || mode === "nmg-oracle"
    ? "longmemeval_oracle.json"
    : "longmemeval_s_cleaned.json";
const examples = loadLongMemEval(resolve(dataDirectory, sourceFile));
const canonicalExamples = loadLongMemEval(resolve(dataDirectory, "longmemeval_s_cleaned.json"));
const manifest = loadSampleManifest();
const selectedIds =
  manifest?.questionIds ??
  stratifiedSample(canonicalExamples, perType).map((example) => example.question_id);
const examplesById = new Map(examples.map((example) => [example.question_id, example]));
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
  process.stdout.write(
    `${JSON.stringify(
      {
        benchmark: "longmemeval",
        cases: canonicalExamples.length,
        selected: sample.length,
        selectedIds: sample.map((example) => example.question_id),
        sampleManifest: manifest?.name ?? null,
        repeats: evalRepeats(),
        retrievalJudge: retrievalJudgeEnabled(),
        categories: Object.fromEntries(
          [...new Set(canonicalExamples.map(benchmarkType))]
            .sort()
            .map((type) => [
              type,
              canonicalExamples.filter((example) => benchmarkType(example) === type).length,
            ]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}
const controllerCandidate =
  mode === "matched" || mode === "nmg-candidate"
    ? loadControllerCandidate(requiredControllerCandidatePath())
    : null;
const runId = new Date().toISOString().replaceAll(":", "-");
const outputDirectory = resolve(import.meta.dirname, "results", runId);
mkdirSync(outputDirectory, { recursive: true });

const trials = sample.flatMap((example) =>
  Array.from({ length: evalRepeats() }, (_, repeat) => ({ example, repeat })),
);
const matchedRuns =
  mode === "matched"
    ? await mapConcurrent(trials, evalConcurrency(), ({ example, repeat }) =>
        runMatchedExample(example, repeat),
      )
    : [];
const backendAblationRuns =
  mode === "backend-ablation"
    ? await mapConcurrent(trials, evalConcurrency(), ({ example, repeat }) =>
        runBackendAblationExample(example, repeat),
      )
    : [];
const results =
  mode === "matched"
    ? matchedRuns.flatMap((run) => run.results)
    : mode === "backend-ablation"
      ? backendAblationRuns.flatMap((run) => run.results)
      : await mapConcurrent(trials, evalConcurrency(), ({ example, repeat }) =>
          runExample(example, mode, undefined, 0, repeat),
        );
const report = {
  runId,
  mode,
  model: "deepseek/deepseek-v4-flash",
  codeRevision: gitRevision(root),
  sampleFingerprint: sampleFingerprint(
    sample.map((example) => ({
      id: example.question_id,
      type: benchmarkType(example),
      question: example.question,
      answer: example.answer,
    })),
  ),
  diagnosticJudgeModel: "deepseek/deepseek-v4-flash",
  protocolScoring: "separate",
  scoringCommand: `npm run benchmark:score:longmem -- ${outputDirectory}`,
  leaderboardComparable: false,
  concurrency: evalConcurrency(),
  benchmarkParameters: benchmarkParametersFromEnvironment(),
  sampleManifest: manifest?.name ?? null,
  questionCount: sample.length,
  repeats: evalRepeats(),
  retrievalJudge: retrievalJudgeEnabled(),
  trialCount: trials.length,
  sampleSize: results.length,
  ...summarizeAccuracy(results),
  byMode: summarizeByMode(results),
  retrievalByMode: summarizeRetrievalByMode(results),
  officialRetrievalByMode: summarizeOfficialRetrievalByMode(results),
  pipelineByMode: summarizePipelineByMode(results),
  latencyByMode: summarizeLatencyByMode(results),
  tokenUsageByMode: summarizeTokenUsageByMode(results),
  answerTimingByMode: summarizeAnswerTimingByMode(results),
  injectedContextByMode: summarizeInjectedContextByMode(results),
  preparations: [...matchedRuns, ...backendAblationRuns].map((run) => run.preparation),
  pairedAgainstNoMemory:
    mode === "matched" || mode === "backend-ablation" ? pairedAgainst(results, "no-memory") : {},
  matchedProtocol:
    mode === "matched"
      ? {
          arms: MATCHED_MODES,
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
      : mode === "backend-ablation"
        ? {
            arms: BACKEND_ABLATION_MODES,
            invariant:
              "same case, model, thinking level, task instructions, question, source corpus, and context budget",
            onlyDifference:
              "no memory vs flat retrieval vs NMG node-local retrieval vs NMG graph expansion",
            controllerAffectsRanking: false,
          }
        : null,
  results,
};

writeFileSync(resolve(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(
  resolve(outputDirectory, "predictions.jsonl"),
  `${results
    .map((row) =>
      JSON.stringify({
        question_id: row.questionId,
        hypothesis: row.hypothesis,
        mode: row.mode,
      }),
    )
    .join("\n")}\n`,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function runMatchedExample(example: LongMemExample, repeat: number) {
  const seedDirectory = resolve(
    outputDirectory,
    "nmg-seed",
    example.question_id,
    `repeat-${repeat}`,
  );
  mkdirSync(seedDirectory, { recursive: true });
  const ingestStartedAt = performance.now();
  const remembered = ingestRawEvidence(example, seedDirectory);
  const ingestMs = Math.round(performance.now() - ingestStartedAt);
  const indexStartedAt = performance.now();
  await indexExternalEmbeddings(seedDirectory);
  const indexMs = Math.round(performance.now() - indexStartedAt);
  const results = [];
  for (const matchedMode of MATCHED_MODES) {
    const armDirectory = matchedMode.startsWith("nmg-")
      ? resolve(outputDirectory, "arms", example.question_id, matchedMode, `repeat-${repeat}`)
      : undefined;
    if (armDirectory) cpSync(seedDirectory, armDirectory, { recursive: true });
    if (armDirectory && matchedMode === "nmg-candidate") {
      installControllerCandidate(controllerCandidate!, armDirectory);
    }
    results.push(await runExample(example, matchedMode, armDirectory, remembered, repeat));
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

async function runBackendAblationExample(example: LongMemExample, repeat: number) {
  const seedDirectory = resolve(
    outputDirectory,
    "nmg-seed",
    example.question_id,
    `repeat-${repeat}`,
  );
  mkdirSync(seedDirectory, { recursive: true });
  const ingestStartedAt = performance.now();
  const remembered = ingestRawEvidence(example, seedDirectory);
  const ingestMs = Math.round(performance.now() - ingestStartedAt);
  const indexStartedAt = performance.now();
  await indexExternalEmbeddings(seedDirectory);
  const indexMs = Math.round(performance.now() - indexStartedAt);
  const results = [];
  const executionOrder = counterbalancedOrder(
    BACKEND_ABLATION_MODES,
    `${example.question_id}:${repeat}`,
  );
  for (const arm of executionOrder) {
    const armDirectory = arm.startsWith("nmg-")
      ? resolve(outputDirectory, "arms", example.question_id, arm, `repeat-${repeat}`)
      : undefined;
    if (armDirectory) cpSync(seedDirectory, armDirectory, { recursive: true });
    process.stderr.write(`[longmemeval] ${example.question_id} ${arm} repeat=${repeat}: start\n`);
    results.push(await runExample(example, arm, armDirectory, remembered, repeat));
    process.stderr.write(`[longmemeval] ${example.question_id} ${arm} repeat=${repeat}: done\n`);
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
  const nmgDirectory = sharedNmgDirectory ?? resolve(outputDirectory, "nmg", example.question_id);
  let remembered = sharedRemembered;
  if (runMode === "nmg-oracle" && !sharedNmgDirectory) {
    mkdirSync(nmgDirectory, { recursive: true });
    remembered = await ingestEvidence(example, nmgDirectory);
    await indexExternalEmbeddings(nmgDirectory);
  }

  const answerClient = createClient(runMode.startsWith("nmg-") ? nmgDirectory : undefined, runMode);
  const liveTiming = observeAnswerTiming(answerClient);
  let hypothesis = "";
  let answerError: string | null = null;
  let answerEvents: AgentSessionEvent[] = [];
  try {
    const startupStartedAt = performance.now();
    await answerClient.start();
    await answerClient.setThinkingLevel("low");
    liveTiming.startupMs = performance.now() - startupStartedAt;
    const promptStartedAt = performance.now();
    answerEvents = await answerClient.promptAndWait(
      answerPrompt(example, runMode),
      undefined,
      modelTimeout(),
    );
    liveTiming.promptMs = performance.now() - promptStartedAt;
    hypothesis = (await answerClient.getLastAssistantText())?.trim() ?? "";
  } catch (error) {
    answerError = error instanceof Error ? error.message : String(error);
  } finally {
    const shutdownStartedAt = performance.now();
    await answerClient.stop();
    liveTiming.shutdownMs = performance.now() - shutdownStartedAt;
    liveTiming.dispose();
  }
  const answerDurationMs = Math.round(performance.now() - startedAt);
  const memoryPerformance = nmgDirectory ? readMemoryPerformance(nmgDirectory) : null;

  const retrievalContext = retrievalEvidence(example, runMode, answerEvents, nmgDirectory);
  const telemetry = collectAgentRunTelemetry(answerEvents);
  const retrievalJudgement =
    retrievalContext === null || !retrievalJudgeEnabled()
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
    retrievalSource: retrievalContext?.source ?? null,
    retrievalContextChars: retrievalContext?.text.length ?? 0,
    retrievalToolCalls: retrievalContext?.toolCalls ?? 0,
    officialRetrieval: retrievalContext?.officialMetrics ?? null,
    retrievalJudgement,
    retrievalPassed: retrievalJudgement === null ? null : judgementPassed(retrievalJudgement),
    tokenUsage: telemetry.tokenUsage,
    controllerActuation: readControllerActuation(nmgDirectory),
    answerTiming: liveTiming.snapshot(),
    toolCalls: collectToolCalls(answerEvents),
    toolCallCount: telemetry.toolCalls,
    toolRounds: telemetry.toolRounds,
    memoryPerformance,
    judgement,
    passed: judgementPassed(judgement),
    remembered,
    userPromptHash: createHash("sha256").update(answerPrompt(example, runMode)).digest("hex"),
    taskPromptHash: createHash("sha256")
      .update(
        matchedUserPrompt({
          benchmark: "LongMemEval",
          question: example.question,
          questionDate: example.question_date,
        }),
      )
      .digest("hex"),
    durationMs: answerDurationMs,
    evaluationDurationMs: Math.round(performance.now() - startedAt),
  };
}

function readMemoryPerformance(nmgDirectory: string) {
  const store = new NmgStore(resolve(nmgDirectory, "nmg.sqlite"));
  try {
    return store
      .perfAggregates()
      .filter(
        (aggregate) => aggregate.section.startsWith("search.") || aggregate.section === "relations",
      )
      .map((aggregate) => ({
        section: aggregate.section,
        count: aggregate.count,
        meanMs: aggregate.count === 0 ? 0 : aggregate.sum / aggregate.count,
      }));
  } finally {
    store.close();
  }
}

function collectToolCalls(events: readonly AgentSessionEvent[]) {
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== "tool_execution_end") continue;
    counts[event.toolName] = (counts[event.toolName] ?? 0) + 1;
  }
  return counts;
}

function observeAnswerTiming(client: RpcClient) {
  let modelStreamMs = 0;
  let assistantStartedAt: number | null = null;
  let toolExecutionMs = 0;
  const toolStarts = new Map<string, number>();
  const timing = {
    startupMs: 0,
    promptMs: 0,
    shutdownMs: 0,
    dispose: () => {},
    snapshot: () => ({
      startupMs: Math.round(timing.startupMs),
      promptMs: Math.round(timing.promptMs),
      modelStreamMs: Math.round(modelStreamMs),
      toolExecutionMs: Math.round(toolExecutionMs),
      shutdownMs: Math.round(timing.shutdownMs),
    }),
  };
  timing.dispose = client.onEvent((event) => {
    const now = performance.now();
    if (event.type === "message_start" && event.message.role === "assistant") {
      assistantStartedAt = now;
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      if (assistantStartedAt !== null) modelStreamMs += now - assistantStartedAt;
      assistantStartedAt = null;
    } else if (event.type === "tool_execution_start") {
      toolStarts.set(event.toolCallId, now);
    } else if (event.type === "tool_execution_end") {
      const startedAt = toolStarts.get(event.toolCallId);
      if (startedAt !== undefined) toolExecutionMs += now - startedAt;
      toolStarts.delete(event.toolCallId);
    }
  });
  return timing;
}

async function ingestEvidence(example: LongMemExample, nmgDirectory: string): Promise<number> {
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
    for (let sessionIndex = 0; sessionIndex < example.haystack_sessions.length; sessionIndex += 1) {
      const session = example.haystack_sessions[sessionIndex]!;
      const date = example.haystack_dates[sessionIndex] ?? "unknown date";
      const nodeName = `LongMem session ${sessionIndex} ${date}`;
      const nodeSummary = session
        .map((turn) => turn.content)
        .join(" ")
        .slice(0, 1_500);
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
          sourceRef:
            `longmemeval:${example.question_id}:` +
            `${example.haystack_session_ids[sessionIndex] ?? sessionIndex}:${turnIndex}`,
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

async function judgeAnswer(example: LongMemExample, hypothesis: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const client = createClient();
    try {
      await client.start();
      await client.setThinkingLevel("low");
      try {
        await client.promptAndWait(judgePrompt(example, hypothesis), undefined, modelTimeout());
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

async function judgeRetrieval(example: LongMemExample, retrievedContext: string): Promise<string> {
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
  nmgDirectory?: string,
): {
  text: string;
  source: "automatic_headers" | "direct_context" | "nmg_get";
  toolCalls: number;
  officialMetrics: ReturnType<typeof latestAutomaticRecallEvidence>["officialMetrics"];
} | null {
  if (runMode === "oracle") {
    return {
      text: formatHistory(example),
      source: "direct_context",
      toolCalls: 0,
      officialMetrics: null,
    };
  }
  if (runMode === "raw-session") {
    return {
      text: retrieveRawSessions(example),
      source: "direct_context",
      toolCalls: 0,
      officialMetrics: null,
    };
  }
  if (runMode === "flat-hybrid") {
    const flat = retrieveFlatTurnResult(example);
    return {
      text: flat.text,
      source: "direct_context",
      toolCalls: 0,
      officialMetrics: scoreLongMemRetrieval(flat.rankedSessionIds, example.answer_session_ids),
    };
  }
  if (
    runMode === "nmg-lite" ||
    runMode === "nmg-graph" ||
    runMode === "nmg-oracle" ||
    runMode === "nmg-deterministic" ||
    runMode === "nmg-candidate" ||
    runMode === "nmg-shadow"
  ) {
    const automatic = nmgDirectory
      ? latestAutomaticRecallEvidence(nmgDirectory, example.question_id, example.answer_session_ids)
      : null;
    const outputs = events.flatMap((event) => {
      if (event.type !== "tool_execution_end" || event.toolName !== "nmg_get" || event.isError) {
        return [];
      }
      const result = event.result as
        | {
            content?: Array<{ type?: string; text?: string }>;
          }
        | undefined;
      return (
        result?.content?.flatMap((content) =>
          content.type === "text" && content.text ? [content.text] : [],
        ) ?? []
      );
    });
    if (outputs.length > 0) {
      const memoryIds = [
        ...new Set(
          outputs.flatMap((output) =>
            [...output.matchAll(/\bmemory=([^;\s]+)/g)].map((match) => match[1]!),
          ),
        ),
      ];
      return {
        text: outputs.join("\n\n"),
        source: "nmg_get",
        toolCalls: outputs.length,
        officialMetrics: nmgDirectory
          ? officialRetrievalForMemoryIds(
              nmgDirectory,
              memoryIds,
              example.question_id,
              example.answer_session_ids,
            )
          : null,
      };
    }
    if (automatic) return automatic;
  }
  return null;
}

function answerPrompt(example: LongMemExample, runMode: Exclude<Mode, "matched">): string {
  if (mode === "backend-ablation") {
    const task = matchedUserPrompt({
      benchmark: "LongMemEval",
      question: example.question,
      questionDate: example.question_date,
    });
    return runMode === "flat-hybrid"
      ? `Retrieved conversation evidence:\n${retrieveFlatTurns(example)}\n\n${task}`
      : task;
  }
  if (isMatchedMode(runMode)) {
    return matchedUserPrompt({
      benchmark: "LongMemEval",
      question: example.question,
      questionDate: example.question_date,
    });
  }
  if (runMode === "nmg-auto") {
    return `Question date: ${example.question_date}\nQuestion: ${example.question}`;
  }
  const history =
    runMode === "oracle"
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

function ingestionPrompt(session: LongMemTurn[], date: string): string {
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
  return example.haystack_sessions
    .map((session, index) => {
      const turns = session.map((turn) => `${turn.role}: ${turn.content}`).join("\n");
      return `[${example.haystack_dates[index] ?? "unknown date"}]\n${turns}`;
    })
    .join("\n\n");
}

function retrieveRawSessions(example: LongMemExample): string {
  const budget = contextBudget();
  const ranked = example.haystack_sessions
    .map((session, index) => {
      const text =
        `[${example.haystack_dates[index] ?? "unknown date"}]\n` +
        session.map((turn) => `${turn.role}: ${turn.content}`).join("\n");
      return { text, score: lexicalOverlap(example.question, text) };
    })
    .sort((left, right) => right.score - left.score);
  return takeWithinBudget(
    ranked.map((item) => item.text),
    budget,
  );
}

function retrieveFlatTurns(example: LongMemExample): string {
  return retrieveFlatTurnResult(example).text;
}

function retrieveFlatTurnResult(example: LongMemExample): {
  text: string;
  rankedSessionIds: string[];
} {
  const embedder = new HashingVectorEmbedder(256);
  const queryVector = embedder.embed(example.question);
  const ranked = example.haystack_sessions
    .flatMap((session, sessionIndex) =>
      session.map((turn) => {
        const text =
          `[${example.haystack_dates[sessionIndex] ?? "unknown date"}] ` +
          `${turn.role}: ${turn.content}`;
        return {
          text,
          sessionId: example.haystack_session_ids[sessionIndex] ?? String(sessionIndex),
          score:
            lexicalOverlap(example.question, text) * 0.55 +
            cosineSimilarity(queryVector, embedder.embed(text)) * 0.45,
        };
      }),
    )
    .sort((left, right) => right.score - left.score);
  const selected: typeof ranked = [];
  let used = 0;
  for (const item of ranked) {
    if (selected.length > 0 && used + item.text.length > contextBudget()) continue;
    selected.push(item);
    used += item.text.length;
    if (used >= contextBudget()) break;
  }
  return {
    text: selected.map((item) => item.text).join("\n\n"),
    rankedSessionIds: [...new Set(selected.map((item) => item.sessionId))],
  };
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
  return Math.max(2_000, Number.parseInt(process.env.NMG_LONGMEM_CONTEXT_CHARS ?? "12000", 10));
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

function stratifiedSample(examples: LongMemExample[], count: number): LongMemExample[] {
  const grouped = new Map<string, LongMemExample[]>();
  for (const example of examples) {
    const type = benchmarkType(example);
    const group = grouped.get(type) ?? [];
    group.push(example);
    grouped.set(type, group);
  }
  return [...grouped.keys()].sort().flatMap((type) => grouped.get(type)!.slice(0, count));
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
  return example.question_id.endsWith("_abs") ? "abstention" : example.question_type;
}

function createClient(nmgDirectory?: string, runMode?: Exclude<Mode, "matched">): RpcClient {
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
      ...(nmgDirectory ? { NMG_DATA_DIR: nmgDirectory } : {}),
      ...(isMatchedMode(runMode) ? controllerMatchedEnvironment(runMode) : {}),
      ...(runMode === "nmg-shadow" ? { NMG_CONTROLLER_SHADOW: "1" } : {}),
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
      ...benchmarkIsolationArgs(
        nmgDirectory ? resolve(root, ".pi/extensions/nmg/index.ts") : undefined,
      ),
      "--model",
      "deepseek/deepseek-v4-flash",
      "--thinking",
      "off",
    ],
  });
}

function parseMode(value: string | undefined): Mode {
  if (value === undefined || value === "no-memory") return "no-memory";
  if (value === "oracle") return "oracle";
  if (value === "nmg-oracle") return "nmg-oracle";
  if (value === "nmg-auto") return "nmg-auto";
  if (value === "nmg-candidate") return "nmg-candidate";
  if (value === "nmg-deterministic") return "nmg-deterministic";
  if (value === "nmg-shadow") return "nmg-shadow";
  if (value === "raw-session") return "raw-session";
  if (value === "flat-hybrid") return "flat-hybrid";
  if (value === "nmg-lite") return "nmg-lite";
  if (value === "nmg-graph") return "nmg-graph";
  if (value === "matched") return "matched";
  if (value === "backend-ablation") return "backend-ablation";
  if (value === "validate") return "validate";
  throw new Error(
    `Unknown mode: ${value}. Use validate, matched, backend-ablation, no-memory, raw-session, nmg-auto, ` +
      `flat-hybrid, nmg-deterministic, nmg-candidate, nmg-shadow, nmg-lite, nmg-graph, oracle, ` +
      `or nmg-oracle.`,
  );
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
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive sample count, received: ${value}`);
  }
  return parsed;
}

function evalConcurrency(): number {
  return Math.max(1, Math.min(positiveInteger(process.env.NMG_LONGMEM_CONCURRENCY ?? "4"), 16));
}

function evalRepeats(): number {
  return Math.min(positiveInteger(process.env.NMG_LONGMEM_REPEATS ?? "1"), 20);
}

function retrievalJudgeEnabled(): boolean {
  const configured = process.env.NMG_LONGMEM_RETRIEVAL_JUDGE?.trim().toLocaleLowerCase();
  return configured !== "0" && configured !== "false" && configured !== "off";
}

function modelTimeout(): number {
  return Math.max(
    30_000,
    Number.parseInt(process.env.NMG_LONGMEM_TIMEOUT_MS ?? "300000", 10) || 300_000,
  );
}

async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  worker: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= values.length) return;
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
