// Exact loss decomposition for LoCoMo multi-hop retrieval (read-only diagnostic).
//
// Answers "should the next step change the query or the fusion?" by splitting
// the missing-evidence mass over the candidate union actually recorded by the
// v4 run — no new retrieval, no embedding calls, no LLM, no gold in generation.
//
// Definitions used here (all exact; nothing is estimated):
//   candidate union   = every record any recorded query path returned for the
//                       question (original @20, original @100, each derived
//                       clause @20 and @100), deduplicated by content. The
//                       non-deduplicated sum is reported separately as
//                       `pathSum` because one record can be returned by several
//                       paths and the two numbers mean different things.
//   oracle all@20     = feasible iff (i) every atomic evidence label appears in
//                       at least one union candidate, (ii) the cheapest covering
//                       records fit in `capacity` slots, and (iii) their total
//                       characters fit the question's arm-A text budget. This is
//                       exact set-cover feasibility, not an upper-bound estimate.
//   call count        = 1 (original query) + number of derived clauses the
//                       generator actually ran (recorded as raw.derived20.length).
//
// Three loss layers:
//   (a) union ceiling  — what a perfect selector could reach from the union;
//   (b) page           — what the fused arm actually reached;
//       (a) − (b)      = fusion/selection/budget loss; 1 − (a) = query loss.
//   (c) adjacency ceiling — the same oracle after adding the ±2 session
//       neighbourhood candidates the adjacency probes generate. The value holds
//       for the tested configuration (radius 2, first 5 anchors); a wider radius
//       was not measured, so it is a configuration value, not a mechanism bound.
//
// Usage: node --experimental-strip-types evals/omnimemeval/research/audits/loss-decomposition.ts [--json]

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocomo } from "../../../benchmarks/loaders.ts";
import type { BenchmarkCase } from "../../../benchmarks/types.ts";
import { loadEnvironmentFile } from "../../../local-env.ts";
import { percentileNearestRank } from "../../../../tools/parts/stats.ts";
import {
  buildEligibilityManifest,
  evidenceTextFor,
  normalizeText,
  splitEvidenceLabels,
} from "./locomo-audit-shared.ts";
import { buildArmE, E_PRIMARY } from "./static-arm-e-recall.ts";
import {
  buildConversation,
  buildNeighborArm,
  DEFAULT_NEIGHBOR_PARAMS,
} from "./static-neighbor-recall.ts";

export const V4_RUN = "evals/locomo/results/static-multipath-v4-2026-10-23T10-29-58";
export const NEIGHBOR_RUN = "evals/locomo/results/static-neighbor-2026-10-23T11-07-04";
export const ARM_E_RUN = "evals/locomo/results/static-arm-e-2026-10-23T12-15-22";

/** One recorded candidate list entry (the v4 raw shape). */
export type RawCandidate = { id?: string; content?: string; statement?: string };
export type RawPaths = {
  A?: RawCandidate[];
  B_full?: RawCandidate[];
  D100max?: RawCandidate[];
  derived20?: RawCandidate[][];
  derived100?: RawCandidate[][];
};

const text = (candidate: RawCandidate): string => candidate.content ?? candidate.statement ?? "";

/** Every recorded retrieval path for one question, in a stable order:
 * original @20, original @100, each derived clause @20, each derived clause @100. */
export function recordedPaths(paths: RawPaths): RawCandidate[][] {
  const lists: RawCandidate[][] = [paths.A ?? [], paths.B_full ?? []];
  for (const list of paths.derived20 ?? []) lists.push(list);
  for (const list of paths.derived100 ?? []) lists.push(list);
  return lists;
}

/** Deduplicated candidate union (normalized content identity). */
export function candidateUnion(paths: RawPaths): string[] {
  const seen = new Set<string>();
  const union: string[] = [];
  for (const list of recordedPaths(paths)) {
    for (const candidate of list) {
      const normalized = normalizeText(text(candidate));
      if (normalized.length === 0 || seen.has(normalized)) continue;
      seen.add(normalized);
      union.push(normalized);
    }
  }
  return union;
}

/** Non-deduplicated total of every path's returned records. */
export function pathSum(paths: RawPaths): number {
  return recordedPaths(paths).reduce((sum, list) => sum + list.length, 0);
}

/** Retrieval calls the generator actually issued for this question. */
export function callCount(paths: RawPaths): number {
  return 1 + (paths.derived20 ?? []).length;
}

