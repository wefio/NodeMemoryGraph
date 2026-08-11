import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ShadowEvaluationEvent,
  ShadowFeedbackEvent,
} from "../../src/lab/shadow-evaluation.ts";

const LABELS = [
  "taskSuccess",
  "userCorrection",
  "evidenceSufficient",
  "expansionUseful",
  "excessiveNoise",
  "noMemoryNeeded",
] as const;

export interface ShadowCoverageReport {
  events: number;
  retrievals: number;
  uses: number;
  outcomes: number;
  feedback: number;
  toolFlow: number;
  searchSuppressed: number;
  feedbackNudgesShown: number;
  graphs: number;
  queryTasks: number;
  semanticTasks: number;
  timeRange: { first: string | null; last: string | null };
  origins: { automatic: number; tool: number };
  injection: { characters: number; estimatedTokens: number };
  labels: Record<(typeof LABELS)[number], number>;
  fullyLabelledGraphs: number;
  calibrationReady: false;
  blockers: string[];
}

export function summarizeShadowEvents(
  events: readonly ShadowEvaluationEvent[],
): ShadowCoverageReport {
  const graphs = new Set(events.map((event) => event.graphId));
  const retrievals = events.filter((event) => event.type === "retrieval");
  const queryTasks = new Set(retrievals.map((event) => event.queryTaskId).filter(Boolean));
  const feedback = events.filter(
    (event): event is ShadowFeedbackEvent => event.type === "feedback",
  );
  const semanticTasks = new Set(
    feedback.flatMap((event) => (event.semanticTaskId ? [event.semanticTaskId] : [])),
  );
  const labels = Object.fromEntries(
    LABELS.map((label) => [
      label,
      feedback.filter((event) => typeof event[label] === "boolean").length,
    ]),
  ) as ShadowCoverageReport["labels"];
  const fullyLabelledGraphs = new Set(
    feedback
      .filter(
        (event) =>
          typeof event.semanticTaskId === "string" &&
          typeof event.evidenceSufficient === "boolean" &&
          typeof event.expansionUseful === "boolean" &&
          typeof event.excessiveNoise === "boolean" &&
          typeof event.noMemoryNeeded === "boolean",
      )
      .map((event) => event.graphId),
  ).size;
  const timestamps = events
    .map((event) => event.recordedAt)
    .filter((value) => !Number.isNaN(Date.parse(value)))
    .sort();
  const blockers: string[] = [];
  if (retrievals.length === 0) blockers.push("no retrieval traces");
  if (semanticTasks.size === 0) blockers.push("no semantic task identifiers");
  if (fullyLabelledGraphs === 0) blockers.push("no separately labelled retrieval outcomes");
  blockers.push(
    "candidate promotion requires a held-out time/task split and matched shadow result",
  );
  return {
    events: events.length,
    retrievals: retrievals.length,
    uses: events.filter((event) => event.type === "use").length,
    outcomes: events.filter((event) => event.type === "outcome").length,
    feedback: feedback.length,
    toolFlow: events.filter((event) => event.type === "tool_flow").length,
    searchSuppressed: events.filter(
      (event) => event.type === "tool_flow" && event.action === "search_suppressed",
    ).length,
    feedbackNudgesShown: events.filter(
      (event) => event.type === "tool_flow" && event.action === "feedback_nudge_shown",
    ).length,
    graphs: graphs.size,
    queryTasks: queryTasks.size,
    semanticTasks: semanticTasks.size,
    timeRange: {
      first: timestamps.at(0) ?? null,
      last: timestamps.at(-1) ?? null,
    },
    origins: {
      automatic: retrievals.filter((event) => event.origin === "automatic").length,
      tool: retrievals.filter((event) => event.origin === "tool").length,
    },
    injection: {
      characters: retrievals.reduce((sum, event) => sum + (event.costs.injectedCharacters ?? 0), 0),
      estimatedTokens: retrievals.reduce(
        (sum, event) => sum + (event.costs.injectedEstimatedTokens ?? 0),
        0,
      ),
    },
    labels,
    fullyLabelledGraphs,
    calibrationReady: false,
    blockers,
  };
}

export function readShadowEvents(path: string): ShadowEvaluationEvent[] {
  const files = [4, 3, 2, 1]
    .map((suffix) => `${path}.${suffix}`)
    .concat(path)
    .filter(existsSync);
  return files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const event = JSON.parse(line) as ShadowEvaluationEvent;
          return event?.version === 1 && typeof event.graphId === "string" ? [event] : [];
        } catch {
          return [];
        }
      }),
  );
}

export function resolveShadowEventPath(
  argument: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  return resolve(
    argument ??
      join(environment.NMG_DATA_DIR ?? join(cwd, ".nmg"), "controller-shadow-events.jsonl"),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = resolveShadowEventPath(process.argv[2]);
  process.stdout.write(
    `${JSON.stringify({ path, ...summarizeShadowEvents(readShadowEvents(path)) }, null, 2)}\n`,
  );
}
