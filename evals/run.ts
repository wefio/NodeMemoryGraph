import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { RpcClient } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { decideMemoryLoad, NmgStore } from "../src/index.ts";
import type { MemoryLoadMode, MemoryTier } from "../src/core/types.ts";

interface EvalCase {
  id: string;
  description: string;
  automaticWrite?: boolean;
  expectRemember?: boolean;
  writerPrompt?: string;
  memory: {
    statement: string;
    nodeName: string;
    evidence: string;
    tier: MemoryTier;
    importance: number;
    scope?: Record<string, string>;
  };
  recall: {
    prompt: string;
    expectedTerms: string[];
    expectedTermGroups?: string[][];
    forbiddenTerms?: string[];
    requireSearchTool: boolean;
    requireGetTool?: boolean;
  };
}

interface EvalResult {
  id: string;
  passed: boolean;
  writerRemembered: boolean;
  sessionArchived: boolean;
  databaseVerified: boolean;
  readerLoadMode: MemoryLoadMode;
  readerSearched: boolean;
  readerGot: boolean;
  answerMatched: boolean;
  answer: string;
  errors: string[];
}

const root = resolve(import.meta.dirname, "..");
const allCases = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "cases/core.json"), "utf8"),
) as EvalCase[];
const cases = process.env.NMG_EVAL_CASE
  ? allCases.filter((testCase) => testCase.id === process.env.NMG_EVAL_CASE)
  : allCases;
if (cases.length === 0) throw new Error("NMG_EVAL_CASE did not match a test case");
const runId = new Date().toISOString().replaceAll(":", "-");
const runDirectory = resolve(import.meta.dirname, "results", runId);
mkdirSync(runDirectory, { recursive: true });

const concurrency = Math.max(1, Math.min(
  Number.parseInt(process.env.NMG_EVAL_CONCURRENCY ?? "3", 10) || 3,
  cases.length,
));
const results = await mapConcurrent(cases, concurrency, runCase);
const report = {
  runId,
  model: "deepseek/deepseek-v4-flash",
  passed: results.filter((result) => result.passed).length,
  total: results.length,
  results,
};

