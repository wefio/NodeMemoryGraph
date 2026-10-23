// Arm E combo probe (preregistered): multipath candidate pool + session
// adjacency, fully offline. Consumes the v4 raw-candidates (D100max ordered
// lists + A) and the P2 neighbor run (C2 raw) — NO search requests, NO
// embedding calls, NO LLM calls, no worker.
//
// Preregistration (fixed before this run; no tuning on gold):
//   docs/experiments/benchmarks/locomo-arm-e-preregistration-2026-10-23.md
// Protocol:
//   1. Control arms first: A and D100max re-scored from v4 raw, C2 re-scored
//      from the neighbor run raw — must reproduce the published numbers
//      (A 16.1/73.1/38.4; D100max 20.8/75.6/41.7 W16/L3; C2 19.4/75.3/42.2
//      W16/L7). Any mismatch aborts the run (pipeline drift).
//   2. E = D100max ordered list as baseline; first anchorCount=5 entries
//      resolved back to source turns (duplicates take first; ambiguity and
//      unresolved counted); same-session ±radius neighbors; fusion per the
//      neighbor rules (keepBaseline=10, round-robin kept prefix with the
//      neighbor queue, then baseline tail, capacity=20); sensitivity arm E1
//      with radius 1.
//   3. Budget views: sliceByCharBudget(arm, A.contextCharacters).
//   4. Gold isolation: evidenceIds only for scoring; category/reference never
//      enter generation. No cross-user or cross-session neighborhoods.
// Stopping rule (fixed): if E's multi-hop all@20 is not significantly better
// than D100max, or the equal-budget slice eats D100max's gain, stay at v4;
// adjacency is recorded as a regression-completeness fix only.
//
// Usage: node --experimental-strip-types evals/omnimemeval/research/audits/static-arm-e-recall.ts [neighbor-run-dir]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvironmentFile } from "../../../local-env.ts";
import { loadLocomo } from "../../../benchmarks/loaders.ts";
import type { BenchmarkCase } from "../../../benchmarks/types.ts";
import {
  buildEligibilityManifest,
  coverage,
  hitPositions,
  locomoUserKey,
  normalizeText,
  pairedComparison,
  sliceByCharBudget,
} from "./locomo-audit-shared.ts";
import {
  buildConversation,
  fuseNeighborArm,
  selectAnchors,
  expandNeighbors,
  turnKeyOf,
  type Conversation,
  type Memory,
  type NeighborParams,
  type Turn,
} from "./static-neighbor-recall.ts";

// ── Fixed parameters (preregistered; identical to the C2 defaults). ──
export type EParams = NeighborParams;
export const E_PRIMARY: EParams = { anchorCount: 5, radius: 2, keepBaseline: 10, capacity: 20 };
export const E_SENSITIVITY: EParams = { ...E_PRIMARY, radius: 1 };

export type D100Entry = { id?: string; content?: string; statement?: string; score?: number };

const entryContent = (entry: D100Entry): string => entry.content ?? entry.statement ?? "";

export type BaselineResolution = {
  /** Per D100max rank: the resolved source turn, or null. */
  refs: (Turn | null)[];
  unresolved: number;
  /** Entries whose text maps to several distinct turns (first taken). */
  ambiguous: number;
};

/** Resolve ordered D100max entries back to conversation turns. Raw exact
 * match first, normalized fallback; duplicate texts take the first
 * occurrence (deterministic) and are flagged ambiguous. */
export function resolveBaselineTurns(
  entries: readonly D100Entry[],
  conversation: Conversation,
): BaselineResolution {
  const refs: (Turn | null)[] = [];
  let unresolved = 0;
  let ambiguous = 0;
  for (const entry of entries) {
    const content = entryContent(entry);
    const raw = conversation.byIngested.get(content);
    if (raw && raw.length > 0) {
      refs.push(raw[0]);
      if (raw.length > 1) ambiguous += 1;
      continue;
    }
    const normalized = conversation.byNormalized.get(normalizeText(content));
    if (normalized && normalized.length > 0) {
      refs.push(normalized[0]);
      if (normalized.length > 1) ambiguous += 1;
      continue;
    }
    refs.push(null);
    unresolved += 1;
  }
  return { refs, unresolved, ambiguous };
}

