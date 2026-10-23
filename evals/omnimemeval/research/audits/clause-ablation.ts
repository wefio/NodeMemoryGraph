// Clause ablation over an existing multipath run — which retrieval clauses earn
// their round trip.
//
// The v4 multipath arm issues three clause searches per question (original
// query, content words, entity+aspect probe), each returning a deep pool, and
// fuses them by keeping the highest score per memory id. That is three requests
// per question. This audit answers whether fewer clauses reach the same evidence
// coverage, using only the recorded candidate lists: no retrieval, no model, no
// network.
//
// It also reports how long each clause's returned list actually was. Each
// clause requests `top_k`; the service applies its own graph, tier and token
// budgets as well, so the returned list can be shorter than the request. The
// requested depth and the returned length are two different numbers.
//
// Usage:
//   node --experimental-strip-types \
//     evals/omnimemeval/research/audits/clause-ablation.ts \
//     --raw evals/locomo/results/static-multipath-v4-2026-10-23T10-29-58/raw-candidates.jsonl \
//     --rows evals/locomo/results/static-multipath-v4-2026-10-23T10-29-58/rows.jsonl \
//     --out evals/locomo/results/clause-ablation-<runId>

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadEnvironmentFile } from "../../../local-env.ts";
import { loadLocomo } from "../../../benchmarks/loaders.ts";
import {
  buildEligibilityManifest,
  coverage,
  evidenceTextFor,
  hitPositions,
  pairedComparison,
  sliceByCharBudget,
} from "./locomo-audit-shared.ts";

export type Candidate = { id?: string; content?: string; statement?: string; score?: number };

/** Keep the highest-scoring occurrence of each memory id, then cap the page.
 * This mirrors the server's own clause fusion, so a subset arm is comparable to
 * the recorded full arm. */
export function fuseByMaxScore(
  lists: readonly (readonly Candidate[])[],
  budget: number,
): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const list of lists) {
    for (const candidate of list) {
      const key = String(candidate.id);
      const prior = byId.get(key);
      if (!prior || (candidate.score ?? 0) > (prior.score ?? 0)) byId.set(key, candidate);
    }
  }
  return [...byId.values()]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || String(a.id).localeCompare(String(b.id)))
    .slice(0, budget);
}

export type ClauseSet = "original" | "content" | "aspect";

/** Member lists for an arbitrary set of recorded derived-clause indices, with
 * the original-query pool first. The recorded run currently carries two derived
 * clauses, but nothing here assumes that count: another dimension is one more
 * index, and `memberLists` is only the name-mapped shorthand for today's three. */
export function memberListsByIndex(
  raw: { B_full?: readonly Candidate[]; derived100?: readonly (readonly Candidate[])[] },
  derivedIndices: readonly number[],
): Array<readonly Candidate[]> {
  const lists: Array<readonly Candidate[]> = [raw.B_full ?? []];
  for (const index of derivedIndices) lists.push(raw.derived100?.[index] ?? []);
  return lists;
}

/** Build the member lists for a clause subset: the original-query pool always,
 * plus the requested derived paths in recorded order. */
export function memberLists(
  raw: { B_full?: readonly Candidate[]; derived100?: readonly (readonly Candidate[])[] },
  clauses: readonly ClauseSet[],
): Array<readonly Candidate[]> {
  const indices: number[] = [];
  if (clauses.includes("content")) indices.push(0);
  if (clauses.includes("aspect")) indices.push(1);
  return memberListsByIndex(raw, indices);
}

/** Exact two-sided binomial p for a paired win/loss split, counted under the
 * null that wins and losses are equally likely. */
export function pairedBinomialP(wins: number, losses: number): number | null {
  const n = wins + losses;
  if (n === 0) return null;
  const choose = (total: number, k: number): number => {
    let value = 1;
    for (let i = 0; i < k; i += 1) value = (value * (total - i)) / (i + 1);
    return Math.round(value);
  };
  let tail = 0;
  for (let k = 0; k <= Math.min(wins, losses); k += 1) tail += choose(n, k);
  return Math.min(1, (2 * tail) / 2 ** n);
}

