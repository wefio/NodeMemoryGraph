import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { NmgStore } from "../../src/core/store.ts";
import type { MemoryRecord, TopologyAutomationAssessment } from "../../src/core/types.ts";
import { cosineSimilarity, HashingVectorEmbedder } from "../../src/core/vector.ts";
import { loadLocomo } from "../benchmarks/loaders.ts";
import type { BenchmarkCase, BenchmarkSession, BenchmarkTurn } from "../benchmarks/types.ts";

export interface TopologyGateReport {
  benchmark: "LoCoMo";
  supervision: string;
  conversations: number;
  identityCandidates: number;
  crossPersonCandidates: number;
  eligibleIdentityCandidates: number;
  eligibleCrossPersonCandidates: number;
  identityRecall: number;
  crossPersonRejectionRate: number;
  conflictWithdrawalRate: number;
  discoveredCandidates: number;
  discoveredTrueCandidates: number;
  discoveredFalseCandidates: number;
  candidateDiscoveryRecall: number;
  candidateDiscoveryPrecision: number;
  naturalFalseMergeProbe: {
    attempted: number;
    rolledBack: number;
    foreignRecordsCoLocated: number;
  };
  topologyMutations: number;
  reasonCounts: Record<string, number>;
  limitations: string[];
}

export interface PersonFragments {
  speaker: string;
  early: MemoryRecord[];
  late: MemoryRecord[];
}

/**
 * Evaluate the conservative identity gate, not identity-candidate generation.
 * LoCoMo supplies stable speaker labels across sessions. We deliberately split
 * each labelled person into early/late nodes (positive candidates) and pair the
 * two different speakers in a conversation (negative candidates).
 */