export type OracleResult = {
  /** Every label present in the union AND coverable within the slot+char budget. */
  feasible: boolean;
  /** Labels that appear in no candidate at all. */
  missingLabels: string[];
  /** Distinct covering records the cheapest solution needs. */
  coveringRecords: number;
  /** Total characters of that cheapest covering solution. */
  coveringCharacters: number;
  /** Present in the union but not coverable within the budget. */
  budgetBlocked: boolean;
};

/** Exact oracle: cheapest per-label covering record, then check the two budgets.
 * A per-label greedy minimum is exact here because each label needs only one
 * record and the records are chosen independently; the slot count is bounded by
 * the number of labels, which is far below `capacity`. */
export function oracleCoverage(
  labels: readonly string[],
  evidenceText: Map<string, string>,
  candidates: readonly string[],
  capacity: number,
  charBudget: number,
): OracleResult {
  const missingLabels: string[] = [];
  const chosen = new Set<number>();
  let characters = 0;
  for (const label of labels) {
    const evidence = evidenceText.get(label);
    if (evidence === undefined) {
      missingLabels.push(label);
      continue;
    }
    let bestIndex = -1;
    let bestLength = Infinity;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      if (!candidate.includes(evidence)) continue;
      if (candidate.length < bestLength) {
        bestLength = candidate.length;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) {
      missingLabels.push(label);
      continue;
    }
    if (!chosen.has(bestIndex)) {
      chosen.add(bestIndex);
      characters += bestLength;
    }
  }
  const coveringRecords = chosen.size;
  const coveringCharacters = characters;
  const present = missingLabels.length === 0;
  const withinSlots = coveringRecords <= capacity;
  const withinChars = coveringCharacters <= charBudget;
  return {
    feasible: present && withinSlots && withinChars,
    missingLabels,
    coveringRecords,
    coveringCharacters,
    budgetBlocked: present && !(withinSlots && withinChars),
  };
}

/** Where an adjacency-rescued evidence turn really came from. */
export type RescueLocus = "original-pool-tail" | "other-path-unselected" | "outside-all-paths";

export function classifyRescue(
  evidence: string,
  originalPool: readonly string[],
  union: readonly string[],
  capacity: number,
): RescueLocus {
  const poolRank = originalPool.findIndex((candidate) => candidate.includes(evidence));
  if (poolRank >= capacity) return "original-pool-tail";
  if (poolRank >= 0) return "original-pool-tail";
  if (union.some((candidate) => candidate.includes(evidence))) return "other-path-unselected";
  return "outside-all-paths";
}

export type ScopeCounts = {
  questions: number;
  unionFeasible: number;
  unionMissing: number;
  budgetBlocked: number;
  pageAll: number;
  unionAny: number;
  unionHopFound: number;
  unionHopTotal: number;
  pageHopFound: number;
  pageHopTotal: number;
  adjacencyFeasible: number;
  adjacencyMissing: number;
  unionSizeMean: number;
  pathSumMean: number;
};

/** Candidate-count distribution under one counting caliber. Quantiles use the
 * repository's `percentileNearestRank` (tools/parts/stats.ts), the same
 * convention audit-locomo-retrieval.ts uses, so the section's quantiles have a
 * single stated method instead of a rounding dispute. */
export type CandidateScale = {
  mean: number;
  p25: number;
  p50: number;
  p75: number;
  max: number;
};

export function scaleOf(values: readonly number[]): CandidateScale {
  if (values.length === 0) return { mean: 0, p25: 0, p50: 0, p75: 0, max: 0 };
  const mean = +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1);
  return {
    mean,
    p25: percentileNearestRank(values, 0.25),
    p50: percentileNearestRank(values, 0.5),
    p75: percentileNearestRank(values, 0.75),
    max: Math.max(...values),
  };
}

export type LossDecomposition = {
  scope: string;
  questions: number;
  multihop: ScopeCounts;
  regression: ScopeCounts;
  calls: { scope: string; byCount: Record<string, number>; total: number }[];
  rescueLocus: RescueLocusEntry[];
  candidateScale: { convention: string; multiHop: ScopeScale; regression: ScopeScale };
};

export type RescueLocusEntry = {
  arm: string;
  caliber: string;
  counts: Record<RescueLocus, number>;
};

/** Per-bucket difference between two arms at the same caliber. This is what
 * distinguishes "the extra rescues came from adjacency (outside all lists)"
 * from "they were already available as candidates but unselected". */
