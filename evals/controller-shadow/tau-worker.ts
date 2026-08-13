import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_QPP_THRESHOLD } from "../../src/core/qpp.ts";
import { buildShadowDataset, type ShadowDatasetRow } from "./dataset.ts";
import { readShadowEvents, resolveShadowEventPath } from "./report.ts";

const MIN_TOTAL_ROWS = 50;
const MIN_VALIDATION_ROWS = 10;
const MAX_THRESHOLD_STEP = 0.05;

export interface TauCalibrationOptions {
  previousThreshold?: number;
  maxRows?: number;
  generatedAt?: string;
}

export interface TauMetrics {
  rows: number;
  positives: number;
  negatives: number;
  accuracy: number;
  balancedAccuracy: number;
}

/**
 * Produce a bounded, rollbackable threshold candidate from natural,
 * chronologically split feedback. The candidate is shadow-only: this worker
 * never changes runtime configuration.
 */
export function calibrateRollingTau(
  rows: readonly ShadowDatasetRow[],
  options: TauCalibrationOptions = {},
) {
  const previousThreshold = bounded(options.previousThreshold ?? DEFAULT_QPP_THRESHOLD, 0, 1);
  const maxRows = Math.max(1, Math.floor(options.maxRows ?? 500));
  const usable = rows
    .filter((row) => row.retrieval.qpp && Number.isFinite(row.retrieval.qpp.qpp))
    .slice(-maxRows);
  const train = usable.filter((row) => row.split === "train");
  const validation = usable.filter((row) => row.split === "validation");
  const unconstrained = bestThreshold(train, previousThreshold);
  const threshold = bounded(
    unconstrained,
    previousThreshold - MAX_THRESHOLD_STEP,
    previousThreshold + MAX_THRESHOLD_STEP,
  );
  const baseline = evaluate(validation, previousThreshold);
  const candidate = evaluate(validation, threshold);
  const blockers: string[] = [];
  if (usable.length < MIN_TOTAL_ROWS) blockers.push(`requires at least ${MIN_TOTAL_ROWS} labelled rows`);
  if (validation.length < MIN_VALIDATION_ROWS) {
    blockers.push(`requires at least ${MIN_VALIDATION_ROWS} held-out rows`);
  }
  if (!hasBothLabels(train)) blockers.push("training window requires positive and negative expansion labels");
  if (!hasBothLabels(validation)) {
    blockers.push("held-out window requires positive and negative expansion labels");
  }
  if (candidate.balancedAccuracy < baseline.balancedAccuracy) {
    blockers.push("candidate does not match or improve held-out balanced accuracy");
  }
  const times = usable.map((row) => row.recordedAt).sort();
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  return {
    version: 1 as const,
    kind: "qpp_rolling_tau_candidate" as const,
    generatedAt,
    dataWindow: { from: times.at(0) ?? null, to: times.at(-1) ?? null, maxRows },
    rows: { total: usable.length, train: train.length, validation: validation.length },
    previousThreshold,
    unconstrainedThreshold: unconstrained,
    candidateThreshold: threshold,
    maximumStep: MAX_THRESHOLD_STEP,
    baseline,
    candidate,
    blockers,
    eligibleForShadow: blockers.length === 0,
    eligibleForActivation: false,
    rollback: { threshold: previousThreshold },
    fingerprint: fingerprint(usable, previousThreshold, threshold),
  };
}

function bestThreshold(rows: readonly ShadowDatasetRow[], fallback: number): number {
  if (!rows.length || !hasBothLabels(rows)) return fallback;
  const scores = [...new Set(rows.map(qpp))].sort((left, right) => left - right);
  const candidates = [0, ...scores.map((score, index) => (score + (scores[index + 1] ?? 1)) / 2), 1];
  return candidates.reduce((best, candidate) => {
    const next = evaluate(rows, candidate);
    const current = evaluate(rows, best);
    if (next.balancedAccuracy !== current.balancedAccuracy) {
      return next.balancedAccuracy > current.balancedAccuracy ? candidate : best;
    }
    return Math.abs(candidate - fallback) < Math.abs(best - fallback) ? candidate : best;
  }, fallback);
}

function evaluate(rows: readonly ShadowDatasetRow[], threshold: number): TauMetrics {
  let truePositive = 0;
  let trueNegative = 0;
  let positives = 0;
  let negatives = 0;
  for (const row of rows) {
    const expected = row.feedback.expansionUseful === true;
    const predicted = qpp(row) < threshold;
    if (expected) {
      positives += 1;
      if (predicted) truePositive += 1;
    } else {
      negatives += 1;
      if (!predicted) trueNegative += 1;
    }
  }
  const accuracy = rows.length ? (truePositive + trueNegative) / rows.length : 0;
  const truePositiveRate = positives ? truePositive / positives : 0;
  const trueNegativeRate = negatives ? trueNegative / negatives : 0;
  return {
    rows: rows.length,
    positives,
    negatives,
    accuracy,
    balancedAccuracy: (truePositiveRate + trueNegativeRate) / 2,
  };
}

function hasBothLabels(rows: readonly ShadowDatasetRow[]): boolean {
  return rows.some((row) => row.feedback.expansionUseful === true) &&
    rows.some((row) => row.feedback.expansionUseful === false);
}

function qpp(row: ShadowDatasetRow): number {
  return row.retrieval.qpp?.qpp ?? Number.NaN;
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function fingerprint(rows: readonly ShadowDatasetRow[], previous: number, candidate: number): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        rows: rows.map((row) => [
          row.graphId,
          row.recordedAt,
          row.split,
          qpp(row),
          row.feedback.expansionUseful,
        ]),
        previous,
        candidate,
      }),
    )
    .digest("hex");
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const eventsPath = resolveShadowEventPath(process.argv[2]);
  const outputPath = resolve(process.argv[3] ?? `${eventsPath}.tau-candidate.json`);
  const artifact = calibrateRollingTau(buildShadowDataset(readShadowEvents(eventsPath)).rows);
  writeAtomic(outputPath, artifact);
  process.stdout.write(`${JSON.stringify({ eventsPath, outputPath, ...artifact }, null, 2)}\n`);
}
