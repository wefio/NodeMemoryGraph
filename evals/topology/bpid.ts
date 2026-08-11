import { createReadStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { NmgStore } from "../../src/core/store.ts";

export interface BpidProfile {
  fullname: string;
  email: string[];
  phone: string[];
  addr: string[];
  dob: string;
}

export interface BpidPair {
  profile1: BpidProfile;
  profile2: BpidProfile;
  match: "True" | "False";
}

export interface IdentityCandidateFeatures {
  name: number;
  email: number;
  phone: number;
  address: number;
  dateOfBirth: number;
  score: number;
}

export interface CandidateThresholdPoint {
  threshold: number;
  candidates: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  recall: number;
  precision: number;
  reductionRatio: number;
}

export interface BpidTopologyReport {
  benchmark: "BPID";
  source: string;
  rows: number;
  positives: number;
  negatives: number;
  thresholds: CandidateThresholdPoint[];
  conservativeGate: CandidateThresholdPoint;
  rollbackProbe: {
    attempted: number;
    restored: number;
    falsePositiveRollbacks: number;
  };
  limitations: string[];
}

const FIELD_WEIGHTS = {
  name: 0.45,
  email: 0.55,
  phone: 0.65,
  address: 0.35,
  dateOfBirth: 0.55,
} as const;

const THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98] as const;

/**
 * A model-free blocking score, not an identity verdict. It intentionally
 * combines several weak fields so the threshold curve can expose the
 * recall/false-candidate trade-off without tuning NMG's production gate.
 */
export function identityCandidateFeatures(
  left: BpidProfile,
  right: BpidProfile,
): IdentityCandidateFeatures {
  const features = {
    name: stringSimilarity(left.fullname, right.fullname),
    email: listSimilarity(left.email, right.email),
    phone: listSimilarity(left.phone, right.phone, digits),
    address: listSimilarity(left.addr, right.addr),
    dateOfBirth: dateSimilarity(left.dob, right.dob),
  };
  let score =
    1 -
    Object.entries(features).reduce(
      (remaining, [key, value]) =>
        remaining * (1 - FIELD_WEIGHTS[key as keyof typeof FIELD_WEIGHTS] * value),
      1,
    );
  const exactStableFields = [features.email, features.phone, features.dateOfBirth].filter(
    (value) => value === 1,
  ).length;
  if (features.name >= 0.8 && exactStableFields >= 2) score = Math.max(score, 0.99);
  return { ...features, score };
}

export function candidateCurve(
  pairs: readonly BpidPair[],
  thresholds: readonly number[] = THRESHOLDS,
): CandidateThresholdPoint[] {
  const scored = pairs.map((pair) => ({
    positive: pair.match === "True",
    score: identityCandidateFeatures(pair.profile1, pair.profile2).score,
  }));
  const positives = scored.filter((item) => item.positive).length;
  return thresholds.map((threshold) => {
    const selected = scored.filter((item) => item.score >= threshold);
    const truePositives = selected.filter((item) => item.positive).length;
    const falsePositives = selected.length - truePositives;
    return {
      threshold,
      candidates: selected.length,
      truePositives,
      falsePositives,
      falseNegatives: positives - truePositives,
      recall: ratio(truePositives, positives),
      precision: ratio(truePositives, selected.length),
      reductionRatio: 1 - ratio(selected.length, scored.length),
    };
  });
}

export async function loadBpid(path: string): Promise<BpidPair[]> {
  const rows: BpidPair[] = [];
  const input = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as BpidPair;
    if (!parsed.profile1 || !parsed.profile2 || !["True", "False"].includes(parsed.match)) {
      throw new Error("invalid BPID row");
    }
    rows.push(parsed);
  }
  return rows;
}

