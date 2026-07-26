import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { RpcClient, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";

interface Case {
  id: string;
  setup: string;
  updates: string[];
  expected: string[][];
  unsupportedMarkers: string[];
}

const root = resolve(import.meta.dirname, "../..");
const cliPath = resolve(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const extensionPath = resolve(root, ".pi/extensions/nmg/index.ts");
const model = process.env.NMG_PI_MODEL || "deepseek/deepseek-v4-flash";
const repeats = Math.max(1, Number.parseInt(process.env.NMG_REASONING_REPEATS ?? "1", 10));
const allCases: Case[] = [
  {
    id: "debugging",
    setup:
      "Investigate a failing deployment. Track hypotheses, evidence, rejected paths, and the next action.",
    updates: [
      "Observation: DNS resolution succeeds from both the host and the container.",
      "Observation: requests fail only after credential rotation; old workers still use key K17.",
      "Evidence: a worker restarted with key K18 succeeds immediately. Reject DNS as the root cause.",
      "Decision: restart remaining workers, then verify all report key K18.",
    ],
    expected: [["K17"], ["K18"], ["restart"], ["DNS"]],
    unsupportedMarkers: ["graceful-drain", "pipeline", "hot-reload"],
  },
  {
    id: "planning",
    setup:
      "Plan a migration. Track hard constraints, discarded options, the decision, and the next action.",
    updates: [
      "Constraint: downtime must remain below five minutes.",
      "Evidence: full-copy migration took 42 minutes in staging, so reject full-copy.",
      "Decision: use dual-write followed by a read cutover.",
      "Next action: run a 24-hour dual-write consistency check before cutover.",
    ],
    expected: [["five", "5"], ["full-copy"], ["dual-write"], ["24-hour", "24 hour"]],
    unsupportedMarkers: ["backfill", "rollback"],
  },
  {
    id: "incident",
    setup:
      "Diagnose an intermittent data error. Preserve observations, competing hypotheses, conclusions, and follow-up.",
    updates: [
      "Observation: corruption appears only in records written by node B.",
      "Evidence: node B is the only node running serializer version 3.1.",
      "Evidence: upgrading node B to serializer 3.2 stops new corruption; reject the storage-engine hypothesis.",
      "Next action: backfill records written by node B before the upgrade.",
    ],
    expected: [["node B"], ["3.1"], ["3.2"], ["backfill"]],
    unsupportedMarkers: ["hardware", "network", "clock skew"],
  },
];
const requestedCase = process.env.NMG_REASONING_CASE?.trim();
const cases = requestedCase
  ? allCases.filter((testCase) => testCase.id === requestedCase)
  : allCases;
if (cases.length === 0) throw new Error(`Unknown NMG_REASONING_CASE: ${requestedCase}`);

const runId = new Date().toISOString().replaceAll(":", "-");
const outputDirectory = resolve(import.meta.dirname, "results", runId);
mkdirSync(outputDirectory, { recursive: true });

const trials = cases.flatMap((testCase) =>
  Array.from({ length: repeats }, (_, repeat) =>
    (["full", "compact"] as const).flatMap((contextMode) =>
      (["baseline", "workspace"] as const).map((arm) => ({
        testCase,
        repeat,
        contextMode,
        arm,
      })),
    ),
  ).flat(),
);

const results = await mapConcurrent(
  trials,
  Math.max(1, Number.parseInt(process.env.NMG_REASONING_CONCURRENCY ?? "4", 10)),
  async (trial) => {
    process.stderr.write(
      `[${trial.testCase.id}] ${trial.contextMode}/${trial.arm} repeat=${trial.repeat}\n`,
    );
    return runTrial(trial);
  },
);

const grouped = Object.fromEntries(
  (["full", "compact"] as const).flatMap((contextMode) =>
    (["baseline", "workspace"] as const).map((arm) => {
      const rows = results.filter((row) => row.contextMode === contextMode && row.arm === arm);
      return [
        `${contextMode}/${arm}`,
        {
          trials: rows.length,
          exactTaskSuccess:
            rows.filter((row) => row.matchedExpected === row.expectedCount).length / rows.length,
          meanExpectedRecall:
            rows.reduce((sum, row) => sum + row.matchedExpected / row.expectedCount, 0) /
            rows.length,
          meanLatencyMs: rows.reduce((sum, row) => sum + row.latencyMs, 0) / rows.length,
          meanWorkspaceNodes: rows.reduce((sum, row) => sum + row.workspaceNodes, 0) / rows.length,
          meanUnsupportedWorkspaceClaims:
            rows.reduce((sum, row) => sum + row.unsupportedWorkspaceClaims, 0) / rows.length,
          meanAssistantMessages:
            rows.reduce((sum, row) => sum + row.assistantMessages, 0) / rows.length,
          meanToolCalls: rows.reduce((sum, row) => sum + row.toolCalls, 0) / rows.length,
          meanReasoningToolMs:
            rows.reduce((sum, row) => sum + row.reasoningToolMs, 0) / rows.length,
          meanInputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0) / rows.length,
          meanOutputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0) / rows.length,
        },
      ];
    }),
  ),
);

