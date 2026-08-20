import type { ControllerMatchedProductMetrics } from "../../src/lab/controller-gate.ts";
import type { AgentTokenUsage } from "../agent-telemetry.ts";
import type { UnifiedRowScore } from "../official/unified-score.ts";
import type { ControllerActuationSummary } from "./controller-candidate.ts";

export interface MatchedProductRow {
  id?: string;
  questionId?: string;
  caseId?: string;
  repeat: number;
  mode: string;
  rowScore: UnifiedRowScore;
  toolRounds: number;
  tokenUsage: AgentTokenUsage | null;
  durationMs: number;
  controllerActuation?: ControllerActuationSummary | null;
}

export interface MatchedProductBlocker {
  code:
    | "candidate_does_not_affect_ranking"
    | "baseline_controller_actuation_detected"
    | "duplicate_arm_row"
    | "missing_arm_pair"
    | "missing_binary_task_success"
    | "missing_evidence_sufficiency"
    | "mismatched_evidence_kind"
    | "missing_cost_telemetry"
    | "no_complete_pairs";
  count: number;
}

export interface MatchedProductAggregation {
  baselineMode: string;
  candidateMode: string;
  pairedCases: number;
  metrics: ControllerMatchedProductMetrics | null;
  blockers: MatchedProductBlocker[];
}

export function aggregateMatchedProductMetrics(
  rows: readonly MatchedProductRow[],
  options: {
    baselineMode: string;
    candidateMode: string;
  },
): MatchedProductAggregation {
  const blockers = new Map<MatchedProductBlocker["code"], number>();
  const block = (code: MatchedProductBlocker["code"]) =>
    blockers.set(code, (blockers.get(code) ?? 0) + 1);
  const relevant = rows.filter(
    (row) => row.mode === options.baselineMode || row.mode === options.candidateMode,
  );
  const baselineRows = relevant.filter((row) => row.mode === options.baselineMode);
  const candidateRows = relevant.filter((row) => row.mode === options.candidateMode);
  if (baselineRows.some((row) => (row.controllerActuation?.changed ?? 0) > 0)) {
    block("baseline_controller_actuation_detected");
  }
  if (
    !candidateRows.some(
      (row) =>
        (row.controllerActuation?.changed ?? 0) > 0 &&
        (row.controllerActuation?.maxTrainingSteps ?? 0) > 0,
    )
  ) {
    block("candidate_does_not_affect_ranking");
  }
  const byKey = new Map<string, Partial<Record<"baseline" | "candidate", MatchedProductRow>>>();
  for (const row of relevant) {
    const id = row.caseId ?? row.questionId ?? row.id;
    if (!id) {
      block("missing_arm_pair");
      continue;
    }
    const key = `${id}:${row.repeat}`;
    const pair = byKey.get(key) ?? {};
    const arm = row.mode === options.baselineMode ? "baseline" : "candidate";
    if (pair[arm]) block("duplicate_arm_row");
    else pair[arm] = row;
    byKey.set(key, pair);
  }

  const complete: Array<{ baseline: MatchedProductRow; candidate: MatchedProductRow }> = [];
  for (const pair of byKey.values()) {
    if (!pair.baseline || !pair.candidate) {
      block("missing_arm_pair");
      continue;
    }
    if (
      pair.baseline.rowScore.taskSuccess === null ||
      pair.candidate.rowScore.taskSuccess === null
    ) {
      block("missing_binary_task_success");
      continue;
    }
    if (!pair.baseline.rowScore.evidence || !pair.candidate.rowScore.evidence) {
      block("missing_evidence_sufficiency");
      continue;
    }
    if (pair.baseline.rowScore.evidence.kind !== pair.candidate.rowScore.evidence.kind) {
      block("mismatched_evidence_kind");
      continue;
    }
    if (!validCostTelemetry(pair.baseline) || !validCostTelemetry(pair.candidate)) {
      block("missing_cost_telemetry");
      continue;
    }
    complete.push({ baseline: pair.baseline, candidate: pair.candidate });
  }
  if (complete.length === 0) block("no_complete_pairs");

  // A partial or non-causal run is diagnostic only. Do not emit typed gate
  // metrics that a caller could accidentally feed into active eligibility.
  const metrics = blockers.size === 0 ? aggregateCompletePairs(complete) : null;
  return {
    baselineMode: options.baselineMode,
    candidateMode: options.candidateMode,
    pairedCases: complete.length,
    metrics,
    blockers: [...blockers].map(([code, count]) => ({ code, count })),
  };
}

/** Read the only gate-safe payload from an official scored artifact. */
export function matchedProductMetricsFromArtifact(
  value: unknown,
): ControllerMatchedProductMetrics | null {
  if (!value || typeof value !== "object") return null;
  const metrics = (value as { matchedProduct?: { metrics?: unknown } }).matchedProduct?.metrics;
  if (!metrics || typeof metrics !== "object") return null;
  const candidate = metrics as Partial<ControllerMatchedProductMetrics>;
  if (!Number.isInteger(candidate.cases) || (candidate.cases ?? 0) < 1) return null;
  if (!validArmMetrics(candidate.baseline) || !validArmMetrics(candidate.learned)) return null;
  return candidate as ControllerMatchedProductMetrics;
}

function validCostTelemetry(row: MatchedProductRow): boolean {
  return (
    row.tokenUsage !== null &&
    Number.isFinite(row.tokenUsage.total) &&
    Number.isFinite(row.toolRounds) &&
    Number.isFinite(row.durationMs) &&
    row.toolRounds >= 0 &&
    row.durationMs >= 0
  );
}

function validArmMetrics(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const arm = value as Record<string, unknown>;
  return [
    "taskSuccessRate",
    "evidenceSufficiencyRate",
    "meanToolRounds",
    "meanTokens",
    "meanEndToEndLatencyMs",
  ].every((key) => typeof arm[key] === "number" && Number.isFinite(arm[key]));
}

function aggregateCompletePairs(
  pairs: ReadonlyArray<{ baseline: MatchedProductRow; candidate: MatchedProductRow }>,
): ControllerMatchedProductMetrics {
  return {
    cases: pairs.length,
    baseline: aggregateArm(pairs.map((pair) => pair.baseline)),
    learned: aggregateArm(pairs.map((pair) => pair.candidate)),
  };
}

function aggregateArm(rows: readonly MatchedProductRow[]) {
  return {
    taskSuccessRate: mean(rows.map((row) => Number(row.rowScore.taskSuccess))),
    evidenceSufficiencyRate: mean(rows.map((row) => row.rowScore.evidence!.all)),
    meanToolRounds: mean(rows.map((row) => row.toolRounds)),
    meanTokens: mean(rows.map((row) => row.tokenUsage!.total)),
    meanEndToEndLatencyMs: mean(rows.map((row) => row.durationMs)),
  };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
