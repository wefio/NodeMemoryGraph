// Static session-adjacency expansion probe (arm C) for the LoCoMo zero-LLM
// retrieval work. Fully offline: consumes the frozen baseline capture
// (search-results.json contexts) plus locomo10.json only — NO search
// requests, NO embedding calls, NO LLM calls, no worker.
//
// Mechanism (pre-registered parameter set, no tuning):
//   A         = baseline top-20 context reconstructed from the capture in
//               retrieval-rank order, each line resolved back to its source
//               turn (session index, turn index) in the conversation.
//   anchors   = the first `anchorCount` baseline hits that resolve to
//               conversation turns ("limited high-ranked anchors").
//   neighbors = for every anchor, the ±1..±radius turns of the SAME session
//               (deterministic candidate order: anchor rank, then distance,
//               then -d before +d), de-duplicated, excluding turns already
//               present in the kept baseline prefix.
//   C_r       = deterministic fusion: kept baseline prefix round-robined
//               with the neighbor queue, then the remaining baseline tail,
//               capped at `capacity` (<= 20) items. Membership only affects
//               coverage@20; ordering exists so the fixed-text-budget view
//               cannot silently strand the neighbors at the tail.
//   budget C  = sliceByCharBudget(C, chars(A)): the same per-question text
//               budget as arm A.
// Scoring goes through locomo-audit-shared.ts (frozen contract) against the
// frozen eligible manifest; paired comparisons share one eligible
// denominator. Sensitivity arm C1 repeats the mechanism with radius 1.
//
// Output: evals/locomo/results/static-neighbor-<runId>/{neighbor-rows.jsonl,
// summary.json}. Rows carry raw ranked contents for A/C1/C2 so any reviewer
// can re-derive the summary without re-running the probe.
//
// Usage: node --experimental-strip-types evals/omnimemeval/research/audits/static-neighbor-recall.ts [capture-run-dir]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvironmentFile } from "../../../local-env.ts";
import { loadLocomo } from "../../../benchmarks/loaders.ts";
import type { BenchmarkCase } from "../../../benchmarks/types.ts";
import {
  buildEligibilityManifest,
  coverage,
  evidenceTextFor,
  hitPositions,
  locomoUserKey,
  normalizeText,
  pairedComparison,
  sliceByCharBudget,
} from "./locomo-audit-shared.ts";

// ── Pre-registered parameters (fixed before the first run; never tuned). ──
export type NeighborParams = {
  /** Number of high-ranked baseline hits that act as anchors. */
  anchorCount: number;
  /** ±radius of same-session turns explored around each anchor. */
  radius: number;
  /** Baseline prefix kept intact before neighbors may compete for slots. */
  keepBaseline: number;
  /** Hard cap on the final fused list (the shared top-20 budget). */
  capacity: number;
};

export const DEFAULT_NEIGHBOR_PARAMS: NeighborParams = {
  anchorCount: 5,
  radius: 2,
  keepBaseline: 10,
  capacity: 20,
};

export type Turn = {
  sessionIndex: number;
  turnIndex: number;
  sourceId: string;
  ingested: string;
  normalized: string;
};

export type Conversation = {
  /** sessions[sessionIndex] = turns in dataset order. */
  sessions: Turn[][];
  byIngested: Map<string, Turn[]>;
  byNormalized: Map<string, Turn[]>;
};

export type BaselineArm = {
  /** Reconstructed contents in retrieval-rank order. */
  contents: string[];
  /** Per-rank source turn (null = line did not resolve to any turn). */
  refs: (Turn | null)[];
  /** Number of context lines that did not resolve to a conversation turn. */
  unmapped: number;
};

export type NeighborArm = {
  baseline: BaselineArm;
  anchors: Turn[];
  pool: Turn[];
  contents: string[];
};

export type Memory = { content?: string; statement?: string };

export const turnKeyOf = (turn: Turn): string => `t:${turn.sessionIndex}:${turn.turnIndex}`;
const contentKey = (content: string): string => `c:${content}`;
const MAX_MERGE_LINES = 8;

/** Build the conversation index from the FIRST case seen for a dataset row
 * (all questions of a row share the same sessions). */