const ARMS: Record<string, readonly ClauseSet[]> = {
  originalOnly: [],
  plusContent: ["content"],
  plusAspect: ["aspect"],
  plusBoth: ["content", "aspect"],
};

type ArmPositions = { hitPositions?: number[] } | undefined;

const positionsOf = (row: Record<string, unknown>, arm: string): number[] =>
  (row[arm] as ArmPositions)?.hitPositions ?? [];

/** Rows where two arms disagree on the evidence hit positions at all. A zero
 * count is the ablation-is-clean evidence: without the aspect clause there is
 * nothing for it to change, so the two arms must be identical question by
 * question. */
export function identityDiffCount(
  rows: readonly Record<string, unknown>[],
  baseArm: string,
  arm: string,
): number {
  let differing = 0;
  for (const row of rows) {
    if (JSON.stringify(positionsOf(row, baseArm)) !== JSON.stringify(positionsOf(row, arm)))
      differing += 1;
  }
  return differing;
}

export type ArmPairStats = {
  n: number;
  allBefore: number;
  allAfter: number;
  wins: number;
  losses: number;
  ties: number;
};

/** Paired comparison with the all@20 counts on both sides. Same eligibility,
 * missing-arm and -2 exclusions as the frozen `pairedComparison`, which is
 * asserted by a test rather than assumed. */
export function armPairStats(
  rows: readonly Record<string, unknown>[],
  eligible: ReadonlySet<string>,
  baseArm: string,
  arm: string,
): ArmPairStats {
  const stats: ArmPairStats = { n: 0, allBefore: 0, allAfter: 0, wins: 0, losses: 0, ties: 0 };
  for (const row of rows) {
    if (!eligible.has(String(row.id))) continue;
    const before = positionsOf(row, baseArm);
    const after = positionsOf(row, arm);
    if (before.length === 0 || after.length === 0) continue;
    if (before.includes(-2) || after.includes(-2)) continue;
    const beforeAll = before.every((rank) => rank >= 0);
    const afterAll = after.every((rank) => rank >= 0);
    stats.n += 1;
    if (beforeAll) stats.allBefore += 1;
    if (afterAll) stats.allAfter += 1;
    if (afterAll && !beforeAll) stats.wins += 1;
    else if (beforeAll && !afterAll) stats.losses += 1;
    else stats.ties += 1;
  }
  return stats;
}

export type DerivedPathCohort = {
  n: number;
  /** Rows where plusContent and plusBoth disagree at all; 0 proves the ablation
   * construction is clean on this cohort. */
  diffCount: number;
  plusBothEqualsPlusContent: boolean;
  /** Direction is stated in the field name: wins are plusBoth's wins. */
  pairedPlusBothVsPlusContent: ArmPairStats;
  /** The multi-hop slice of this cohort (category === 1). */
  multiHop: ArmPairStats;
};

/** Break the ablation down by how many derived clauses a question actually ran.
 * Questions with one derived clause have no aspect clause, so the comparison is
 * vacuous there (and the identity check says so); questions with two are the
 * only place the third clause can pay or cost. */
export function derivedPathCohorts(
  rows: readonly Record<string, unknown>[],
  derivedPathsById: ReadonlyMap<string, number>,
  eligible: ReadonlySet<string>,
): Record<string, DerivedPathCohort> {
  const cohorts = new Map<number, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const count = derivedPathsById.get(String(row.id));
    if (count === undefined) continue;
    const bucket = cohorts.get(count) ?? [];
    bucket.push(row);
    cohorts.set(count, bucket);
  }
  const result: Record<string, DerivedPathCohort> = {};
  for (const count of [...cohorts.keys()].sort((left, right) => left - right)) {
    const cohort = cohorts.get(count) ?? [];
    const multiHop = cohort.filter((row) => Number(row.category) === 1);
    const diffCount = identityDiffCount(cohort, "plusContent", "plusBoth");
    const paired = armPairStats(cohort, eligible, "plusContent", "plusBoth");
    const pairedMultiHop = armPairStats(multiHop, eligible, "plusContent", "plusBoth");
    result[String(count)] = {
      n: cohort.length,
      diffCount,
      plusBothEqualsPlusContent: diffCount === 0,
      pairedPlusBothVsPlusContent: paired,
      // The cohort slice size and the compared-row count coincide here, but the
      // slice size is what a reader needs, so it is written explicitly.
      multiHop: {
        n: multiHop.length,
        allBefore: pairedMultiHop.allBefore,
        allAfter: pairedMultiHop.allAfter,
        wins: pairedMultiHop.wins,
        losses: pairedMultiHop.losses,
        ties: pairedMultiHop.ties,
      },
    };
  }
  return result;
}

