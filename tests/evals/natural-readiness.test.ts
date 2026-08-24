import assert from "node:assert/strict";
import test from "node:test";

import { buildNaturalReadinessPacket } from "../../evals/natural-readiness/report.ts";
import type { ShadowDatasetSummary } from "../../evals/controller-shadow/dataset.ts";
import type { ShadowCoverageReport } from "../../evals/controller-shadow/report.ts";
import type { NaturalMaintenanceAudit } from "../../evals/natural-maintenance/audit.ts";

test("natural readiness fails closed and tells the Agent what evidence is missing", () => {
  const packet = buildNaturalReadinessPacket({
    coverage: coverage(),
    dataset: dataset(["2 labelled graph(s) lack verified claim attribution"]),
    maintenance: maintenance([
      "no_stg_claim_outcomes",
      "no_identity_merge_proposals",
      "no_topology_rollbacks",
    ]),
    generatedAt: "2026-08-24T00:00:00.000Z",
  });

  assert.equal(packet.controller.canCreateCandidate, false);
  assert.equal(packet.controller.canPromote, false);
  assert.equal(packet.maintenance.stgToLtgValidated, false);
  assert.equal(packet.maintenance.automaticMergeValidated, false);
  assert.deepEqual(
    packet.actions.map((action) => action.id),
    [
      "collect_verified_controller_evidence",
      "collect_stg_consolidation_evidence",
      "collect_identity_merge_evidence",
    ],
  );
});

test("natural readiness permits candidate creation but never infers promotion", () => {
  const packet = buildNaturalReadinessPacket({
    coverage: coverage(),
    dataset: dataset([]),
    maintenance: maintenance([]),
  });

  assert.equal(packet.controller.canCreateCandidate, true);
  assert.equal(packet.controller.canPromote, false);
  assert.equal(packet.maintenance.stgToLtgValidated, true);
  assert.equal(packet.maintenance.automaticMergeValidated, true);
  assert.equal(packet.actions[0]?.id, "create_controller_candidate");
  assert.equal(packet.actions[0]?.state, "available");
  assert.equal(packet.actions[1]?.id, "promote_controller_candidate");
  assert.equal(packet.actions[1]?.state, "blocked");
});

function dataset(blockers: string[]): ShadowDatasetSummary {
  return {
    rows: 2,
    rowsBySplit: { train: 1, validation: 1 },
    tasks: { total: 2, train: 1, validation: 1 },
    excludedGraphs: 0,
    legacyGraphsWithoutReplayInputs: 0,
    graphsWithoutVerifiedAttribution: blockers.length > 0 ? 2 : 0,
    blockers,
  };
}

function coverage(): ShadowCoverageReport {
  return {
    events: 2,
    retrievals: 2,
    legacyUses: 0,
    disclosures: 2,
    attributions: 2,
    diagnosticAttributions: 0,
    verifiedAttributions: 2,
    outcomes: 2,
    feedback: 2,
    toolFlow: 0,
    searchSuppressed: 0,
    feedbackNudgesShown: 0,
    claimOutcomeNudgesShown: 0,
    graphs: 2,
    queryTasks: 2,
    semanticTasks: 2,
    timeRange: { first: null, last: null },
    origins: { automatic: 0, tool: 2 },
    injection: { characters: 0, estimatedTokens: 0 },
    labels: {
      taskSuccess: 2,
      userCorrection: 0,
      evidenceSufficient: 2,
      expansionUseful: 2,
      excessiveNoise: 2,
      noMemoryNeeded: 2,
    },
    fullyLabelledGraphsByOrigin: { natural: 2, controlled: 0, legacy: 0 },
    fullyLabelledGraphs: 2,
    calibrationReady: false,
    blockers: ["candidate promotion requires a held-out time/task split and matched shadow result"],
  };
}

function maintenance(evidenceGaps: string[]): NaturalMaintenanceAudit {
  return {
    generatedAt: "2026-08-24T00:00:00.000Z",
    readOnly: true,
    policy: {} as NaturalMaintenanceAudit["policy"],
    ltg: {} as NaturalMaintenanceAudit["ltg"],
    stg: [],
    evidenceGaps,
  };
}