export function buildConversation(item: BenchmarkCase): Conversation {
  const sessions: Turn[][] = item.sessions.map((session, sessionIndex) =>
    session.turns.map((turn, turnIndex) => {
      const ingested = turn.speaker ? `${turn.speaker}: ${turn.content}` : turn.content;
      return {
        sessionIndex,
        turnIndex,
        sourceId: turn.sourceId,
        ingested,
        normalized: normalizeText(ingested),
      };
    }),
  );
  const byIngested = new Map<string, Turn[]>();
  const byNormalized = new Map<string, Turn[]>();
  for (const session of sessions) {
    for (const turn of session) {
      const rawList = byIngested.get(turn.ingested);
      if (rawList) rawList.push(turn);
      else byIngested.set(turn.ingested, [turn]);
      const normList = byNormalized.get(turn.normalized);
      if (normList) normList.push(turn);
      else byNormalized.set(turn.normalized, [turn]);
    }
  }
  return { sessions, byIngested, byNormalized };
}

/** Reconstruct the ordered baseline arm from a capture context string.
 *
 * The capture joins retrieved memory contents with "\n"; LoCoMo has a few
 * turns whose text itself contains newlines, so a naive split fragments
 * them. We greedily merge 1..MAX_MERGE_LINES segments when the joined text
 * exactly matches a conversation turn (raw first, normalized fallback).
 * Unresolvable segments are kept verbatim with a null ref — they still
 * score normally through the shared substring contract, they just cannot
 * anchor neighbor expansion. Duplicate texts resolve to the first
 * occurrence (deterministic; only two conversations contain a duplicate). */
export function reconstructBaseline(context: string, conversation: Conversation): BaselineArm {
  const lines = context.split("\n");
  const contents: string[] = [];
  const refs: (Turn | null)[] = [];
  let unmapped = 0;
  let index = 0;
  while (index < lines.length) {
    let matched: Turn | null = null;
    let used = 1;
    for (let span = 1; span <= MAX_MERGE_LINES && index + span <= lines.length; span += 1) {
      const candidate = lines.slice(index, index + span).join("\n");
      const raw = conversation.byIngested.get(candidate);
      if (raw && raw.length > 0) {
        matched = raw[0];
        used = span;
        break;
      }
      const normalized = conversation.byNormalized.get(normalizeText(candidate));
      if (normalized && normalized.length > 0) {
        matched = normalized[0];
        used = span;
        break;
      }
    }
    const joined = lines.slice(index, index + used).join("\n");
    if (matched) {
      contents.push(matched.ingested);
      refs.push(matched);
    } else {
      contents.push(joined);
      refs.push(null);
      unmapped += 1;
    }
    index += used;
  }
  return { contents, refs, unmapped };
}

/** The limited high-ranked anchors: earliest ranks that resolved to a turn,
 * de-duplicated by turn identity. */
export function selectAnchors(refs: readonly (Turn | null)[], limit: number): Turn[] {
  const anchors: Turn[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref) continue;
    const key = turnKeyOf(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push(ref);
    if (anchors.length >= limit) break;
  }
  return anchors;
}

/** Same-session ±1..±radius neighbors in deterministic order
 * (anchor rank → distance → -d before +d), de-duplicated across anchors and
 * skipping turns in `excludedKeys` (the kept baseline prefix). */
export function expandNeighbors(
  anchors: readonly Turn[],
  conversation: Conversation,
  radius: number,
  excludedKeys: ReadonlySet<string>,
): Turn[] {
  const pool: Turn[] = [];
  const seen = new Set<string>(excludedKeys);
  for (const anchor of anchors) {
    const session = conversation.sessions[anchor.sessionIndex];
    if (!session) continue;
    for (let distance = 1; distance <= radius; distance += 1) {
      for (const offset of [-distance, distance]) {
        const target = anchor.turnIndex + offset;
        if (target < 0 || target >= session.length) continue;
        const turn = session[target];
        const key = turnKeyOf(turn);
        if (seen.has(key)) continue;
        seen.add(key);
        pool.push(turn);
      }
    }
  }
  return pool;
}

/** Deterministic fusion under the shared top-20 budget:
 *  1. round-robin the kept baseline prefix with the neighbor queue;
 *  2. fill remaining slots from the baseline tail (rank >= keepBaseline),
 *     skipping anything already fused (a tail turn re-entering as a
 *     neighbor appears exactly once);
 *  3. never exceed `capacity`. */