type CliValues = { raw: string; rows: string; out: string; pageBudget: number; envFile: string };

function readCli(): CliValues {
  const { values } = parseArgs({
    options: {
      raw: { type: "string" },
      rows: { type: "string" },
      out: { type: "string" },
      // Final page size after fusion. Kept separate from each clause's requested
      // depth so a subset arm is comparable to the recorded full arm.
      "page-budget": { type: "string", default: "20" },
      "env-file": { type: "string", default: ".env.nmg-locomo-audit" },
    },
  });
  if (!values.raw || !values.rows || !values.out) {
    throw new Error("usage: --raw <raw-candidates.jsonl> --rows <rows.jsonl> --out <dir>");
  }
  const pageBudget = Number(values["page-budget"]);
  if (!Number.isInteger(pageBudget) || pageBudget < 1) {
    throw new Error("--page-budget must be a positive integer");
  }
  return {
    raw: values.raw,
    rows: values.rows,
    out: values.out,
    pageBudget,
    envFile: values["env-file"]!,
  };
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  const rows = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  if (rows.length === 0) throw new Error(`${path} has no rows`);
  return rows;
}

type RawShape = {
  A?: readonly Candidate[];
  B_full?: readonly Candidate[];
  D100max?: readonly Candidate[];
  derived100?: readonly (readonly Candidate[])[];
};

/** Build one ablation row per question, with a self-check that the reconstructed
 * full arm equals the recorded one. */
function buildRow(
  rawRow: Record<string, unknown>,
  baseline: Record<string, unknown>,
  item: ReturnType<typeof loadLocomo>[number],
  pageBudget: number,
): { row: Record<string, unknown>; poolDepth: number; derivedPaths: number } {
  const id = String(rawRow.id);
  const raw = rawRow.raw as RawShape;
  const evidence = evidenceTextFor(item);
  const budget = Number(
    (baseline.A as { contextCharacters?: number } | undefined)?.contextCharacters ?? 0,
  );
  const row: Record<string, unknown> = {
    id,
    workerUserId: rawRow.workerUserId,
    // raw-candidates.jsonl carries no category; take it from the recorded row so
    // the scope split cannot silently collapse into "no multi-hop rows".
    category: Number(baseline.category ?? item.officialMetadata.category),
    A: { hitPositions: hitPositions(raw.A ?? [], item, evidence) },
  };
  for (const [arm, clauses] of Object.entries(ARMS)) {
    const fused = fuseByMaxScore(memberLists(raw, clauses), pageBudget);
    row[arm] = { hitPositions: hitPositions(fused, item, evidence) };
    row[`budget_${arm}`] = {
      hitPositions: hitPositions(sliceByCharBudget(fused, budget), item, evidence),
    };
  }
  // The "both" subset must reproduce the recorded full arm. If it does not, the
  // subset arms describe a different mechanism and mean nothing.
  const rebuilt = JSON.stringify(
    hitPositions(fuseByMaxScore(memberLists(raw, ARMS.plusBoth), pageBudget), item, evidence),
  );
  const recordedFull = JSON.stringify(hitPositions(raw.D100max ?? [], item, evidence));
  if (rebuilt !== recordedFull) {
    throw new Error(`${id}: reconstructed both-clause arm does not match the recorded D100max arm`);
  }
  return { row, poolDepth: (raw.B_full ?? []).length, derivedPaths: (raw.derived100 ?? []).length };
}

