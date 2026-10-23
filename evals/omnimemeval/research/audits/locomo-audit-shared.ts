// Shared, frozen evaluation contract for the LoCoMo zero-LLM retrieval probes.
//
// Every probe arm (baseline capture, static multi-path, PRF, session-neighbor)
// must score evidence coverage through these helpers so per-arm denominators
// and matching semantics stay identical. The contract:
//   - evidence hit = first retrieved memory whose NORMALIZED content contains
//     the NORMALIZED ingested turn text ("speaker: text", lowercased, whitespace
//     collapsed) as a substring;
//   - a label whose turn is absent from the conversation maps to -2 and its
//     question is excluded from every denominator (dataset quirk, not a miss);
//   - a labeled turn not present in the retrieved list maps to -1;
//   - coverage() skips -2 rows, reports the per-arm n, and returns null rates
//     when n is zero instead of inventing a percentage;
//   - search-result keys are `locomo_exp_user_<dataset array index>` (the
//     audit-locomo-retrieval.ts convention), never the raw dataset sample_id.

import { createHash } from "node:crypto";

import type { BenchmarkCase } from "../../../benchmarks/types.ts";

export const normalizeText = (value: string): string =>
  value.toLowerCase().replace(/\s+/gu, " ").trim();

export const locomoUserKey = (datasetIndex: number): string => `locomo_exp_user_${datasetIndex}`;

// Official evidence-label parsing (matches audit-locomo-retrieval.ts): a
// composite label like "D8:6; D9:17" denotes TWO turns. Split on semicolons
// and commas, trim, keep order, no dedup — exactly the official semantics;
// deliberately no repair of odd spacing or spelling.
export function splitEvidenceLabels(labels: readonly string[]): string[] {
  return labels
    .flatMap((label) => label.split(/[;,]\s*/u))
    .map((label) => label.trim())
    .filter(Boolean);
}

export function evidenceTextFor(item: BenchmarkCase): Map<string, string> {
  const map = new Map<string, string>();
  for (const session of item.sessions) {
    for (const turn of session.turns) {
      map.set(
        turn.sourceId,
        normalizeText(turn.speaker ? `${turn.speaker}: ${turn.content}` : turn.content),
      );
    }
  }
  return map;
}

type RetrievedMemory = { content?: string; statement?: string };

export function hitPositions(
  memories: readonly RetrievedMemory[],
  item: BenchmarkCase,
  evidenceText: Map<string, string>,
): number[] {
  const contents = memories.map((memory) =>
    normalizeText(memory.content ?? memory.statement ?? ""),
  );
  // Composite labels expand per the official rule; positions are per atomic
  // label so a two-turn composite contributes two ranks, not one miss.
  return splitEvidenceLabels(item.evidenceIds ?? []).map((evidenceId) => {
    const text = evidenceText.get(evidenceId);
    if (text === undefined) return -2;
    return contents.findIndex((content) => content.includes(text));
  });
}

export type EligibilityManifest = {
  /** Ordered by dataset appearance; the projection every arm must score on. */
  eligibleIds: string[];
  excluded: Array<{ id: string; missingLabels: string[] }>;
  /** sha256 over the JSON of the sorted eligible ID set (set identity). */
  sha256: string;
};

/** Frozen eligible-question projection: a question is eligible when EVERY
 * atomic evidence label (official semicolon/comma splitting) resolves to a
 * turn that exists in the conversation. All arms must score on this set; the
 * hash pins the set identity for cross-agent comparison. */
export function buildEligibilityManifest(cases: readonly BenchmarkCase[]): EligibilityManifest {
  const eligibleIds: string[] = [];
  const excluded: EligibilityManifest["excluded"] = [];
  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const evidenceText = evidenceTextFor(item);
    const labels = splitEvidenceLabels(item.evidenceIds ?? []);
    const missingLabels = [...new Set(labels.filter((label) => !evidenceText.has(label)))];
    if (labels.length === 0 || missingLabels.length > 0) {
      excluded.push({ id: item.id, missingLabels });
      continue;
    }
    eligibleIds.push(item.id);
  }
  const sha256 = createHash("sha256")
    .update(JSON.stringify([...eligibleIds].sort()))
    .digest("hex");
  return { eligibleIds, excluded, sha256 };
}

export type Coverage = {
  n: number;
  anyPct: number | null;
  allPct: number | null;
  recallPct: number | null;
};