export function fuseNeighborArm(
  baseline: BaselineArm,
  pool: readonly Turn[],
  params: NeighborParams,
): string[] {
  const keptCount = Math.min(params.keepBaseline, baseline.contents.length);
  const fused: string[] = [];
  const seen = new Set<string>();
  const push = (content: string, key: string): void => {
    if (seen.has(key) || fused.length >= params.capacity) return;
    seen.add(key);
    fused.push(content);
  };
  let baselineIndex = 0;
  let poolIndex = 0;
  while (fused.length < params.capacity && (baselineIndex < keptCount || poolIndex < pool.length)) {
    if (baselineIndex < keptCount) {
      const ref = baseline.refs[baselineIndex];
      push(
        baseline.contents[baselineIndex],
        ref ? turnKeyOf(ref) : contentKey(baseline.contents[baselineIndex]),
      );
      baselineIndex += 1;
    }
    if (fused.length >= params.capacity) break;
    if (poolIndex < pool.length) {
      const turn = pool[poolIndex];
      push(turn.ingested, turnKeyOf(turn));
      poolIndex += 1;
    }
  }
  for (
    let index = params.keepBaseline;
    index < baseline.contents.length && fused.length < params.capacity;
    index += 1
  ) {
    const ref = baseline.refs[index];
    push(baseline.contents[index], ref ? turnKeyOf(ref) : contentKey(baseline.contents[index]));
  }
  return fused;
}

/** Full per-question arm construction (pure; used by main and tests). */
export function buildNeighborArm(
  context: string,
  conversation: Conversation,
  params: NeighborParams,
): NeighborArm {
  const baseline = reconstructBaseline(context, conversation);
  const anchors = selectAnchors(baseline.refs, params.anchorCount);
  const keptKeys = new Set<string>();
  for (const ref of baseline.refs.slice(0, params.keepBaseline)) {
    if (ref) keptKeys.add(turnKeyOf(ref));
  }
  const pool = expandNeighbors(anchors, conversation, params.radius, keptKeys);
  const contents = fuseNeighborArm(baseline, pool, params);
  return { baseline, anchors, pool, contents };
}

const chars = (memories: readonly Memory[]): number =>
  memories.reduce((sum, memory) => sum + (memory.content ?? memory.statement ?? "").length, 0);

// ── Probe phases: load, collect, summarize, emit. ──

const toMemories = (contents: readonly string[]): Memory[] =>
  contents.map((content) => ({ content }));

type ProbeContext = {
  dataPath: string;
  captureRun: string;
  captureDir: string;
  results: Record<string, Array<{ query: string; context: string }>>;
  eligible: ReadonlySet<string>;
  manifest: ReturnType<typeof buildEligibilityManifest>;
  multiHop: BenchmarkCase[];
  regression: BenchmarkCase[];
  conversationBySample: Map<string, Conversation>;
  fileKeyBySample: Map<string, string>;
};

/** Phase 1 — load dataset, pin the frozen eligible manifest, read the
 * baseline capture, index conversations and file keys. */
function loadInputs(): ProbeContext {
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
  pinEligibleManifest(root, manifest);
  const eligible = new Set(manifest.eligibleIds);
  console.error(
    `eligible questions: ${manifest.eligibleIds.length} (sha256 ${manifest.sha256.slice(0, 16)}…)`,
  );

  const captureRun = process.argv[2] ?? "locomo-retrieval-onlion-2026-10-23T08-30-01";
  const captureDir = resolve(root, "evals/locomo/results", captureRun);
  const capturePath = resolve(captureDir, "search-results.json");
  if (!existsSync(capturePath)) throw new Error(`capture not found: ${capturePath}`);
  const results = JSON.parse(readFileSync(capturePath, "utf8")) as Record<
    string,
    Array<{ query: string; context: string }>
  >;

  // Dataset row index → conversation, in first-appearance order.
  const conversationBySample = new Map<string, Conversation>();
  const fileKeyBySample = new Map<string, string>();
  for (const item of allCases) {
    const sampleId = String(item.officialMetadata.sampleId);
    if (conversationBySample.has(sampleId)) continue;
    conversationBySample.set(sampleId, buildConversation(item));
    fileKeyBySample.set(sampleId, locomoUserKey(fileKeyBySample.size));
  }

  // Scope mirrors static-multipath-recall v4: eligible multi-hop + eligible
  // deterministic regression sample (categories 2 and 4, every 8th).
  const multiHop = allCases.filter(
    (item) => Number(item.officialMetadata.category) === 1 && eligible.has(item.id),
  );
  const regression = allCases
    .filter(
      (item) => [2, 4].includes(Number(item.officialMetadata.category)) && eligible.has(item.id),
    )
    .filter((_, index) => index % 8 === 0);
  console.error(`scope: ${multiHop.length} multi-hop + ${regression.length} regression`);
  return {
    dataPath: resolve(dataPath),
    captureRun,
    captureDir,
    results,
    eligible,
    manifest,
    multiHop,
    regression,
    conversationBySample,
    fileKeyBySample,
  };
}

