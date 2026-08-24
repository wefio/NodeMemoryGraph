import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ShadowEvaluationEvent,
  ShadowAttributionEvent,
  ShadowFeedbackEvent,
  ShadowOutcomeEvent,
  ShadowRetrievalEvent,
} from "../../src/lab/shadow-evaluation.ts";
import {
  CONTROLLER_FEATURE_COUNT,
  CONTROLLER_FEATURE_PROTOCOL_VERSION,
} from "../../src/lab/controller-protocol.ts";
import { aggregateFeedbackByGraph, readShadowEvents, resolveShadowEventPath } from "./report.ts";
import { independentGroups } from "./independence.ts";

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
  attribution: ShadowAttributionEvent | null;
  outcome: ShadowOutcomeEvent | null;
  feedback: ShadowFeedbackEvent;
}

export interface ShadowDataset {
  rows: ShadowDatasetRow[];
  tasks: { total: number; train: number; validation: number };
  excludedGraphs: number;
  legacyGraphsWithoutReplayInputs: number;
  graphsWithoutVerifiedAttribution: number;
  blockers: string[];
}

export interface ShadowDatasetSummary {
  rows: number;
  rowsBySplit: { train: number; validation: number };
  tasks: ShadowDataset["tasks"];
  excludedGraphs: number;
  legacyGraphsWithoutReplayInputs: number;
  graphsWithoutVerifiedAttribution: number;
  blockers: string[];
}

export function summarizeShadowDataset(dataset: ShadowDataset): ShadowDatasetSummary {
  return {
    rows: dataset.rows.length,
    rowsBySplit: {
      train: dataset.rows.filter((row) => row.split === "train").length,
      validation: dataset.rows.filter((row) => row.split === "validation").length,
    },
    tasks: dataset.tasks,
    excludedGraphs: dataset.excludedGraphs,
    legacyGraphsWithoutReplayInputs: dataset.legacyGraphsWithoutReplayInputs,
    graphsWithoutVerifiedAttribution: dataset.graphsWithoutVerifiedAttribution,
    blockers: dataset.blockers,
  };
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
  const feedbackByGraph = aggregateFeedbackByGraph(events);
  let legacyGraphsWithoutReplayInputs = 0;
  let graphsWithoutVerifiedAttribution = 0;
  for (const [graphId, group] of byGraph) {
    const retrieval = group.find(
      (event): event is ShadowRetrievalEvent => event.type === "retrieval",
    );
    const feedback = feedbackByGraph.get(graphId);
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
    const attribution =
      [...group]
        .reverse()
        .find(
          (event): event is ShadowAttributionEvent =>
            event.type === "attribution" && event.method === "verified_claim_support",
        ) ?? null;
    if (!attribution) graphsWithoutVerifiedAttribution += 1;
    joined.push({
      semanticTaskId: feedback.semanticTaskId,
      graphId,
      sessionId: retrieval.sessionId,
      recordedAt: retrieval.recordedAt,
      retrieval,
      attribution,
      outcome:
        [...group]
          .reverse()
          .find((event): event is ShadowOutcomeEvent => event.type === "outcome") ?? null,
      feedback,
    });
  }

  const groups = independentGroups(joined);
  const boundedFraction = Math.min(0.5, Math.max(0.05, validationFraction));
  const validationCount =
    groups.length < 2 ? 0 : Math.max(1, Math.ceil(groups.length * boundedFraction));
  const validationRows = new Set(
    groups.slice(groups.length - validationCount).flatMap((group) => group.rowIndexes),
  );
  const rows: ShadowDatasetRow[] = joined
    .map((row, index): ShadowDatasetRow => ({
      ...row,
      split: validationRows.has(index) ? "validation" : "train",
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
  if (graphsWithoutVerifiedAttribution > 0) {
    blockers.push(
      `${graphsWithoutVerifiedAttribution} labelled graph(s) lack verified claim attribution; ` +
        "they are control-label-only and cannot supervise evidence ranking or budgets",
    );
  }
  if (groups.length < 2) blockers.push("at least two independent session/task groups are required");
  if (!rows.some((row) => row.split === "train")) blockers.push("no training split");
  if (!rows.some((row) => row.split === "validation")) blockers.push("no validation split");
  return {
    rows,
    tasks: {
      total: groups.length,
      train: groups.length - validationCount,
      validation: validationCount,
    },
    excludedGraphs: byGraph.size - new Set(rows.map((row) => row.graphId)).size,
    legacyGraphsWithoutReplayInputs,
    graphsWithoutVerifiedAttribution,
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
  const args = process.argv.slice(2);
  const compact = args.includes("--compact");
  const positional = args.filter((arg) => arg !== "--compact");
  const path = resolveShadowEventPath(positional[0]);
  const dataset = buildShadowDataset(readShadowEvents(path));
  process.stdout.write(
    `${JSON.stringify({ path, ...(compact ? summarizeShadowDataset(dataset) : dataset) }, null, 2)}\n`,
  );
}
