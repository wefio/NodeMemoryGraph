/**
 * Committed benchmark score snapshots.
 *
 * Full run directories (report.json, predictions.jsonl, official-score.json) stay
 * gitignored because they are large and contain per-case model output. Without any
 * committed artifact there is no way to answer "did this change help or hurt?" —
 * every comparison requires re-running the benchmark.
 *
 * A snapshot is the small, reviewable part: per-mode scores plus the provenance
 * needed to know what produced them (code revision, sample fingerprint, judge,
 * sample size). These are safe to commit and diff across time.
 *
 * Snapshots are development signal, not leaderboard claims. Sample sizes here are
 * small and `leaderboardComparable` is false throughout.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Per-mode score as emitted by either scoring script shape. */
export interface SnapshotMode {
  /** Mean official score in [0, 1]. */
  score: number;
  /** Number of scored cases backing `score`. */
  count: number;
  /** Mean score per category, when the scorer reports it. */
  byCategory?: Record<string, number>;
}

export interface Snapshot {
  benchmark: string;
  /** ISO timestamp of when the snapshot was written. */
  recordedAt: string;
  /** Git revision of the code under evaluation. */
  codeRevision: string | null;
  /** Hash of the selected case set, so runs over different samples are not compared. */
  sampleFingerprint: string | null;
  protocol: string;
  judgeModel: string | null;
  leaderboardComparable: false;
  upstream: unknown;
  parameters: unknown;
  byMode: Record<string, SnapshotMode>;
}

/**
 * Normalize the two scoring-script `byMode` shapes into one.
 * longmemeval reports `{accuracy, total}`; the official scorer reports
 * `{score, count, byCategory}`.
 */
export function normalizeByMode(byMode: Record<string, unknown>): Record<string, SnapshotMode> {
  return Object.fromEntries(
    Object.entries(byMode).map(([mode, raw]) => {
      const value = (raw ?? {}) as Record<string, unknown>;
      const score =
        typeof value.score === "number"
          ? value.score
          : typeof value.accuracy === "number"
            ? value.accuracy
            : Number.NaN;
      const count =
        typeof value.count === "number"
          ? value.count
          : typeof value.total === "number"
            ? value.total
            : 0;
      const byCategory = value.byCategory as Record<string, number> | undefined;
      return [mode, byCategory ? { score, count, byCategory } : { score, count }];
    }),
  );
}

export interface SnapshotInput {
  benchmark: string;
  protocol: string;
  judgeModel: string | null;
  upstream: unknown;
  parameters?: unknown;
  byMode: Record<string, unknown>;
  codeRevision?: string | null;
  sampleFingerprint?: string | null;
}

export function buildSnapshot(input: SnapshotInput): Snapshot {
  return {
    benchmark: input.benchmark,
    recordedAt: new Date().toISOString(),
    codeRevision: input.codeRevision ?? null,
    sampleFingerprint: input.sampleFingerprint ?? null,
    protocol: input.protocol,
    judgeModel: input.judgeModel,
    leaderboardComparable: false,
    upstream: input.upstream,
    parameters: input.parameters ?? null,
    byMode: normalizeByMode(input.byMode),
  };
}

/**
 * Write a snapshot to the committed history directory.
 *
 * One file per benchmark per run, named by timestamp and revision so successive
 * runs accumulate into a reviewable trend instead of overwriting each other.
 */
export function writeSnapshot(rootDirectory: string, snapshot: Snapshot): string {
  const directory = resolve(rootDirectory, "evals", "snapshots", snapshot.benchmark);
  mkdirSync(directory, { recursive: true });
  const stamp = snapshot.recordedAt.replaceAll(":", "-");
  const revision = (snapshot.codeRevision ?? "unknown").slice(0, 12);
  const path = resolve(directory, `${stamp}_${revision}.json`);
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
  return path;
}
