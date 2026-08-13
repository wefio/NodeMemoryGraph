import { createHash } from "node:crypto";

import type {
  ShadowEvaluationEvent,
  ShadowFeedbackEvent,
  ShadowOutcomeEvent,
  ShadowRetrievalEvent,
  ShadowUseEvent,
} from "../../src/lab/shadow-evaluation.ts";
import { aggregateFeedbackByGraph } from "../controller-shadow/report.ts";
import { independentGroups } from "../controller-shadow/independence.ts";

export type RecallAction = "answer" | "expand" | "stop";
export type SkillOptSplit = "train" | "val" | "test";

export interface SkillOptPolicyItem {
  id: string;
  semantic_task_id: string;
  split: SkillOptSplit;
  task_type: string;
  query: string;
  state: {
    origin: ShadowRetrievalEvent["origin"];
    candidate_count: number;
    selected_count: number;
    exact_use_count: number;
    qpp_trigger: boolean | null;
    qpp_reason: string | null;
    deepest_tier: number;
    graph_hops: number;
    records_read: number;
    estimated_tokens: number;
    retrieval_latency_ms: number;
    tool_rounds: number | null;
  };
  expected: {
    recall_action: RecallAction;
    fold_noise: boolean;
  };
  provenance: {
    graph_id: string;
    session_id_hash: string;
    recorded_at: string;
  };
}

export interface SkillOptDataset {
  items: SkillOptPolicyItem[];
  counts: Record<SkillOptSplit | "tasks" | "action_classes" | "noise_labels", number>;
  excluded_graphs: number;
  ready: boolean;
  blockers: string[];
}

export interface SkillOptDatasetOptions {
  minimumTasks?: number;
  minimumTrainTasks?: number;
  minimumValidationTasks?: number;
  minimumTestTasks?: number;
  minimumActionClasses?: number;
  minimumNoiseLabels?: number;
}

const REQUIRED_LABELS = [
  "evidenceSufficient",
  "expansionUseful",
  "excessiveNoise",
  "noMemoryNeeded",
] as const;

/**
 * Materialize only explicit, fully labelled retrieval outcomes. Facts,
 * evidence text, memory statements, and hidden reasoning never enter this
 * policy dataset. Whole semantic tasks are assigned to one chronological
 * split so retries cannot leak across train/selection/test.
 */