export function rescueLocusDelta(
  entries: readonly RescueLocusEntry[],
  arm: string,
  baselineArm: string,
): { caliber: string; delta: Record<RescueLocus, number> }[] {
  return entries
    .filter((entry) => entry.arm === arm)
    .map((entry) => {
      const baseline = entries.find(
        (candidate) => candidate.arm === baselineArm && candidate.caliber === entry.caliber,
      );
      const delta: Record<RescueLocus, number> = {
        "original-pool-tail": 0,
        "other-path-unselected": 0,
        "outside-all-paths": 0,
      };
      for (const locus of Object.keys(delta) as RescueLocus[]) {
        delta[locus] = entry.counts[locus] - (baseline?.counts[locus] ?? 0);
      }
      return { caliber: entry.caliber, delta };
    });
}

const pct = (part: number, whole: number): number =>
  whole === 0 ? 0 : +((100 * part) / whole).toFixed(1);

function emptyCounts(): ScopeCounts {
  return {
    questions: 0,
    unionFeasible: 0,
    unionMissing: 0,
    budgetBlocked: 0,
    pageAll: 0,
    unionAny: 0,
    unionHopFound: 0,
    unionHopTotal: 0,
    pageHopFound: 0,
    pageHopTotal: 0,
    adjacencyFeasible: 0,
    adjacencyMissing: 0,
    unionSizeMean: 0,
    pathSumMean: 0,
  };
}

function accumulateUnion(
  labels: readonly string[],
  evidenceText: Map<string, string>,
  union: readonly string[],
  budget: number,
  counts: ScopeCounts,
): void {
  const oracle = oracleCoverage(labels, evidenceText, union, 20, budget);
  const missing = oracle.missingLabels.length;
  counts.unionHopTotal += labels.length;
  counts.unionHopFound += labels.length - missing;
  if (missing < labels.length) counts.unionAny += 1;
  if (missing > 0) {
    counts.unionMissing += 1;
    return;
  }
  if (oracle.feasible) counts.unionFeasible += 1;
  else counts.budgetBlocked += 1;
}

function accumulatePage(page: readonly number[], counts: ScopeCounts): void {
  const found = page.filter((rank) => rank >= 0).length;
  counts.pageHopFound += found;
  counts.pageHopTotal += page.length;
  if (page.length > 0 && found === page.length) counts.pageAll += 1;
}

function accumulateAdjacency(
  labels: readonly string[],
  evidenceText: Map<string, string>,
  union: readonly string[],
  neighbourhood: readonly string[],
  budget: number,
  counts: ScopeCounts,
): void {
  const oracle = oracleCoverage(labels, evidenceText, [...union, ...neighbourhood], 20, budget);
  if (oracle.missingLabels.length > 0) {
    counts.adjacencyMissing += 1;
    return;
  }
  if (oracle.feasible) counts.adjacencyFeasible += 1;
}

/** Adjacency candidates the probes actually generate: arm E anchors on the
 * fused D100max list, C2 anchors on baseline A. */
/** Unique normalized contents across the given lists, first-seen order. */
function uniqueCandidates(...lists: readonly string[][]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    for (const candidate of list) {
      if (candidate.length === 0 || seen.has(candidate)) continue;
      seen.add(candidate);
      merged.push(candidate);
    }
  }
  return merged;
}

/** The candidate set each adjacency arm actually had available: its own page
 * (the 20 records it started from) plus the ±2 neighbourhood it generated.
 * These are arm inputs, NOT the union-plus-neighbourhood ceiling — an arm that
 * only keeps its fused page discards the rest of the retrieval union. */
export type ArmInputCandidates = { page: string[]; E: string[]; C2: string[] };

export function armInputCandidates(
  paths: RawPaths,
  conversation: ReturnType<typeof buildConversation>,
): ArmInputCandidates {
  const page = (paths.D100max ?? []).map((candidate) => normalizeText(text(candidate)));
  const baselinePage = (paths.A ?? []).map((candidate) => normalizeText(text(candidate)));
  const armE = buildArmE(paths.D100max ?? [], conversation, E_PRIMARY);
  const armC = buildNeighborArm(
    (paths.A ?? []).map(text).join("\n"),
    conversation,
    DEFAULT_NEIGHBOR_PARAMS,
  );
  return {
    page,
    E: uniqueCandidates(
      page,
      armE.pool.map((turn) => normalizeText(turn.ingested)),
    ),
    C2: uniqueCandidates(
      baselinePage,
      armC.pool.map((turn) => normalizeText(turn.ingested)),
    ),
  };
}

