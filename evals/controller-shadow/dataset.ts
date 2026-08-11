import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ShadowEvaluationEvent,
  ShadowFeedbackEvent,
  ShadowOutcomeEvent,
  ShadowRetrievalEvent,
  ShadowUseEvent,
} from "../../src/lab/shadow-evaluation.ts";
import {
  CONTROLLER_FEATURE_COUNT,
  CONTROLLER_FEATURE_PROTOCOL_VERSION,
} from "../../src/lab/controller-protocol.ts";
import { readShadowEvents, resolveShadowEventPath } from "./report.ts";

const REQUIRED_LABELS = [
  "evidenceSufficient",
  "expansionUseful",
  "excessiveNoise",
  "noMemoryNeeded",
] as const;

export interface ShadowDatasetRow {
  split: "train" | "validation";
  semanticTaskId: string;
  graphId: string;
  sessionId: string;
  recordedAt: string;
  retrieval: ShadowRetrievalEvent;
  use: ShadowUseEvent | null;
  outcome: ShadowOutcomeEvent | null;
  feedback: ShadowFeedbackEvent;
}

export interface ShadowDataset {
  rows: ShadowDatasetRow[];
  tasks: { total: number; train: number; validation: number };
  excludedGraphs: number;
  legacyGraphsWithoutReplayInputs: number;
  blockers: string[];
}

/**
 * Join shadow events without inventing labels, then split whole semantic tasks
 * chronologically. Repeated attempts of one task can never leak across splits.
 */
export function buildShadowDataset(
  events: readonly ShadowEvaluationEvent[],
  validationFraction = 0.2,
): ShadowDataset {
  const byGraph = new Map<string, ShadowEvaluationEvent[]>();
  for (const event of events) {
    const group = byGraph.get(event.graphId) ?? [];
    group.push(event);
    byGraph.set(event.graphId, group);
  }

  const joined: Omit<ShadowDatasetRow, "split">[] = [];
  let legacyGraphsWithoutReplayInputs = 0;
  for (const [graphId, group] of byGraph) {
    const retrieval = group.find(
      (event): event is ShadowRetrievalEvent => event.type === "retrieval",
    );
    const feedback = [...group]
      .reverse()
      .find((event): event is ShadowFeedbackEvent => event.type === "feedback");
    if (
      !retrieval ||
      feedback?.collectionOrigin !== "natural" ||
      !feedback.semanticTaskId ||
      !hasRequiredLabels(feedback)
    )
      continue;
    if (!hasReplayableFeatures(retrieval)) {
      legacyGraphsWithoutReplayInputs += 1;
      continue;
    }
    joined.push({
      semanticTaskId: feedback.semanticTaskId,
      graphId,
      sessionId: retrieval.sessionId,
      recordedAt: retrieval.recordedAt,
      retrieval,
      use:
        [...group].reverse().find((event): event is ShadowUseEvent => event.type === "use") ?? null,
      outcome:
        [...group]
          .reverse()
          .find((event): event is ShadowOutcomeEvent => event.type === "outcome") ?? null,
      feedback,
    });
  }

  const taskTimes = new Map<string, number>();
  for (const row of joined) {
    const timestamp = Date.parse(row.recordedAt);
    taskTimes.set(
      row.semanticTaskId,
      Math.min(taskTimes.get(row.semanticTaskId) ?? Number.POSITIVE_INFINITY, timestamp),
    );
  }
  const tasks = [...taskTimes].sort(
    ([leftId, leftTime], [rightId, rightTime]) =>
      leftTime - rightTime || leftId.localeCompare(rightId),
  );
  const boundedFraction = Math.min(0.5, Math.max(0.05, validationFraction));
  const validationCount =
    tasks.length < 2 ? 0 : Math.max(1, Math.ceil(tasks.length * boundedFraction));
  const validationTasks = new Set(tasks.slice(tasks.length - validationCount).map(([id]) => id));
  const rows: ShadowDatasetRow[] = joined
    .map((row): ShadowDatasetRow => ({
      ...row,
      split: validationTasks.has(row.semanticTaskId) ? "validation" : "train",
    }))
    .sort(
      (left, right) =>
        Date.parse(left.recordedAt) - Date.parse(right.recordedAt) ||
        left.graphId.localeCompare(right.graphId),
    );
  const blockers: string[] = [];
  if (rows.length === 0) blockers.push("no fully labelled graph rows");
  if (legacyGraphsWithoutReplayInputs > 0) {
    blockers.push(
      `${legacyGraphsWithoutReplayInputs} labelled graph(s) lack replayable controller inputs`,
    );
  }
  if (tasks.length < 2) blockers.push("at least two independent semantic tasks are required");
  if (!rows.some((row) => row.split === "train")) blockers.push("no training split");
  if (!rows.some((row) => row.split === "validation")) blockers.push("no validation split");
  return {
    rows,
    tasks: {
      total: tasks.length,
      train: tasks.length - validationCount,
      validation: validationCount,
    },
    excludedGraphs: byGraph.size - new Set(rows.map((row) => row.graphId)).size,
    legacyGraphsWithoutReplayInputs,
    blockers,
  };
}

function hasRequiredLabels(feedback: ShadowFeedbackEvent): boolean {
  return REQUIRED_LABELS.every((label) => typeof feedback[label] === "boolean");
}

function hasReplayableFeatures(retrieval: ShadowRetrievalEvent): boolean {
  const snapshot = retrieval.controllerFeatures;
  if (
    !snapshot ||
    !retrieval.budget ||
    typeof retrieval.costs.graphHops !== "number" ||
    snapshot.protocolVersion !== CONTROLLER_FEATURE_PROTOCOL_VERSION ||
    snapshot.global.length !== CONTROLLER_FEATURE_COUNT
  ) {
    return false;
  }
  return [snapshot.memories, snapshot.nodes, snapshot.edges].every((features) =>
    Object.values(features).every((vector) => vector.length === CONTROLLER_FEATURE_COUNT),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = resolveShadowEventPath(process.argv[2]);
  process.stdout.write(
    `${JSON.stringify({ path, ...buildShadowDataset(readShadowEvents(path)) }, null, 2)}\n`,
  );
}