function main(): void {
  const cli = readCli();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const env = loadEnvironmentFile(resolve(root, cli.envFile));
  const dataPath = env.NMG_LOCOMO_DATA;
  if (!dataPath) throw new Error("NMG_LOCOMO_DATA missing from the environment file");

  const cases = loadLocomo(dataPath);
  const manifest = buildEligibilityManifest(cases);
  const eligible = new Set(manifest.eligibleIds);
  const byId = new Map(cases.map((item) => [item.id, item]));

  const rawRows = readJsonl(resolve(root, cli.raw));
  const recordedRows = readJsonl(resolve(root, cli.rows));
  if (rawRows.length !== recordedRows.length) {
    throw new Error(`raw rows ${rawRows.length} != recorded rows ${recordedRows.length}`);
  }
  const recorded = new Map(recordedRows.map((row) => [String(row.id), row]));

  const rows: Array<Record<string, unknown>> = [];
  const poolDepth: number[] = [];
  const derivedCounts: Record<string, number> = {};
  const derivedPathsById = new Map<string, number>();
  for (const rawRow of rawRows) {
    const id = String(rawRow.id);
    const item = byId.get(id);
    const baseline = recorded.get(id);
    if (!item || !baseline) {
      throw new Error(`row ${id} is missing from the dataset or the recorded rows`);
    }
    const built = buildRow(rawRow, baseline, item, cli.pageBudget);
    rows.push(built.row);
    poolDepth.push(built.poolDepth);
    derivedPathsById.set(id, built.derivedPaths);
    const key = String(built.derivedPaths);
    derivedCounts[key] = (derivedCounts[key] ?? 0) + 1;
  }

  const sortedDepth = [...poolDepth].sort((a, b) => a - b);
  const percentile = (p: number): number =>
    sortedDepth[Math.min(sortedDepth.length - 1, Math.floor(p * sortedDepth.length))];
  const scope = {
    multiHop: rows.filter((row) => Number(row.category) === 1),
    regression: rows.filter((row) => Number(row.category) !== 1),
  };
  if (scope.multiHop.length === 0) {
    throw new Error("no multi-hop rows after the scope split; category is missing from the inputs");
  }
  const summarise = (list: Array<Record<string, unknown>>) => {
    const withP = (arm: string, base: string) => {
      const paired = pairedComparison(list, base, arm, eligible);
      return { ...paired, p: pairedBinomialP(paired.wins, paired.losses) };
    };
    return {
      coverage: Object.fromEntries(
        ["A", ...Object.keys(ARMS)].map((arm) => [arm, coverage(list, arm)]),
      ),
      pairedVersusA: Object.fromEntries(Object.keys(ARMS).map((arm) => [arm, withP(arm, "A")])),
      pairedVersusFull: Object.fromEntries(
        ["originalOnly", "plusContent", "plusAspect"].map((arm) => [arm, withP(arm, "plusBoth")]),
      ),
      equalCharacterBudget: Object.fromEntries(
        Object.keys(ARMS).map((arm) => [arm, withP(`budget_${arm}`, "A")]),
      ),
    };
  };

  const summary = {
    measuredAt: new Date().toISOString(),
    inputs: { raw: cli.raw, rows: cli.rows, dataset: dataPath, pageBudget: cli.pageBudget },
    manifest: { sha256: manifest.sha256, eligible: manifest.eligibleIds.length },
    scope: {
      rows: rows.length,
      multiHop: scope.multiHop.length,
      regression: scope.regression.length,
    },
    measuredPoolDepth: {
      requestedPerClause: 100,
      mechanism:
        "each clause requests top_k; the service also applies its own graph, tier and token budgets, so a clause can return fewer records than requested",
      p25: percentile(0.25),
      p50: percentile(0.5),
      p75: percentile(0.75),
      max: sortedDepth[sortedDepth.length - 1],
    },
    derivedPathCounts: derivedCounts,
    // The aspect clause only exists where a question ran two derived clauses, so
    // the aggregate 0W/2L pairing hides where the third clause can act at all.
    byDerivedPathCount: derivedPathCohorts(rows, derivedPathsById, eligible),
    multiHop: summarise(scope.multiHop),
    regression: summarise(scope.regression),
  };

  const outDir = resolve(root, cli.out);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(
    resolve(outDir, "ablation-rows.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
  console.log(
    JSON.stringify(
      { out: outDir, rows: rows.length, poolDepthP50: summary.measuredPoolDepth.p50 },
      null,
      2,
    ),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