export function buildSkillOptPolicyDataset(
  events: readonly ShadowEvaluationEvent[],
  options: SkillOptDatasetOptions = {},
): SkillOptDataset {
  const byGraph = new Map<string, ShadowEvaluationEvent[]>();
  for (const event of events) {
    const group = byGraph.get(event.graphId) ?? [];
    group.push(event);
    byGraph.set(event.graphId, group);
  }

  const joined: Array<{
    retrieval: ShadowRetrievalEvent;
    feedback: ShadowFeedbackEvent;
    use: ShadowUseEvent | null;
    outcome: ShadowOutcomeEvent | null;
  }> = [];
  const feedbackByGraph = aggregateFeedbackByGraph(events);
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
    joined.push({
      retrieval,
      feedback,
      use:
        [...group].reverse().find((event): event is ShadowUseEvent => event.type === "use") ?? null,
      outcome:
        [...group]
          .reverse()
          .find((event): event is ShadowOutcomeEvent => event.type === "outcome") ?? null,
    });
  }

  const groups = independentGroups(
    joined.map((row) => ({
      semanticTaskId: row.feedback.semanticTaskId!,
      sessionId: row.retrieval.sessionId,
      recordedAt: row.retrieval.recordedAt,
    })),
  );
  const required = {
    tasks: options.minimumTasks ?? 24,
    train: options.minimumTrainTasks ?? 12,
    val: options.minimumValidationTasks ?? 6,
    test: options.minimumTestTasks ?? 6,
    action_classes: options.minimumActionClasses ?? 2,
    noise_labels: options.minimumNoiseLabels ?? 2,
  };
  const splitByRow = chronologicalSplits(groups, required);
  const items = joined
    .map(({ retrieval, feedback, use, outcome }, index): SkillOptPolicyItem => {
      const expected = expectedDecision(feedback);
      return {
        id: retrieval.graphId,
        semantic_task_id: feedback.semanticTaskId!,
        split: splitByRow.get(index)!,
        task_type: `${expected.recall_action}:${expected.fold_noise ? "fold" : "keep"}`,
        query: retrieval.query,
        state: {
          origin: retrieval.origin,
          candidate_count: retrieval.candidateMemoryIds.length,
          selected_count: retrieval.selections.length,
          exact_use_count: use?.usedMemoryIds.length ?? 0,
          qpp_trigger: retrieval.qpp?.trigger ?? null,
          qpp_reason: retrieval.qpp?.reason ?? null,
          deepest_tier: retrieval.costs.deepestTier,
          graph_hops: retrieval.costs.graphHops ?? 0,
          records_read: retrieval.costs.recordsRead,
          estimated_tokens: retrieval.costs.estimatedTokens,
          retrieval_latency_ms: retrieval.costs.retrievalLatencyMs,
          tool_rounds: outcome?.toolRounds ?? null,
        },
        expected,
        provenance: {
          graph_id: retrieval.graphId,
          session_id_hash: hash(retrieval.sessionId),
          recorded_at: retrieval.recordedAt,
        },
      };
    })
    .sort(
      (left, right) =>
        Date.parse(left.provenance.recorded_at) - Date.parse(right.provenance.recorded_at) ||
        left.id.localeCompare(right.id),
    );

  const counts = {
    train: groups.filter((group) => splitByRow.get(group.rowIndexes[0]!) === "train").length,
    val: groups.filter((group) => splitByRow.get(group.rowIndexes[0]!) === "val").length,
    test: groups.filter((group) => splitByRow.get(group.rowIndexes[0]!) === "test").length,
    tasks: groups.length,
    action_classes: new Set(items.map((item) => item.expected.recall_action)).size,
    noise_labels: new Set(items.map((item) => item.expected.fold_noise)).size,
  };
  const blockers = (Object.keys(required) as Array<keyof typeof required>)
    .filter((key) => counts[key] < required[key])
    .map((key) => `${key} requires ${required[key]} independent task(s), found ${counts[key]}`);
  if (items.length === 0) blockers.unshift("no fully labelled retrieval outcomes");
  return {
    items,
    counts,
    excluded_graphs: byGraph.size - new Set(items.map((item) => item.id)).size,
    ready: blockers.length === 0,
    blockers,
  };
}

function chronologicalSplits(
  groups: readonly { rowIndexes: number[] }[],
  minimums: { train: number; val: number; test: number },
): Map<number, SkillOptSplit> {
  const count = groups.length;
  if (count === 0) return new Map();
  if (count === 1) return new Map(groups[0]!.rowIndexes.map((index) => [index, "train"]));
  const readinessCount = minimums.train + minimums.val + minimums.test;
  const validationCount =
    count >= readinessCount ? minimums.val : Math.max(1, Math.floor(count * 0.2));
  const testCount =
    count >= readinessCount ? minimums.test : Math.max(1, Math.floor(count * 0.2));
  const trainEnd = count - validationCount - testCount;
  return new Map(groups.flatMap((group, index) => {
    const split = index < trainEnd ? "train" : index < trainEnd + validationCount ? "val" : "test";
    return group.rowIndexes.map((rowIndex) => [rowIndex, split] as const);
  }));
}

function expectedDecision(feedback: ShadowFeedbackEvent): SkillOptPolicyItem["expected"] {
  const recallAction: RecallAction = feedback.noMemoryNeeded
    ? "stop"
    : feedback.evidenceSufficient
      ? "answer"
      : feedback.expansionUseful
        ? "expand"
        : "stop";
  return { recall_action: recallAction, fold_noise: feedback.excessiveNoise! };
}

function hasRequiredLabels(feedback: ShadowFeedbackEvent): boolean {
  return REQUIRED_LABELS.every((label) => typeof feedback[label] === "boolean");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
