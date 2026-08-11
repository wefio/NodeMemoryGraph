import assert from "node:assert/strict";
import test from "node:test";

import { auditTopologyGate } from "../../../evals/topology/run.ts";
import type { BenchmarkCase } from "../../../evals/benchmarks/types.ts";

test("topology audit accepts same-person fragments, rejects cross-person pairs, and stays read-only", () => {
  const report = auditTopologyGate([fixture()]);
  assert.equal(report.conversations, 1);
  assert.equal(report.identityCandidates, 2);
  assert.equal(report.eligibleIdentityCandidates, 2);
  assert.equal(report.crossPersonCandidates, 1);
  assert.equal(report.eligibleCrossPersonCandidates, 0);
  assert.equal(report.identityRecall, 1);
  assert.equal(report.crossPersonRejectionRate, 1);
  assert.equal(report.conflictWithdrawalRate, 1);
  assert.equal(report.discoveredCandidates, 2);
  assert.equal(report.discoveredTrueCandidates, 2);
  assert.equal(report.discoveredFalseCandidates, 0);
  assert.equal(report.candidateDiscoveryRecall, 1);
  assert.equal(report.candidateDiscoveryPrecision, 1);
  assert.deepEqual(report.naturalFalseMergeProbe, {
    attempted: 0,
    rolledBack: 0,
    foreignRecordsCoLocated: 0,
  });
  assert.equal(report.topologyMutations, 0);
  assert.equal(report.reasonCounts.scope_mismatch, 1);
});

function fixture(): BenchmarkCase {
  const sessions = Array.from({ length: 4 }, (_, sessionIndex) => ({
    id: `session_${sessionIndex + 1}`,
    turns: ["Alex", "Blair"].flatMap((speaker) => [0, 1].map((turnIndex) => ({
      role: speaker === "Alex" ? "user" as const : "assistant" as const,
      speaker,
      content: `${speaker === "Alex" ? "amber hiking" : "cobalt cooking"} detail ${sessionIndex}-${turnIndex}`,
      sourceId: `${speaker}-${sessionIndex}-${turnIndex}`,
    }))),
  }));
  return {
    id: "q-1",
    benchmark: "LoCoMo",
    category: "1",
    question: "fixture",
    reference: "fixture",
    evidenceIds: [],
    officialMetadata: { sampleId: "sample-1" },
    sessions,
  };
}