const report = {
  runId,
  model,
  repeats,
  caseCount: cases.length,
  protocol:
    "Same prompts and model; workspace arm exposes Lab nmg_reason. Compact mode invokes Pi's normal compactor before the final question.",
  grouped,
  results,
};
writeFileSync(resolve(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function runTrial(trial: {
  testCase: Case;
  repeat: number;
  contextMode: "full" | "compact";
  arm: "baseline" | "workspace";
}) {
  const trialDirectory = resolve(
    outputDirectory,
    trial.testCase.id,
    `${trial.contextMode}-${trial.arm}-${trial.repeat}`,
  );
  mkdirSync(trialDirectory, { recursive: true });
  const client = createClient(trial.arm, trialDirectory);
  const telemetry = {
    assistantMessages: 0,
    toolCalls: 0,
    reasoningToolMs: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  const toolStarts = new Map<string, number>();
  const unsubscribe = client.onEvent((event) => observeEvent(event, telemetry, toolStarts));
  const startedAt = performance.now();
  let answer = "";
  let error: string | null = null;
  try {
    await client.start();
    await client.promptAndWait(
      `${trial.testCase.setup}\nMaintain concise task state using any available tools. Reply only ACK.`,
      undefined,
      180_000,
    );
    for (const update of trial.testCase.updates) {
      await client.promptAndWait(
        `${update}\nUpdate task state if useful. Reply only ACK.`,
        undefined,
        180_000,
      );
    }
    if (trial.contextMode === "compact") {
      await client.promptAndWait(
        `${distractorContext()}\nThis material is unrelated archival noise. Do not add it to task state. Reply only ACK.`,
        undefined,
        180_000,
      );
      await client.compact(
        "Preserve the task objective, observations, rejected hypotheses, decisions, and next action.",
      );
    }
    await client.promptAndWait(
      "Give the final diagnosis or plan in one sentence. Include every material constraint, rejected path, version/value, decision, and next action.",
      undefined,
      180_000,
    );
    answer = (await client.getLastAssistantText()) ?? "";
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    unsubscribe();
    await client.stop();
  }
  const foldedAnswer = answer.toLocaleLowerCase();
  const matchedExpected = trial.testCase.expected.filter((alternatives) =>
    alternatives.some((item) => foldedAnswer.includes(item.toLocaleLowerCase())),
  ).length;
  const workspace = readWorkspace(trialDirectory);
  const workspaceText = workspace.contents.join("\n").toLocaleLowerCase();
  const unsupportedWorkspaceClaims = trial.testCase.unsupportedMarkers.filter((marker) =>
    workspaceText.includes(marker.toLocaleLowerCase()),
  ).length;
  return {
    caseId: trial.testCase.id,
    repeat: trial.repeat,
    contextMode: trial.contextMode,
    arm: trial.arm,
    expectedCount: trial.testCase.expected.length,
    matchedExpected,
    latencyMs: Math.round(performance.now() - startedAt),
    workspaceNodes: workspace.nodeCount,
    unsupportedWorkspaceClaims,
    ...telemetry,
    answer,
    error,
  };
}

function createClient(arm: "baseline" | "workspace", dataDirectory: string): RpcClient {
  return new RpcClient({
    cliPath,
    cwd: root,
    env: {
      ...definedEnvironment(),
      NMG_DATA_DIR: dataDirectory,
      NMG_ENABLE_LAB_TOOLS: "1",
      NMG_CONTROLLER_SHADOW: "0",
    },
    args: [
      "--offline",
      "--approve",
      "--no-session",
      "--no-extensions",
      "--model",
      model,
      "--thinking",
      "off",
      ...(arm === "workspace"
        ? ["--tools", "nmg_reason", "--extension", extensionPath]
        : ["--no-tools"]),
    ],
  });
}

function observeEvent(
  event: AgentSessionEvent,
  telemetry: {
    assistantMessages: number;
    toolCalls: number;
    reasoningToolMs: number;
    inputTokens: number;
    outputTokens: number;
  },
  toolStarts: Map<string, number>,
): void {
  if (event.type === "message_end" && event.message.role === "assistant") {
    telemetry.assistantMessages += 1;
    telemetry.inputTokens += event.message.usage.input;
    telemetry.outputTokens += event.message.usage.output;
  } else if (event.type === "tool_execution_start") {
    telemetry.toolCalls += 1;
    toolStarts.set(event.toolCallId, performance.now());
  } else if (event.type === "tool_execution_end") {
    const startedAt = toolStarts.get(event.toolCallId);
    if (startedAt !== undefined && event.toolName === "nmg_reason") {
      telemetry.reasoningToolMs += performance.now() - startedAt;
    }
    toolStarts.delete(event.toolCallId);
  }
}

function readWorkspace(dataDirectory: string): { nodeCount: number; contents: string[] } {
  const directory = resolve(dataDirectory, "reasoning");
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .reduce(
        (summary, name) => {
          const state = JSON.parse(readFileSync(resolve(directory, name), "utf8")) as {
            nodes?: Array<{ content?: string }>;
          };
          summary.nodeCount += state.nodes?.length ?? 0;
          summary.contents.push(...(state.nodes ?? []).map((node) => node.content ?? ""));
          return summary;
        },
        { nodeCount: 0, contents: [] as string[] },
      );
  } catch {
    return { nodeCount: 0, contents: [] };
  }
}

function definedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function distractorContext(): string {
  return Array.from(
    { length: 1_600 },
    (_, index) =>
      `Archive item ${index}: telemetry channel ${index % 37} reported nominal status; ` +
      `reference checksum ${(index * 2_654_435_761).toString(16)}.`,
  ).join("\n");
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function runWorker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => runWorker()),
  );
  return results;
}