export function auditTopologyGate(cases: readonly BenchmarkCase[]): TopologyGateReport {
  const unique = uniqueConversations(cases);
  const reasonCounts: Record<string, number> = {};
  let identityCandidates = 0;
  let crossPersonCandidates = 0;
  let eligibleIdentityCandidates = 0;
  let eligibleCrossPersonCandidates = 0;
  let conflictChecks = 0;
  let conflictWithdrawals = 0;
  let topologyMutations = 0;
  let discoverableIdentities = 0;
  let discoveredCandidates = 0;
  let discoveredTrueCandidates = 0;
  let naturalFalseMergesAttempted = 0;
  let naturalFalseMergesRolledBack = 0;
  let foreignRecordsCoLocated = 0;

  for (const item of unique) {
    const directory = mkdtempSync(join(tmpdir(), "nmg-topology-eval-"));
    const store = new NmgStore(join(directory, "nmg.sqlite"));
    try {
      const sampleId = String(item.officialMetadata.sampleId ?? item.id);
      const people = buildPersonFragments(store, sampleId, item.sessions);
      const discovered = discoverSpeakerCandidates(people);
      discoverableIdentities += people.length;
      discoveredCandidates += discovered.length;
      discoveredTrueCandidates += discovered.filter((candidate) => candidate.sameSpeaker).length;
      for (const person of people) {
        identityCandidates += 1;
        const proposalId = repeatedProposal(store, person.early, person.late, "same_as");
        const initial = store.assessAutomaticMergeProposal(proposalId);
        countReasons(reasonCounts, initial);
        if (initial.eligible) eligibleIdentityCandidates += 1;

        // A later explicit identity conflict must withdraw eligibility without
        // mutating either node. This is the reversible part of the proposal gate.
        repeatedProposal(store, person.early, person.late, "distinct_from", 1);
        const conflicted = store.assessAutomaticMergeProposal(proposalId);
        conflictChecks += 1;
        if (!conflicted.eligible && conflicted.reasons.includes("competing_conflict_proposal")) {
          conflictWithdrawals += 1;
        }
      }

      if (people.length >= 2) {
        crossPersonCandidates += 1;
        const proposalId = repeatedProposal(store, people[0]!.early, people[1]!.late, "same_as");
        const assessment = store.assessAutomaticMergeProposal(proposalId);
        countReasons(reasonCounts, assessment);
        if (assessment.eligible) eligibleCrossPersonCandidates += 1;
      }

      for (const [index, candidate] of discovered.filter(
        (item) => !item.sameSpeaker,
      ).entries()) {
        const early = people.find((person) => person.speaker === candidate.earlySpeaker)!;
        const late = people.find((person) => person.speaker === candidate.lateSpeaker)!;
        naturalFalseMergesAttempted += 1;
        const transform = store.mergeNodes({
          sourceNodeIds: [early.early[0]!.nodeId, late.late[0]!.nodeId],
          targetName: `${sampleId}:false-merge-probe:${index}`,
        });
        const targetNodeId = transform.targetNodeIds[0]!;
        foreignRecordsCoLocated += late.late.filter(
          (memory) => store.getMemory(memory.id)?.nodeId === targetNodeId,
        ).length;
        const rolledBack = store.rollbackNodeTransform(transform.id);
        if (rolledBack.rolledBackAt) naturalFalseMergesRolledBack += 1;
      }

      const allNodeIds = people.flatMap((person) => [
        person.early[0]!.nodeId,
        person.late[0]!.nodeId,
      ]);
      topologyMutations += store.getRelations(allNodeIds).length;
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }

  return {
    benchmark: "LoCoMo",
    supervision:
      "official speaker identity scores a content-only discovery arm and an injected gate arm",
    conversations: unique.length,
    identityCandidates,
    crossPersonCandidates,
    eligibleIdentityCandidates,
    eligibleCrossPersonCandidates,
    identityRecall: ratio(eligibleIdentityCandidates, identityCandidates),
    crossPersonRejectionRate: ratio(
      crossPersonCandidates - eligibleCrossPersonCandidates,
      crossPersonCandidates,
    ),
    conflictWithdrawalRate: ratio(conflictWithdrawals, conflictChecks),
    discoveredCandidates,
    discoveredTrueCandidates,
    discoveredFalseCandidates: discoveredCandidates - discoveredTrueCandidates,
    candidateDiscoveryRecall: ratio(discoveredTrueCandidates, discoverableIdentities),
    candidateDiscoveryPrecision: ratio(discoveredTrueCandidates, discoveredCandidates),
    naturalFalseMergeProbe: {
      attempted: naturalFalseMergesAttempted,
      rolledBack: naturalFalseMergesRolledBack,
      foreignRecordsCoLocated,
    },
    topologyMutations,
    reasonCounts,
    limitations: [
      "The gate is still evaluated after labelled candidate injection; the separate discovery probe uses only fragment content and chooses one late-fragment candidate per early fragment.",
      "LoCoMo speaker labels provide identity supervision but not aliases, homonyms, or real correction events.",
      "The gate remains read-only; an automatic merge actuator is intentionally not enabled.",
      "The natural false-merge probe measures structural cross-person co-location and rollback, not downstream answer accuracy.",
    ],
  };
}

export interface DiscoveredSpeakerCandidate {
  earlySpeaker: string;
  lateSpeaker: string;
  score: number;
  sameSpeaker: boolean;
}

/**
 * Non-oracle natural-data candidate generation. Speaker labels are used only
 * after ranking to score the result; embeddings see conversation content, not
 * node names, scope, or the official identity label.
 */
export function discoverSpeakerCandidates(
  people: readonly PersonFragments[],
): DiscoveredSpeakerCandidate[] {
  const embedder = new HashingVectorEmbedder();
  const late = people.map((person) => ({
    speaker: person.speaker,
    vector: embedder.embed(person.late.map((memory) => memory.statement).join("\n")),
  }));
  return people.flatMap((person) => {
    const query = embedder.embed(person.early.map((memory) => memory.statement).join("\n"));
    const best = late
      .map((candidate) => ({
        ...candidate,
        score: cosineSimilarity(query, candidate.vector),
      }))
      .sort((left, right) => right.score - left.score)[0];
    return best
      ? [
          {
            earlySpeaker: person.speaker,
            lateSpeaker: best.speaker,
            score: best.score,
            sameSpeaker: person.speaker === best.speaker,
          },
        ]
      : [];
  });
}

function uniqueConversations(cases: readonly BenchmarkCase[]): BenchmarkCase[] {
  const bySample = new Map<string, BenchmarkCase>();
  for (const item of cases) {
    const sampleId = String(item.officialMetadata.sampleId ?? item.id);
    if (!bySample.has(sampleId)) bySample.set(sampleId, item);
  }
  return [...bySample.values()];
}

function buildPersonFragments(
  store: NmgStore,
  sampleId: string,
  sessions: readonly BenchmarkSession[],
): PersonFragments[] {
  const speakers = [...new Set(sessions.flatMap((session) =>
    session.turns.map((turn) => turn.speaker).filter((speaker): speaker is string => Boolean(speaker))
  ))];
  return speakers.flatMap((speaker) => {
    const midpoint = Math.max(1, Math.floor(sessions.length / 2));
    const earlyTurns = turnsForSpeaker(sessions.slice(0, midpoint), speaker).slice(0, 3);
    const lateTurns = turnsForSpeaker(sessions.slice(midpoint), speaker).slice(0, 3);
    if (earlyTurns.length < 2 || lateTurns.length < 2) return [];
    // One scoped identity dimension is deliberate: the conversation prefix
    // prevents same-name speakers in different samples from sharing identity.
    const scope = { person: `${sampleId}:${speaker}` };
    return [{
      speaker,
      early: earlyTurns.map((turn, index) => store.remember({
        statement: turn.content,
        nodeName: `${sampleId}:${speaker}:early`,
        scope,
        sourceRef: turn.sourceId ?? `${sampleId}:${speaker}:early:${index}`,
      }).memory),
      late: lateTurns.map((turn, index) => store.remember({
        statement: turn.content,
        nodeName: `${sampleId}:${speaker}:late`,
        scope,
        sourceRef: turn.sourceId ?? `${sampleId}:${speaker}:late:${index}`,
      }).memory),
    }];
  });
}

function turnsForSpeaker(sessions: readonly BenchmarkSession[], speaker: string): BenchmarkTurn[] {
  return sessions.flatMap((session) => session.turns.filter((turn) => turn.speaker === speaker));
}

function repeatedProposal(
  store: NmgStore,
  left: readonly MemoryRecord[],
  right: readonly MemoryRecord[],
  relationType: "same_as" | "distinct_from",
  observations = 5,
): string {
  let proposalId = "";
  for (let index = 0; index < observations; index += 1) {
    const proposal = store.proposeSemanticRelation({
      sourceNodeId: left[0]!.nodeId,
      targetNodeId: right[0]!.nodeId,
      relationType,
      evidenceMemoryIds: [left[index % left.length]!.id, right[index % right.length]!.id],
      confidence: 0.99,
    });
    proposalId = proposal.id;
  }
  return proposalId;
}

function countReasons(counts: Record<string, number>, assessment: TopologyAutomationAssessment): void {
  for (const reason of assessment.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function resolveDataPath(): string {
  const candidates = [
    process.env.NMG_LOCOMO_DATA,
    resolve("evals/locomo/data/locomo10.json"),
    resolve(".benchmarks/official/LoCoMo/data/locomo10.json"),
    resolve(".benchmarks/official/OmniMemEval/data/locomo/locomo10.json"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`LoCoMo data not found; checked: ${candidates.join(", ")}`);
  return found;
}

function main(): void {
  const report = auditTopologyGate(loadLocomo(resolveDataPath()));
  const output = process.env.NMG_TOPOLOGY_REPORT
    ? resolve(process.env.NMG_TOPOLOGY_REPORT)
    : resolve("evals/topology/results/latest.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output, ...report }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