/** Fail fast when the recomputed eligible set drifts from the frozen file. */
function pinEligibleManifest(
  root: string,
  manifest: ReturnType<typeof buildEligibilityManifest>,
): void {
  const manifestPath = resolve(root, "evals/locomo/results/locomo-eligible-manifest.json");
  if (!existsSync(manifestPath)) return;
  const frozen = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    sha256: string;
    eligibleIds: string[];
  };
  if (frozen.sha256 !== manifest.sha256) {
    throw new Error(
      `eligible manifest drift: recomputed ${manifest.sha256} != frozen ${frozen.sha256}`,
    );
  }
}

type RowDiagnostics = {
  unmappedSegments: number;
  questionsWithUnmapped: number;
  duplicateQueryText: number;
  anchorCountSum: number;
  poolRadius2Sum: number;
  poolRadius1Sum: number;
};

/** Build one scored row (arms A/C1/C2 + budget views + raw audit trail). */
function questionRow(
  item: BenchmarkCase,
  fileKey: string,
  sampleId: string,
  entry: { context: string },
  conversation: Conversation,
  sensitivityParams: NeighborParams,
  diagnostics: RowDiagnostics,
): Record<string, unknown> {
  const armC2 = buildNeighborArm(entry.context, conversation, DEFAULT_NEIGHBOR_PARAMS);
  const armC1 = buildNeighborArm(entry.context, conversation, sensitivityParams);

  const evidenceText = evidenceTextFor(item);
  const baselineMemories = toMemories(armC2.baseline.contents);
  const c2Memories = toMemories(armC2.contents);
  const c1Memories = toMemories(armC1.contents);
  const budgetA = chars(baselineMemories);
  const budgetC2 = sliceByCharBudget(c2Memories, budgetA);
  const budgetC1 = sliceByCharBudget(c1Memories, budgetA);

  diagnostics.unmappedSegments += armC2.baseline.unmapped;
  if (armC2.baseline.unmapped > 0) diagnostics.questionsWithUnmapped += 1;
  diagnostics.anchorCountSum += armC2.anchors.length;
  diagnostics.poolRadius2Sum += armC2.pool.length;
  diagnostics.poolRadius1Sum += armC1.pool.length;

  return {
    id: item.id,
    fileKey,
    workerUserId: sampleId,
    category: item.officialMetadata.category,
    A: {
      hitPositions: hitPositions(baselineMemories, item, evidenceText),
      contextCharacters: budgetA,
    },
    C2: {
      hitPositions: hitPositions(c2Memories, item, evidenceText),
      contextCharacters: chars(c2Memories),
    },
    C1: {
      hitPositions: hitPositions(c1Memories, item, evidenceText),
      contextCharacters: chars(c1Memories),
    },
    budgetC2: {
      hitPositions: hitPositions(budgetC2, item, evidenceText),
      contextCharacters: chars(budgetC2),
    },
    budgetC1: {
      hitPositions: hitPositions(budgetC1, item, evidenceText),
      contextCharacters: chars(budgetC1),
    },
    raw: {
      A: armC2.baseline.contents,
      C2: armC2.contents,
      C1: armC1.contents,
      anchors: armC2.anchors.map((turn) => ({
        sessionIndex: turn.sessionIndex,
        turnIndex: turn.turnIndex,
        sourceId: turn.sourceId,
      })),
      poolRadius2: armC2.pool.map((turn) => ({
        sessionIndex: turn.sessionIndex,
        turnIndex: turn.turnIndex,
        sourceId: turn.sourceId,
        content: turn.ingested,
      })),
      poolRadius1: armC1.pool.map((turn) => ({
        sessionIndex: turn.sessionIndex,
        turnIndex: turn.turnIndex,
        sourceId: turn.sourceId,
        content: turn.ingested,
      })),
    },
  };
}