type PositionsSource = readonly number[] | { hitPositions: readonly number[] } | null | undefined;

export function coverage(rows: readonly Record<string, unknown>[], key: string): Coverage {
  let any = 0,
    all = 0,
    hits = 0,
    total = 0,
    n = 0;
  for (const row of rows) {
    const value = row[key] as PositionsSource;
    const positions = Array.isArray(value)
      ? (value as readonly number[])
      : (value as { hitPositions: readonly number[] } | null | undefined)?.hitPositions;
    if (!Array.isArray(positions) || positions.some((rank) => rank === -2)) continue;
    const found = positions.filter((rank) => rank >= 0);
    n += 1;
    any += found.length > 0 ? 1 : 0;
    all += found.length === positions.length && positions.length > 0 ? 1 : 0;
    hits += found.length;
    total += positions.length;
  }
  if (n === 0) return { n: 0, anyPct: null, allPct: null, recallPct: null };
  const pct = (part: number, whole: number) => +((100 * part) / whole).toFixed(1);
  return { n, anyPct: pct(any, n), allPct: pct(all, n), recallPct: pct(hits, total) };
}

/** Paired comparison on a SHARED eligible set: rows not in eligibleIds, rows
 * missing either side, and rows containing -2 are all excluded from the
 * single shared denominator; win/loss on all@20 per question. */
export function pairedComparison(
  rows: readonly Record<string, unknown>[],
  baselineKey: string,
  armKey: string,
  eligibleIds: ReadonlySet<string>,
): Coverage & { wins: number; losses: number; ties: number } {
  const tally = { any: 0, all: 0, hits: 0, total: 0, n: 0, wins: 0, losses: 0, ties: 0 };
  for (const row of rows) {
    if (!eligibleIds.has(String(row.id))) continue;
    const base = readPositions(row, baselineKey);
    const arm = readPositions(row, armKey);
    if (!isScoredRow(base) || !isScoredRow(arm)) continue;
    const baseAll = isFullyRetrieved(base);
    const armAll = isFullyRetrieved(arm);
    tally.n += 1;
    tally.any += arm.some((rank) => rank >= 0) ? 1 : 0;
    tally.all += armAll ? 1 : 0;
    tally.hits += arm.filter((rank) => rank >= 0).length;
    tally.total += arm.length;
    const outcome = compareAll(baseAll, armAll);
    tally[outcome] += 1;
  }
  if (tally.n === 0) {
    return { n: 0, anyPct: null, allPct: null, recallPct: null, wins: 0, losses: 0, ties: 0 };
  }
  const pct = (part: number, whole: number) => +((100 * part) / whole).toFixed(1);
  return {
    n: tally.n,
    anyPct: pct(tally.any, tally.n),
    allPct: pct(tally.all, tally.n),
    recallPct: pct(tally.hits, tally.total),
    wins: tally.wins,
    losses: tally.losses,
    ties: tally.ties,
  };
}

function readPositions(row: Record<string, unknown>, key: string): readonly number[] | undefined {
  const value = row[key] as PositionsSource;
  return Array.isArray(value)
    ? (value as readonly number[])
    : (value as { hitPositions: readonly number[] } | null | undefined)?.hitPositions;
}

/** A scored row: present, an array, and containing no dataset-missing (-2)
 * labels — such questions are excluded from every shared denominator. */
function isScoredRow(positions: readonly number[] | undefined): positions is readonly number[] {
  return Array.isArray(positions) && !positions.some((rank) => rank === -2);
}

function isFullyRetrieved(positions: readonly number[]): boolean {
  return positions.length > 0 && positions.every((rank) => rank >= 0);
}

function compareAll(baseAll: boolean, armAll: boolean): "wins" | "losses" | "ties" {
  if (armAll && !baseAll) return "wins";
  if (baseAll && !armAll) return "losses";
  return "ties";
}

/** Fixed text-budget slice: take the ordered prefix whose cumulative content
 * characters stay within `budget` (the first overflowing item is dropped;
 * at least one item is kept when the budget is positive). */
export function sliceByCharBudget<T extends { content?: string; statement?: string }>(
  memories: readonly T[],
  budget: number,
): T[] {
  if (!(budget > 0)) return [];
  let used = 0;
  const taken: T[] = [];
  for (const memory of memories) {
    const length = (memory.content ?? memory.statement ?? "").length;
    if (used + length > budget && taken.length > 0) break;
    taken.push(memory);
    used += length;
  }
  return taken;
}