export function rollbackProbe(pairs: readonly BpidPair[]): BpidTopologyReport["rollbackProbe"] {
  const eligible = pairs
    .map((pair) => ({ pair, features: identityCandidateFeatures(pair.profile1, pair.profile2) }))
    .filter((item) => item.features.score >= 0.98);
  const probes = [
    ...eligible.filter((item) => item.pair.match === "True").slice(0, 3),
    ...eligible.filter((item) => item.pair.match === "False").slice(0, 3),
  ];
  let restored = 0;
  let falsePositiveRollbacks = 0;
  for (const [index, probe] of probes.entries()) {
    const directory = mkdtempSync(join(tmpdir(), "nmg-bpid-rollback-"));
    const store = new NmgStore(join(directory, "nmg.sqlite"));
    try {
      const left = rememberProfile(store, `left-${index}`, probe.pair.profile1);
      const right = rememberProfile(store, `right-${index}`, probe.pair.profile2);
      let proposalId = "";
      for (let observation = 0; observation < 5; observation += 1) {
        proposalId = store.proposeSemanticRelation({
          sourceNodeId: left.nodeId,
          targetNodeId: right.nodeId,
          relationType: "same_as",
          evidenceMemoryIds: [
            left.memoryIds[observation % left.memoryIds.length]!,
            right.memoryIds[observation % right.memoryIds.length]!,
          ],
          confidence: probe.features.score,
        }).id;
      }
      const assessment = store.assessAutomaticMergeProposal(proposalId);
      if (!assessment.eligible) continue;
      const transform = store.mergeNodes({
        sourceNodeIds: [left.nodeId, right.nodeId],
        targetName: `candidate-${index}`,
      });
      const rolledBack = store.rollbackNodeTransform(transform.id);
      const leftRestored =
        store.getContext([left.memoryIds[0]!]).results[0]?.node.id === left.nodeId;
      const rightRestored =
        store.getContext([right.memoryIds[0]!]).results[0]?.node.id === right.nodeId;
      if (rolledBack.rolledBackAt && leftRestored && rightRestored) {
        restored += 1;
        if (probe.pair.match === "False") falsePositiveRollbacks += 1;
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  return { attempted: probes.length, restored, falsePositiveRollbacks };
}

export async function auditBpid(path: string): Promise<BpidTopologyReport> {
  const pairs = await loadBpid(path);
  const thresholds = candidateCurve(pairs);
  return {
    benchmark: "BPID",
    source: resolve(path),
    rows: pairs.length,
    positives: pairs.filter((pair) => pair.match === "True").length,
    negatives: pairs.filter((pair) => pair.match === "False").length,
    thresholds,
    conservativeGate: thresholds.find((point) => point.threshold === 0.98)!,
    rollbackProbe: rollbackProbe(pairs),
    limitations: [
      "BPID profiles are synthetic and pair-labelled; this is natural candidate generation, not an online node-pair distribution.",
      "The model-free blocker is evaluated as a candidate generator only and is not wired into unattended merge actuation.",
      "Rollback probes validate recoverability, not the acceptability of automatically making and then undoing a false merge.",
    ],
  };
}

function rememberProfile(
  store: NmgStore,
  nodeName: string,
  profile: BpidProfile,
): { nodeId: string; memoryIds: string[] } {
  const node = store.upsertNode({ canonicalName: nodeName, kind: "entity" });
  const statements = [
    `Full name: ${profile.fullname || "unknown"}`,
    `Date of birth: ${profile.dob || "unknown"}`,
    `Email addresses: ${profile.email.join(", ") || "unknown"}`,
    `Phone numbers: ${profile.phone.join(", ") || "unknown"}`,
    `Addresses: ${profile.addr.join(" | ") || "unknown"}`,
  ];
  const memories = statements.map((statement) => {
    const history = store.appendHistory({ role: "explicit", content: statement });
    return store.addMemory({ nodeId: node.id, evidenceId: history.id, statement });
  });
  return {
    nodeId: node.id,
    memoryIds: memories.map((memory) => memory.id),
  };
}

function listSimilarity(
  left: readonly string[],
  right: readonly string[],
  normalize: (value: string) => string = normalized,
): number {
  let best = 0;
  for (const a of left) {
    for (const b of right) best = Math.max(best, stringSimilarity(normalize(a), normalize(b)));
  }
  return best;
}

function stringSimilarity(left: string, right: string): number {
  const a = normalized(left);
  const b = normalized(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  return Math.max(diceBigrams(a, b), tokenJaccard(left, right));
}

function dateSimilarity(left: string, right: string): number {
  const a = dateParts(left);
  const b = dateParts(right);
  if (a.length === 0 || b.length === 0) return 0;
  return ratio(a.filter((part) => b.includes(part)).length, Math.max(a.length, b.length));
}

function dateParts(value: string): string[] {
  const months: Record<string, string> = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12",
  };
  return (
    value
      .toLowerCase()
      .replace(/[a-z]+/gu, (month) => months[month.slice(0, 3)] ?? month)
      .match(/\d+/gu)
      ?.map((part) => part.padStart(2, "0")) ?? []
  );
}

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "");
}

function digits(value: string): string {
  return value.replace(/\D+/gu, "");
}

function diceBigrams(left: string, right: string): number {
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;
  const counts = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) {
    const gram = left.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const gram = right.slice(index, index + 2);
    const count = counts.get(gram) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(gram, count - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length - 2);
}

function tokenJaccard(left: string, right: string): number {
  const a = new Set(left.toLowerCase().match(/[a-z0-9]+/gu) ?? []);
  const b = new Set(right.toLowerCase().match(/[a-z0-9]+/gu) ?? []);
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / (a.size + b.size - intersection);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function defaultDataPath(): string {
  return resolve(
    process.env.NMG_BPID_DATA ?? ".benchmarks/bpid/data/data_release/matching_dataset.jsonl",
  );
}

async function main(): Promise<void> {
  const report = await auditBpid(defaultDataPath());
  const output = resolve(process.env.NMG_BPID_REPORT ?? "evals/topology/results/bpid-latest.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output, ...report }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