export type ArmE = {
  resolution: BaselineResolution;
  anchors: Turn[];
  pool: Turn[];
  contents: string[];
};

/** Full arm E construction (pure; used by main and tests). */
export function buildArmE(
  entries: readonly D100Entry[],
  conversation: Conversation,
  params: EParams,
): ArmE {
  const resolution = resolveBaselineTurns(entries, conversation);
  const anchorLimit = Math.min(params.anchorCount, resolution.refs.length);
  const anchors = selectAnchors(resolution.refs, anchorLimit);
  const keptKeys = new Set<string>();
  for (const ref of resolution.refs.slice(0, params.keepBaseline)) {
    if (ref) keptKeys.add(turnKeyOf(ref));
  }
  const pool = expandNeighbors(anchors, conversation, params.radius, keptKeys);
  const contents = fuseNeighborArm(
    { contents: entries.map(entryContent), refs: resolution.refs, unmapped: 0 },
    pool,
    params,
  );
  return { resolution, anchors, pool, contents };
}

const chars = (memories: readonly Memory[]): number =>
  memories.reduce((sum, memory) => sum + (memory.content ?? memory.statement ?? "").length, 0);

/** Exact two-sided paired binomial (sign test) p-value. */
export function exactTwoSidedP(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const observed = Math.min(wins, losses);
  let cumulative = 0;
  for (let k = 0; k <= observed; k += 1) {
    let coefficient = 1;
    for (let i = 1; i <= k; i += 1) coefficient = (coefficient * (n - k + i)) / i;
    cumulative += coefficient;
  }
  return Math.min(1, (2 * cumulative) / 2 ** n);
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ── Probe phases. ──

type ProbeInputs = {
  multiHop: BenchmarkCase[];
  regression: BenchmarkCase[];
  eligible: ReadonlySet<string>;
  manifestSha: string;
  v4Dir: string;
  neighborDir: string;
  /** question id → ordered control entries (v4 raw; one row per question).
   * Note: the v4 rows' fileKey uses a question-ordinal convention, NOT the
   * shared contract's dataset-index keys; the question id is the join key. */
  rawByQuestionId: Map<string, Record<string, D100Entry[]>>;
  /** question id → A.contextCharacters (v4 rows). */
  budgetAByQuestionId: Map<string, number>;
  /** question id → ordered C2 contents (neighbor run raw). */
  c2ByQuestionId: Map<string, string[]>;
  conversations: Map<string, Conversation>;
  fileKeyBySample: Map<string, string>;
};

const V4_DIR = "evals/locomo/results/static-multipath-v4-2026-10-23T10-29-58";
const NEIGHBOR_DIR_DEFAULT = "evals/locomo/results/static-neighbor-2026-10-23T11-07-04";

function loadInputs(): ProbeInputs {
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
  const manifestPath = resolve(root, "evals/locomo/results/locomo-eligible-manifest.json");
  if (existsSync(manifestPath)) {
    const frozen = JSON.parse(readFileSync(manifestPath, "utf8")) as { sha256: string };
    if (frozen.sha256 !== manifest.sha256) {
      throw new Error(`eligible manifest drift: ${manifest.sha256} != frozen ${frozen.sha256}`);
    }
  }
  const eligible = new Set(manifest.eligibleIds);

  const v4Dir = resolve(root, V4_DIR);
  const neighborDir = resolve(root, process.argv[2] ?? NEIGHBOR_DIR_DEFAULT);
  const rawRows = readJsonl(resolve(v4Dir, "raw-candidates.jsonl"));
  const v4Rows = readJsonl(resolve(v4Dir, "rows.jsonl"));
  const neighborRows = readJsonl(resolve(neighborDir, "neighbor-rows.jsonl"));

  const rawByQuestionId = new Map<string, Record<string, D100Entry[]>>();
  for (const row of rawRows) {
    rawByQuestionId.set(String(row.id), row.raw as Record<string, D100Entry[]>);
  }
  const budgetAByQuestionId = new Map<string, number>();
  for (const row of v4Rows) {
    const armA = row.A as { contextCharacters?: number };
    budgetAByQuestionId.set(String(row.id), Number(armA.contextCharacters ?? 0));
  }
  const c2ByQuestionId = new Map<string, string[]>();
  for (const row of neighborRows) {
    const raw = row.raw as { C2?: string[] } | undefined;
    if (raw?.C2) c2ByQuestionId.set(String(row.id), raw.C2);
  }

  const conversations = new Map<string, Conversation>();
  const fileKeyBySample = new Map<string, string>();
  for (const item of allCases) {
    const sampleId = String(item.officialMetadata.sampleId);
    if (conversations.has(sampleId)) continue;
    conversations.set(sampleId, buildConversation(item));
    fileKeyBySample.set(sampleId, locomoUserKey(fileKeyBySample.size));
  }

  const multiHop = allCases.filter(
    (item) => Number(item.officialMetadata.category) === 1 && eligible.has(item.id),
  );
  const regression = allCases
    .filter(
      (item) => [2, 4].includes(Number(item.officialMetadata.category)) && eligible.has(item.id),
    )
    .filter((_, index) => index % 8 === 0);
  console.error(
    `eligible ${manifest.eligibleIds.length} (sha ${manifest.sha256.slice(0, 16)}…), scope: ` +
      `${multiHop.length} multi + ${regression.length} regression`,
  );
  return {
    multiHop,
    regression,
    eligible,
    manifestSha: manifest.sha256,
    v4Dir,
    neighborDir,
    rawByQuestionId,
    budgetAByQuestionId,
    c2ByQuestionId,
    conversations,
    fileKeyBySample,
  };
}

type QuestionArms = {
  fileKey: string;
  sampleId: string;
  A: Memory[];
  D100max: Memory[];
  C2: Memory[];
  E: Memory[];
  E1: Memory[];
  budgetAChars: number;
  budgetD100max: Memory[];
  budgetC2: Memory[];
  budgetE: Memory[];
  budgetE1: Memory[];
  eDiagnostics: { unresolved: number; ambiguous: number; pool: number };
};

const toMemories = (contents: readonly string[]): Memory[] =>
  contents.map((content) => ({ content }));

function collectQuestionArms(item: BenchmarkCase, inputs: ProbeInputs): QuestionArms | null {
  const sampleId = String(item.officialMetadata.sampleId);
  const conversation = inputs.conversations.get(sampleId);
  const raw = inputs.rawByQuestionId.get(item.id);
  const budgetA = inputs.budgetAByQuestionId.get(item.id);
  if (!conversation || !raw || budgetA === undefined) return null;
  const d100 = raw.D100max ?? [];
  const armE = buildArmE(d100, conversation, E_PRIMARY);
  const armE1 = buildArmE(d100, conversation, E_SENSITIVITY);
  const a = raw.A ?? [];
  const d100Memories = toMemories(d100.map(entryContent));
  const eMemories = toMemories(armE.contents);
  const e1Memories = toMemories(armE1.contents);
  return {
    fileKey: inputs.fileKeyBySample.get(sampleId) ?? "",
    sampleId,
    A: toMemories(a.map(entryContent)),
    D100max: d100Memories,
    C2: toMemories(inputs.c2ByQuestionId.get(item.id) ?? []),
    E: eMemories,
    E1: e1Memories,
    budgetAChars: budgetA,
    budgetD100max: sliceByCharBudget(d100Memories, budgetA),
    budgetC2: sliceByCharBudget(toMemories(inputs.c2ByQuestionId.get(item.id) ?? []), budgetA),
    budgetE: sliceByCharBudget(eMemories, budgetA),
    budgetE1: sliceByCharBudget(e1Memories, budgetA),
    eDiagnostics: {
      unresolved: armE.resolution.unresolved,
      ambiguous: armE.resolution.ambiguous,
      pool: armE.pool.length,
    },
  };
}

function main(): void {
  const inputs = loadInputs();
  const rows: Array<Record<string, unknown>> = [];
  const eDiagnostics = { unresolved: 0, ambiguous: 0, poolSum: 0 };
  let scored = 0;
  let missingArms = 0;

  for (const item of [...inputs.multiHop, ...inputs.regression]) {
    const arms = collectQuestionArms(item, inputs);
    if (!arms) {
      missingArms += 1;
      rows.push({ id: item.id, error: "missing control inputs" });
      continue;
    }
    const evidenceText = (() => {
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
    })();
    const positions = (memories: readonly Memory[]): number[] =>
      hitPositions(memories, item, evidenceText);
    eDiagnostics.unresolved += arms.eDiagnostics.unresolved;
    eDiagnostics.ambiguous += arms.eDiagnostics.ambiguous;
    eDiagnostics.poolSum += arms.eDiagnostics.pool;
    scored += 1;
    rows.push({
      id: item.id,
      fileKey: arms.fileKey,
      workerUserId: arms.sampleId,
      category: item.officialMetadata.category,
      A: { hitPositions: positions(arms.A), contextCharacters: chars(arms.A) },
      D100max: { hitPositions: positions(arms.D100max), contextCharacters: chars(arms.D100max) },
      C2: { hitPositions: positions(arms.C2), contextCharacters: chars(arms.C2) },
      E: { hitPositions: positions(arms.E), contextCharacters: chars(arms.E) },
      E1: { hitPositions: positions(arms.E1), contextCharacters: chars(arms.E1) },
      budgetD100max: { hitPositions: positions(arms.budgetD100max) },
      budgetC2: { hitPositions: positions(arms.budgetC2) },
      budgetE: { hitPositions: positions(arms.budgetE) },
      budgetE1: { hitPositions: positions(arms.budgetE1) },
      raw: {
        A: arms.A.map((memory) => memory.content ?? ""),
        D100max: arms.D100max.map((memory) => memory.content ?? ""),
        E: arms.E.map((memory) => memory.content ?? ""),
        E1: arms.E1.map((memory) => memory.content ?? ""),
      },
    });
  }
  if (missingArms > 0) {
    throw new Error(`${missingArms} questions missing control inputs — aborting before scoring`);
  }

  // ── Control-arm reproduction gate (preregistration step 1). ──
  const multiIds = new Set(inputs.multiHop.map((item) => item.id));
  const regressionIds = new Set(inputs.regression.map((item) => item.id));
  const multi = rows.filter((row) => multiIds.has(String(row.id)) && !row.error);
  const gate = (key: string, expect: { allPct: number; anyPct: number; recallPct: number }) => {
    const value = coverage(multi, key);
    const matches =
      value.allPct === expect.allPct &&
      value.anyPct === expect.anyPct &&
      value.recallPct === expect.recallPct;
    if (!matches) {
      throw new Error(
        `control arm ${key} drift: got ${JSON.stringify(value)}, expected ${JSON.stringify(expect)}`,
      );
    }
    console.error(
      `control ${key}: reproduced (${value.allPct}/${value.anyPct}/${value.recallPct})`,
    );
  };
  gate("A", { allPct: 16.1, anyPct: 73.1, recallPct: 38.4 });
  gate("D100max", { allPct: 20.8, anyPct: 75.6, recallPct: 41.7 });
  gate("C2", { allPct: 19.4, anyPct: 75.3, recallPct: 42.2 });
  const d100Paired = pairedComparison(multi, "A", "D100max", inputs.eligible);
  const c2Paired = pairedComparison(multi, "A", "C2", inputs.eligible);
  if (d100Paired.wins !== 16 || d100Paired.losses !== 3) {
    throw new Error(
      `control D100max paired drift: W${d100Paired.wins}/L${d100Paired.losses}, expected W16/L3`,
    );
  }
  if (c2Paired.wins !== 16 || c2Paired.losses !== 7) {
    throw new Error(
      `control C2 paired drift: W${c2Paired.wins}/L${c2Paired.losses}, expected W16/L7`,
    );
  }
  console.error("control arms reproduced (A, D100max W16/L3, C2 W16/L7)");

  // ── Summary. ──
  const armKeys = [
    "A",
    "D100max",
    "C2",
    "E",
    "E1",
    "budgetD100max",
    "budgetC2",
    "budgetE",
    "budgetE1",
  ];
  const summarize = (ids: ReadonlySet<string>) => {
    const subset = rows.filter((row) => ids.has(String(row.id)) && !row.error);
    const coverageByArm: Record<string, unknown> = {};
    for (const key of armKeys) coverageByArm[key] = coverage(subset, key);
    const paired = {
      vsA: Object.fromEntries(
        ["D100max", "C2", "E", "E1", "budgetD100max", "budgetC2", "budgetE", "budgetE1"].map(
          (key) => [key, withP(pairedComparison(subset, "A", key, inputs.eligible))],
        ),
      ),
      stoppingRule: {
        E_vs_D100max: withP(pairedComparison(subset, "D100max", "E", inputs.eligible)),
        budgetE_vs_budgetD100max: withP(
          pairedComparison(subset, "budgetD100max", "budgetE", inputs.eligible),
        ),
      },
    };
    return { coverage: coverageByArm, paired };
  };
  const withP = (result: ReturnType<typeof pairedComparison>) => ({
    ...result,
    p: exactTwoSidedP(result.wins, result.losses),
  });

  const ownerCounts = (key: string, baselineKey: string) => {
    const counts = new Map<string, { wins: number; losses: number; ties: number }>();
    for (const row of rows) {
      if (!inputs.eligible.has(String(row.id)) || row.error) continue;
      const owner = String(row.workerUserId);
      const base = row[baselineKey] as { hitPositions: number[] };
      const arm = row[key] as { hitPositions: number[] };
      const baseAll = base.hitPositions.length > 0 && base.hitPositions.every((rank) => rank >= 0);
      const armAll = arm.hitPositions.length > 0 && arm.hitPositions.every((rank) => rank >= 0);
      const entry = counts.get(owner) ?? { wins: 0, losses: 0, ties: 0 };
      if (armAll && !baseAll) entry.wins += 1;
      else if (baseAll && !armAll) entry.losses += 1;
      else entry.ties += 1;
      counts.set(owner, entry);
    }
    return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
  };

  const meanChars = (key: string) => {
    const values = rows
      .filter((row) => !row.error)
      .map((row) => (row[key] as { contextCharacters?: number } | undefined)?.contextCharacters)
      .filter((value): value is number => typeof value === "number");
    const mean = values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
    return +mean.toFixed(1);
  };

  const summary = {
    runId: new Date().toISOString().replaceAll(":", "-").slice(0, 19),
    preregistration: "docs/experiments/benchmarks/locomo-arm-e-preregistration-2026-10-23.md",
    mechanism: "D100max pool + session adjacency (offline, zero LLM)",
    params: { primary: E_PRIMARY, sensitivity: E_SENSITIVITY },
    manifest: { sha256: inputs.manifestSha },
    sources: { v4Dir: inputs.v4Dir, neighborDir: inputs.neighborDir },
    scope: {
      multiHop: inputs.multiHop.length,
      regression: inputs.regression.length,
      rows: rows.length,
    },
    multiHop: summarize(multiIds),
    regression: summarize(regressionIds),
    owners: {
      multiHop: { E_vs_A: ownerCounts("E", "A"), D100max_vs_A: ownerCounts("D100max", "A") },
    },
    contextCharacters: {
      multiHopMean: Object.fromEntries(
        ["A", "D100max", "C2", "E", "E1"].map((key) => [key, meanChars(key)]),
      ),
    },
    eDiagnostics: {
      unresolvedAnchors: eDiagnostics.unresolved,
      ambiguousAnchors: eDiagnostics.ambiguous,
      poolMean: +(eDiagnostics.poolSum / (scored || 1)).toFixed(2),
    },
  };

  const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
  const outputDirectory = resolve(root, "evals/locomo/results", `static-arm-e-${summary.runId}`);
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    resolve(outputDirectory, "arm-e-rows.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  writeFileSync(resolve(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  console.error(`done: ${outputDirectory}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath && invokedPath.toLowerCase() === selfPath.toLowerCase()) {
  main();
}