writeFileSync(
  resolve(runDirectory, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.passed !== report.total) process.exitCode = 1;

async function runCase(testCase: EvalCase): Promise<EvalResult> {
  const dataDirectory = resolve(runDirectory, testCase.id);
  mkdirSync(dataDirectory, { recursive: true });

  const errors: string[] = [];
  let writerRemembered = false;
  let sessionArchived = false;
  let databaseVerified = false;
  const readerLoadMode = decideMemoryLoad(testCase.recall.prompt).mode;
  let readerSearched = false;
  let readerGot = false;
  let answerMatched = false;
  let answer = "";

  try {
    const writer = createClient(dataDirectory);
    let writerSessionId = "";
    try {
      await writer.start();
      await writer.setThinkingLevel("low");
      writerSessionId = (await writer.getState()).sessionId;
      const events = await writer.promptAndWait(writerPrompt(testCase), undefined, 180_000);
      writerRemembered = successfulToolCall(events, "nmg_remember");
      if (!writerRemembered && !(await writer.getLastAssistantText())?.trim()) {
        errors.push(`Writer returned no assistant text; events=${summarizeEvents(events)}; ` +
          `stderr=${writer.getStderr().trim() || "<empty>"}`);
      }
      if (writerRemembered !== (testCase.expectRemember ?? true)) {
        errors.push(
          writerRemembered
            ? "Writer saved a memory that policy requires it to reject."
            : "Writer did not complete the expected nmg_remember call.",
        );
      }
    } finally {
      await writer.stop();
    }

    const store = new NmgStore(resolve(dataDirectory, "nmg.sqlite"));
    try {
      sessionArchived = store.getSessionArchive(writerSessionId) !== null;
      if (!sessionArchived) errors.push("Writer session transcript was not archived.");
      const memoryExists = testCase.automaticWrite
        ? store
            .search(
              testCase.expectRemember === false
                ? testCase.memory.statement
                : expectedGroups(testCase).flat().join(" "),
              { maxTier: 3, limit: 20, includeHistorical: true },
            )
            .some((result) =>
              (testCase.expectRemember === false
                ? [testCase.memory.statement]
                : testCase.recall.expectedTerms
              ).every((term) =>
                result.memory.statement
                  .toLocaleLowerCase()
                  .includes(term.toLocaleLowerCase()),
              ) || matchesExpected(result.memory.statement, expectedGroups(testCase)),
            )
        : store
            .search(testCase.memory.statement, {
              nodeName: testCase.memory.nodeName,
              maxTier: 3,
              limit: 10,
            })
            .some(
              (result) =>
                result.memory.statement === testCase.memory.statement &&
                result.evidence.content === testCase.memory.evidence,
            );
      databaseVerified = memoryExists === (testCase.expectRemember ?? true);
      if (!databaseVerified) {
        errors.push(
          memoryExists
            ? "Forbidden semantic memory was persisted."
            : "Expected statement/evidence was not persisted.",
        );
      }
    } finally {
      store.close();
    }

    const reader = createClient(dataDirectory);
    try {
      await reader.start();
      await reader.setThinkingLevel("low");
      const events = await reader.promptAndWait(testCase.recall.prompt, undefined, 180_000);
      readerSearched = successfulToolCall(events, "nmg_search");
      readerGot = successfulToolCall(events, "nmg_get");
      answer = (await reader.getLastAssistantText())?.trim() ?? "";
      if (!answer) {
        errors.push(`Reader returned no assistant text; events=${summarizeEvents(events)}; ` +
          `stderr=${reader.getStderr().trim() || "<empty>"}`);
      }
      answerMatched = matchesExpected(answer, expectedGroups(testCase)) &&
        (testCase.recall.forbiddenTerms ?? []).every(
          (term) => !answer.toLocaleLowerCase().includes(term.toLocaleLowerCase()),
        );

      if (testCase.recall.requireSearchTool &&
          readerLoadMode !== "retrieve" && !readerSearched) {
        errors.push("Reader did not complete the required nmg_search call.");
      }
      if (testCase.recall.requireGetTool && !readerGot) {
        errors.push("Reader did not complete the required nmg_get call.");
      }
      if (!answerMatched) errors.push("Reader answer did not contain all expected terms.");
    } finally {
      await reader.stop();
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return {
    id: testCase.id,
    passed:
      writerRemembered === (testCase.expectRemember ?? true) &&
      sessionArchived &&
      databaseVerified &&
      answerMatched &&
      (!testCase.recall.requireSearchTool || readerLoadMode === "retrieve" || readerSearched) &&
      (!testCase.recall.requireGetTool || readerGot),
    writerRemembered,
    sessionArchived,
    databaseVerified,
    readerLoadMode,
    readerSearched,
    readerGot,
    answerMatched,
    answer,
    errors,
  };
}

function expectedGroups(testCase: EvalCase): string[][] {
  return testCase.recall.expectedTermGroups ??
    testCase.recall.expectedTerms.map((term) => [term]);
}

function matchesExpected(value: string, groups: string[][]): boolean {
  const normalized = value.toLocaleLowerCase();
  return groups.every((group) =>
    group.some((term) => normalized.includes(term.toLocaleLowerCase())),
  );
}

function createClient(dataDirectory: string): RpcClient {
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
      NMG_DATA_DIR: dataDirectory,
    },
    args: [
      "--offline",
      "--approve",
      "--no-session",
      "--extension",
      resolve(root, ".pi/extensions/nmg/index.ts"),
    ],
  });
}

function writerPrompt(testCase: EvalCase): string {
  if (testCase.automaticWrite) return testCase.writerPrompt ?? testCase.memory.evidence;
  return [
    "You are the writer in an automated NMG evaluation.",
    "Call nmg_remember exactly once using these exact arguments:",
    JSON.stringify(testCase.memory),
    "Do not alter, translate, or summarize any value.",
    "After the tool succeeds, answer only SAVED.",
  ].join("\n");
}

function successfulToolCall(events: AgentSessionEvent[], toolName: string): boolean {
  return events.some(
    (event) =>
      event.type === "tool_execution_end" &&
      event.toolName === toolName &&
      !event.isError,
  );
}

function summarizeEvents(events: AgentSessionEvent[]): string {
  return events.map((event) => {
    const candidate = event as AgentSessionEvent & {
      error?: unknown;
      reason?: unknown;
      message?: { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown };
    };
    const message = candidate.message
      ? `:${String(candidate.message.role ?? "")}:${String(candidate.message.stopReason ?? "")}` +
        `:${String(candidate.message.errorMessage ?? "")}:` +
        `${JSON.stringify(candidate.message.content ?? "").slice(0, 240)}`
      : "";
    return `${event.type}${candidate.error ? `:${String(candidate.error)}` : ""}` +
      `${candidate.reason ? `:${String(candidate.reason)}` : ""}${message}`;
  }).join(",") || "<none>";
}

function definedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await worker(values[index]!);
    }
  }));
  return results;
}