/** Phase 2 — walk the scope, build one row per question, track diagnostics. */
function collectRows(context: ProbeContext): {
  rows: Array<Record<string, unknown>>;
  diagnostics: Record<string, number>;
} {
  const sensitivityParams: NeighborParams = { ...DEFAULT_NEIGHBOR_PARAMS, radius: 1 };
  const rows: Array<Record<string, unknown>> = [];
  const seenQueries = new Map<string, number>();
  const diagnostics: RowDiagnostics = {
    unmappedSegments: 0,
    questionsWithUnmapped: 0,
    duplicateQueryText: 0,
    anchorCountSum: 0,
    poolRadius2Sum: 0,
    poolRadius1Sum: 0,
  };
  let missingContext = 0;

  for (const item of [...context.multiHop, ...context.regression]) {
    const sampleId = String(item.officialMetadata.sampleId);
    const fileKey = context.fileKeyBySample.get(sampleId);
    const conversation = context.conversationBySample.get(sampleId);
    if (!fileKey || !conversation) throw new Error(`missing conversation for sample ${sampleId}`);
    const entry = context.results[fileKey]?.find((candidate) => candidate.query === item.question);
    if (!entry) {
      missingContext += 1;
      rows.push({ id: item.id, fileKey, workerUserId: sampleId, error: "missing capture context" });
      continue;
    }
    const queryKey = `${fileKey}\u0000${item.question}`;
    const queryCount = (seenQueries.get(queryKey) ?? 0) + 1;
    seenQueries.set(queryKey, queryCount);
    if (queryCount > 1) diagnostics.duplicateQueryText += 1;
    rows.push(
      questionRow(item, fileKey, sampleId, entry, conversation, sensitivityParams, diagnostics),
    );
  }

  const scored = rows.length - missingContext;
  return {
    rows,
    diagnostics: {
      ...diagnostics,
      missingContext,
      anchorCountMean: scored > 0 ? +(diagnostics.anchorCountSum / scored).toFixed(2) : 0,
      poolRadius2Mean: scored > 0 ? +(diagnostics.poolRadius2Sum / scored).toFixed(2) : 0,
      poolRadius1Mean: scored > 0 ? +(diagnostics.poolRadius1Sum / scored).toFixed(2) : 0,
    },
  };
}

const ARM_KEYS = ["A", "C2", "C1", "budgetC2", "budgetC1"] as const;

/** Phase 3 — frozen-contract scoring on the shared eligible denominator. */
function summarizeRows(
  rows: readonly Record<string, unknown>[],
  ids: ReadonlySet<string>,
  eligible: ReadonlySet<string>,
): Record<string, unknown> {
  const subset = rows.filter((row) => ids.has(String(row.id)) && !row.error);
  const coverageByArm: Record<string, unknown> = {};
  for (const key of ARM_KEYS) coverageByArm[key] = coverage(subset, key);
  return {
    coverage: coverageByArm,
    paired: {
      C2: pairedComparison(subset, "A", "C2", eligible),
      C1: pairedComparison(subset, "A", "C1", eligible),
      budgetC2: pairedComparison(subset, "A", "budgetC2", eligible),
      budgetC1: pairedComparison(subset, "A", "budgetC1", eligible),
    },
  };
}

// ── Main: orchestrate the four phases. ──
function main(): void {
  const context = loadInputs();
  const { rows, diagnostics } = collectRows(context);
  const summary = {
    runId: new Date().toISOString().replaceAll(":", "-").slice(0, 19),
    source: {
      dataPath: context.dataPath,
      captureDir: context.captureDir,
      captureRun: context.captureRun,
    },
    mechanism: "session-adjacency expansion (offline, zero LLM)",
    params: {
      primary: DEFAULT_NEIGHBOR_PARAMS,
      sensitivity: { ...DEFAULT_NEIGHBOR_PARAMS, radius: 1 } satisfies NeighborParams,
    },
    manifest: { sha256: context.manifest.sha256, eligible: context.manifest.eligibleIds.length },
    scope: {
      multiHop: context.multiHop.length,
      regression: context.regression.length,
      rows: rows.length,
    },
    multiHop: summarizeRows(
      rows,
      new Set(context.multiHop.map((item) => item.id)),
      context.eligible,
    ),
    regression: summarizeRows(
      rows,
      new Set(context.regression.map((item) => item.id)),
      context.eligible,
    ),
    diagnostics,
  };

  const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
  const outputDirectory = resolve(root, "evals/locomo/results", `static-neighbor-${summary.runId}`);
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    resolve(outputDirectory, "neighbor-rows.jsonl"),
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