/** Oracle all@20 count over each arm's real candidate input, plus the fused page
 * itself as the reference point. Same exactness rule as every other ceiling in
 * this diagnostic: every atomic label covered, <= 20 slots, <= arm-A chars. */
export type ArmInputCeiling = { questions: number; page: number; E: number; C2: number };

export function armInputCeilings(
  cases: readonly BenchmarkCase[],
  rawById: Map<string, RawPaths>,
  budgetById: Map<string, number>,
  conversations: Map<string, ReturnType<typeof buildConversation>>,
): ArmInputCeiling {
  const ceiling: ArmInputCeiling = { questions: 0, page: 0, E: 0, C2: 0 };
  for (const item of cases) {
    const paths = rawById.get(item.id);
    const conversation = conversations.get(String(item.officialMetadata.sampleId));
    if (!paths || !conversation) continue;
    const evidenceText = evidenceTextFor(item);
    const labels = splitEvidenceLabels(item.evidenceIds ?? []).filter((label) =>
      evidenceText.has(label),
    );
    const budget = budgetById.get(item.id) ?? 0;
    const candidates = armInputCandidates(paths, conversation);
    ceiling.questions += 1;
    const reachable = (set: readonly string[]): number =>
      oracleCoverage(labels, evidenceText, set, 20, budget).feasible ? 1 : 0;
    ceiling.page += reachable(candidates.page);
    ceiling.E += reachable(candidates.E);
    ceiling.C2 += reachable(candidates.C2);
  }
  return ceiling;
}

function adjacencyCandidates(
  paths: RawPaths,
  conversation: ReturnType<typeof buildConversation>,
): string[] {
  const candidates: string[] = [];
  const armE = buildArmE(paths.D100max ?? [], conversation, E_PRIMARY);
  const armC = buildNeighborArm(
    (paths.A ?? []).map(text).join("\n"),
    conversation,
    DEFAULT_NEIGHBOR_PARAMS,
  );
  for (const turn of armE.pool) candidates.push(normalizeText(turn.ingested));
  for (const turn of armC.pool) candidates.push(normalizeText(turn.ingested));
  return candidates;
}

export function decomposeScope(
  cases: readonly BenchmarkCase[],
  rawById: Map<string, RawPaths>,
  pageById: Map<string, number[]>,
  budgetById: Map<string, number>,
  conversations: Map<string, ReturnType<typeof buildConversation>>,
): { counts: ScopeCounts; scale: ScopeScale } {
  const counts = emptyCounts();
  const unionSizes: number[] = [];
  const pathSums: number[] = [];
  for (const item of cases) {
    const paths = rawById.get(item.id);
    if (!paths) continue;
    const evidenceText = evidenceTextFor(item);
    const labels = splitEvidenceLabels(item.evidenceIds ?? []).filter((label) =>
      evidenceText.has(label),
    );
    const union = candidateUnion(paths);
    const budget = budgetById.get(item.id) ?? 0;
    accumulateUnion(labels, evidenceText, union, budget, counts);
    accumulatePage(pageById.get(item.id) ?? [], counts);
    const conversation = conversations.get(String(item.officialMetadata.sampleId));
    if (conversation) {
      const neighbourhood = adjacencyCandidates(paths, conversation);
      accumulateAdjacency(labels, evidenceText, union, neighbourhood, budget, counts);
    }
    unionSizes.push(union.length);
    pathSums.push(pathSum(paths));
    counts.questions += 1;
  }
  const questions = counts.questions || 1;
  counts.unionSizeMean = +(unionSizes.reduce((sum, value) => sum + value, 0) / questions).toFixed(
    1,
  );
  counts.pathSumMean = +(pathSums.reduce((sum, value) => sum + value, 0) / questions).toFixed(1);
  return { counts, scale: { dedup: scaleOf(unionSizes), pathSum: scaleOf(pathSums) } };
}

/** Distribution of the two counting calibers for one scope. */
export type ScopeScale = { dedup: CandidateScale; pathSum: CandidateScale };

type RescueRow = {
  id: string;
  category?: unknown;
  A?: { hitPositions?: number[] };
  [key: string]: unknown;
};

type RescueContext = {
  evidenceText: Map<string, string>;
  labels: string[];
  union: string[];
  originalPool: string[];
};

const isComplete = (positions: readonly number[]): boolean =>
  positions.length > 0 && positions.every((rank) => rank >= 0);

/** Locus of one newly-covered evidence turn, or undefined when it did not move. */
function locusOf(
  baseline: readonly number[],
  arm: readonly number[],
  context: RescueContext,
  index: number,
): RescueLocus | undefined {
  const rank = arm[index] ?? -1;
  if (rank < 0) return undefined;
  if (baseline[index] !== -1) return undefined;
  const evidence = context.evidenceText.get(context.labels[index] ?? "");
  if (evidence === undefined) return undefined;
  return classifyRescue(evidence, context.originalPool, context.union, 20);
}

/** Tally every newly-covered evidence turn of one question into its locus. */
function tallyRow(
  row: RescueRow,
  armKey: string,
  caseById: Map<string, BenchmarkCase>,
  rawById: Map<string, RawPaths>,
  questionLevel: boolean,
  counts: Record<RescueLocus, number>,
): void {
  const baseline = row.A?.hitPositions ?? [];
  const arm = (row[armKey] as { hitPositions?: number[] } | undefined)?.hitPositions ?? [];
  if (questionLevel && !(isComplete(arm) && !isComplete(baseline))) return;
  const item = caseById.get(row.id);
  const paths = rawById.get(row.id);
  if (!item || !paths) return;
  const context: RescueContext = {
    evidenceText: evidenceTextFor(item),
    labels: splitEvidenceLabels(item.evidenceIds ?? []),
    union: candidateUnion(paths),
    originalPool: (paths.B_full ?? []).map((candidate) => normalizeText(text(candidate))),
  };
  for (let index = 0; index < arm.length; index += 1) {
    const locus = locusOf(baseline, arm, context, index);
    if (locus !== undefined) counts[locus] += 1;
  }
}

/** Rescue-locus split for the adjacency arms, question-level and label-level. */
export function rescueLocusFor(
  armKey: string,
  rows: readonly RescueRow[],
  caseById: Map<string, BenchmarkCase>,
  rawById: Map<string, RawPaths>,
): { arm: string; caliber: string; counts: Record<RescueLocus, number> }[] {
  const build = (questionLevel: boolean) => {
    const counts: Record<RescueLocus, number> = {
      "original-pool-tail": 0,
      "other-path-unselected": 0,
      "outside-all-paths": 0,
    };
    for (const row of rows) {
      if (Number(row.category) === 1) continue;
      tallyRow(row, armKey, caseById, rawById, questionLevel, counts);
    }
    return counts;
  };
  return [
    { arm: armKey, caliber: "question-level", counts: build(true) },
    { arm: armKey, caliber: "label-level", counts: build(false) },
  ];
}

function readJsonl(path: string): RescueRow[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RescueRow);
}

function main(): void {
  const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
  const env = loadEnvironmentFile(resolve(root, ".env.nmg-locomo-audit"));
  const dataPath = [
    env.NMG_LOCOMO_DATA,
    resolve(root, "evals/locomo/data/locomo10.json"),
    resolve(root, ".benchmarks/official/LoCoMo/data/locomo10.json"),
  ].find((path) => path && existsSync(path));
  if (!dataPath) throw new Error("locomo10.json not found (set NMG_LOCOMO_DATA)");
  const allCases = loadLocomo(dataPath);
  const manifest = buildEligibilityManifest(allCases);
  const eligible = new Set(manifest.eligibleIds);
  const caseById = new Map(allCases.map((item) => [item.id, item]));

  const rawRows = readJsonl(resolve(root, V4_RUN, "raw-candidates.jsonl"));
  const v4Rows = readJsonl(resolve(root, V4_RUN, "rows.jsonl"));
  const rawById = new Map<string, RawPaths>(
    rawRows.map((row) => [String(row.id), row.raw as RawPaths]),
  );
  const pageById = new Map<string, number[]>(
    v4Rows.map((row) => [
      String(row.id),
      ((row.D100max as { hitPositions?: number[] } | undefined)?.hitPositions ?? []) as number[],
    ]),
  );
  const budgetById = new Map<string, number>(
    v4Rows.map((row) => [
      String(row.id),
      Number((row.A as { contextCharacters?: number } | undefined)?.contextCharacters ?? 0),
    ]),
  );
  const conversations = new Map<string, ReturnType<typeof buildConversation>>();
  for (const item of allCases) {
    const sampleId = String(item.officialMetadata.sampleId);
    if (!conversations.has(sampleId)) conversations.set(sampleId, buildConversation(item));
  }

  const multiHop = allCases.filter(
    (item) => Number(item.officialMetadata.category) === 1 && eligible.has(item.id),
  );
  const regression = allCases
    .filter(
      (item) => [2, 4].includes(Number(item.officialMetadata.category)) && eligible.has(item.id),
    )
    .filter((_, index) => index % 8 === 0);

  const multi = decomposeScope(multiHop, rawById, pageById, budgetById, conversations);
  const reg = decomposeScope(regression, rawById, pageById, budgetById, conversations);
  const multihopCounts = multi.counts;
  const regressionCounts = reg.counts;

  const callsFor = (cases: readonly BenchmarkCase[]) => {
    const byCount: Record<string, number> = {};
    let total = 0;
    for (const item of cases) {
      const paths = rawById.get(item.id);
      if (!paths) continue;
      const calls = callCount(paths);
      byCount[String(calls)] = (byCount[String(calls)] ?? 0) + 1;
      total += calls;
    }
    return { byCount, total };
  };
  const neighborRows = readJsonl(resolve(root, NEIGHBOR_RUN, "neighbor-rows.jsonl"));
  const armERows = readJsonl(resolve(root, ARM_E_RUN, "arm-e-rows.jsonl"));

  const result: LossDecomposition = {
    scope: `multi-hop ${multiHop.length}, regression ${regression.length}, eligible ${manifest.eligibleIds.length} (sha256 ${manifest.sha256})`,
    questions: multiHop.length + regression.length,
    multihop: multihopCounts,
    regression: regressionCounts,
    calls: [
      { scope: "all", ...callsFor([...multiHop, ...regression]) },
      { scope: "multi-hop", ...callsFor(multiHop) },
    ],
    rescueLocus: [
      ...rescueLocusFor("C2", neighborRows, caseById, rawById),
      ...rescueLocusFor("E", armERows, caseById, rawById),
    ],
    candidateScale: {
      convention: "percentileNearestRank (tools/parts/stats.ts)",
      multiHop: multi.scale,
      regression: reg.scale,
    },
  };

  const m = multihopCounts;
  const summary = {
    ...result,
    derived: {
      multihopScopeChars:
        "oracle all@20 feasibility is per question (<=20 slots AND <= arm-A chars)",
      unionCeilingAllAt20Pct: pct(m.unionFeasible, m.questions),
      unionMissingPct: pct(m.unionMissing, m.questions),
      pageAllAt20Pct: pct(m.pageAll, m.questions),
      fusionLossPp: +(pct(m.unionFeasible, m.questions) - pct(m.pageAll, m.questions)).toFixed(1),
      queryLossPp: +(100 - pct(m.unionFeasible, m.questions)).toFixed(1),
      unionAnyHopPct: pct(m.unionAny, m.questions),
      unionHopRecallPct: pct(m.unionHopFound, m.unionHopTotal),
      pageHopRecallPct: pct(m.pageHopFound, m.pageHopTotal),
      adjacencyCeilingAllAt20Pct: pct(m.adjacencyFeasible, m.questions),
      adjacencyGainPp: +(
        pct(m.adjacencyFeasible, m.questions) - pct(m.unionFeasible, m.questions)
      ).toFixed(1),
      adjacencyCaveat: "radius 2, first 5 anchors as tested; wider radius not measured",
      rescueLocusDeltaEminusC2: rescueLocusDelta(result.rescueLocus, "E", "C2"),
      rescueLocusDeltaNote:
        "E's extra rescues are split across the three buckets; only the outside-all-paths part is adjacency's own contribution",
      armInputCeiling: {
        multihop: armInputCeilings(multiHop, rawById, budgetById, conversations),
        convention:
          "page = the arm's own fused 20 records; E input = page + arm-E ±2 pool (buildArmE anchors 5, radius 2, keepBaseline 10); C2 input = arm-A 20 records + C2 ±2 pool (buildNeighborArm, same params). Same oracle as every other ceiling: all labels covered, <=20 slots, <= arm-A chars. These are arm inputs, not the union-plus-neighbourhood ceiling.",
      },
    },
  };
  console.log(JSON.stringify(summary, null, 2));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath && invokedPath.toLowerCase() === selfPath.toLowerCase()) main();
