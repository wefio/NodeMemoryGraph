import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditNaturalMaintenance } from "../../evals/natural-maintenance/audit.ts";
import { NmgStore } from "../../src/core/store.ts";
import { consolidateStgMemoryToLtg, retractStgConsolidation } from "../../src/core/stg.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

test("natural maintenance audit reads claim, consolidation, and topology evidence without mutation", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-natural-maintenance-"));
  const ltgPath = join(directory, "ltg.sqlite");
  const stgPath = join(directory, "stg.sqlite");
  const ltg = new NmgStore(ltgPath);
  const stg = new NmgStore(stgPath);
  let stgMemoryId = "";
  let retractedStgMemoryId = "";
  let retractedLtgMemoryId = "";
  let manualLtgMemoryId = "";
  const productionAssessments = new Map<
    string,
    { eligible: boolean; reasons: string[]; targetName: string | null }
  >();
  try {
    const local = stg.remember({
      statement: "Atlas stores durable metadata in SQLite.",
      nodeName: "Atlas storage",
      confidence: 0.9,
      scope: { project: "atlas" },
      residence: "stg",
      sessionId: "session-natural",
      claims: [
        {
          text: "Atlas stores durable metadata in SQLite.",
          polarity: "affirmative",
          predicateKey: "atlas.storage",
          confidence: 0.9,
          extractMethod: "llm",
        },
      ],
    });
    stgMemoryId = local.memory.id;
    for (let index = 1; index <= 3; index += 1) {
      stg.recordClaimOutcomes({
        semanticTaskId: `natural-task-${index}`,
        collectionOrigin: "natural",
        votes: [
          {
            memoryId: local.memory.id,
            claimIndexes: [0],
            outcome: "supported",
            source: "task",
            sourceLineage: `natural-source-${index}`,
          },
        ],
      });
    }
    stg.recordClaimOutcomes({
      semanticTaskId: "controlled-smoke",
      collectionOrigin: "controlled",
      votes: [
        {
          memoryId: local.memory.id,
          claimIndexes: [0],
          outcome: "supported",
          source: "task",
          sourceLineage: "controlled-source",
        },
      ],
    });
    const activeMaterialization = consolidateStgMemoryToLtg(
      stg,
      ltg,
      local.memory.id,
      "session-natural",
    );
    assert.equal(
      consolidateStgMemoryToLtg(stg, ltg, local.memory.id, "session-natural").memory.id,
      activeMaterialization.memory.id,
      "repeated materialization is idempotent",
    );
    const retractable = stg.remember({
      statement: "Atlas previously mirrored temporary metadata in JSON.",
      nodeName: "Atlas temporary storage",
      scope: { project: "atlas" },
      residence: "stg",
      sessionId: "session-natural",
      sourceActor: "user",
    });
    retractedStgMemoryId = retractable.memory.id;
    const materialized = consolidateStgMemoryToLtg(
      stg,
      ltg,
      retractable.memory.id,
      "session-natural",
    );
    retractedLtgMemoryId = materialized.memory.id;
    assert.deepEqual(retractStgConsolidation(ltg, retractable.memory.id), [materialized.memory.id]);
    assert.deepEqual(
      retractStgConsolidation(ltg, retractable.memory.id),
      [],
      "retraction is idempotent",
    );
    manualLtgMemoryId = ltg.remember({
      statement: "Atlas previously mirrored temporary metadata in JSON.",
      nodeName: "Atlas manual storage note",
      scope: { project: "atlas", source: "manual" },
      residence: "ltg",
      sourceActor: "user",
    }).memory.id;

    const left = [0, 1, 2].map((index) =>
      ltg.remember({
        statement: `Sam identity evidence A${index}`,
        nodeName: "Sam A",
        scope: { person: "sam" },
        sourceActor: "user",
      }),
    );
    const right = [0, 1, 2].map((index) =>
      ltg.remember({
        statement: `Sam identity evidence B${index}`,
        nodeName: "Sam B",
        scope: { person: "sam" },
        sourceActor: "user",
      }),
    );
    let eligibleProposal: ReturnType<NmgStore["proposeSemanticRelation"]> | undefined;
    for (let index = 0; index < 5; index += 1) {
      eligibleProposal = ltg.proposeSemanticRelation({
        sourceNodeId: left[0]!.node.id,
        targetNodeId: right[0]!.node.id,
        relationType: "same_as",
        evidenceMemoryIds: [left[index % 3]!.memory.id, right[index % 3]!.memory.id],
        confidence: 0.99,
      });
    }
    const mismatchedLeft = [0, 1].map((index) =>
      ltg.remember({
        statement: `Robin user identity evidence ${index}`,
        nodeName: "Robin user source",
        scope: { person: "robin" },
        sourceActor: "user",
      }),
    );
    const mismatchedRight = [0, 1].map((index) =>
      ltg.remember({
        statement: `Robin tool identity evidence ${index}`,
        nodeName: "Robin tool source",
        scope: { person: "robin" },
        sourceActor: "tool",
      }),
    );
    let mismatchedProposal: ReturnType<NmgStore["proposeSemanticRelation"]> | undefined;
    for (let index = 0; index < 5; index += 1) {
      mismatchedProposal = ltg.proposeSemanticRelation({
        sourceNodeId: mismatchedLeft[0]!.node.id,
        targetNodeId: mismatchedRight[0]!.node.id,
        relationType: "same_as",
        evidenceMemoryIds: [
          mismatchedLeft[index % 2]!.memory.id,
          mismatchedRight[index % 2]!.memory.id,
        ],
        confidence: 0.99,
      });
    }
    const untrustedLeft = [0, 1].map((index) =>
      ltg.remember({
        statement: `Taylor assistant identity evidence A${index}`,
        nodeName: "Taylor assistant A",
        scope: { person: "taylor" },
        sourceActor: "assistant",
      }),
    );
    const untrustedRight = [0, 1].map((index) =>
      ltg.remember({
        statement: `Taylor assistant identity evidence B${index}`,
        nodeName: "Taylor assistant B",
        scope: { person: "taylor" },
        sourceActor: "assistant",
      }),
    );
    let untrustedProposal: ReturnType<NmgStore["proposeSemanticRelation"]> | undefined;
    for (let index = 0; index < 5; index += 1) {
      untrustedProposal = ltg.proposeSemanticRelation({
        sourceNodeId: untrustedLeft[0]!.node.id,
        targetNodeId: untrustedRight[0]!.node.id,
        relationType: "same_as",
        evidenceMemoryIds: [
          untrustedLeft[index % 2]!.memory.id,
          untrustedRight[index % 2]!.memory.id,
        ],
        confidence: 0.99,
      });
    }
    for (const proposal of [eligibleProposal!, mismatchedProposal!, untrustedProposal!]) {
      const assessment = ltg.assessAutomaticMergeProposal(proposal.id);
      productionAssessments.set(proposal.id, {
        eligible: assessment.eligible,
        reasons: assessment.reasons,
        targetName: assessment.targetName,
      });
    }
  } finally {
    stg.close();
    ltg.close();
  }

  try {
    const ltgBefore = statSync(ltgPath);
    const stgBefore = statSync(stgPath);
    const report = auditNaturalMaintenance({
      ltgPath,
      stgPaths: [stgPath],
      environment: { NMG_MAINTENANCE_WRITE_THRESHOLD: "64" },
      generatedAt: "2026-08-20T00:00:00.000Z",
    });

    assert.equal(report.readOnly, true);
    assert.equal(report.stg[0]?.claims.outcomeEvents, 4);
    assert.equal(report.stg[0]?.claims.semanticTasks, 4);
    assert.deepEqual(report.stg[0]?.claims.outcomeEventsByOrigin, { controlled: 1, natural: 3 });
    assert.equal(report.stg[0]?.claims.naturalOutcomeEvents, 3);
    assert.equal(report.stg[0]?.claims.naturalSemanticTasks, 3);
    assert.deepEqual(report.stg[0]?.claims.promotionCandidates, [stgMemoryId]);
    assert.equal(report.ltg.consolidatedFromStg[0]?.sourceMemoryId, stgMemoryId);
    assert.deepEqual(report.ltg.stgConsolidation.byStatus, { active: 1, deleted: 1 });
    assert.equal(report.ltg.stgConsolidation.total, 2);
    assert.equal(report.ltg.stgConsolidation.active, 1);
    assert.equal(report.ltg.stgConsolidation.retracted, 1);
    assert.deepEqual(report.ltg.stgConsolidation.duplicateActiveSourceMemoryIds, []);
    assert.ok(
      report.ltg.stgConsolidation.materializations.some(
        (item) =>
          item.memoryId === retractedLtgMemoryId &&
          item.sourceMemoryId === retractedStgMemoryId &&
          item.status === "deleted",
      ),
    );
    assert.equal(
      report.ltg.stgConsolidation.materializations.some((item) => item.memoryId === manualLtgMemoryId),
      false,
      "a manual LTG row without the source marker is not a materialization",
    );
    assert.equal(report.evidenceGaps.includes("no_stg_consolidation_retractions"), false);
    assert.equal(report.ltg.topology.proposalsByRelation.same_as, 3);
    assert.equal(report.ltg.topology.pendingAutomaticMergeAssessments.length, 3);
    for (const actual of report.ltg.topology.pendingAutomaticMergeAssessments) {
      const expected = productionAssessments.get(actual.proposalId);
      assert.ok(expected, `production assessment exists for ${actual.proposalId}`);
      assert.equal(actual.eligible, expected.eligible);
      assert.deepEqual(actual.reasons, expected.reasons);
      assert.equal(actual.targetName, expected.targetName);
    }
    assert.ok(
      report.ltg.topology.pendingAutomaticMergeAssessments.some((assessment) =>
        assessment.reasons.includes("source_actor_mismatch_across_nodes"),
      ),
    );
    assert.ok(
      report.ltg.topology.pendingAutomaticMergeAssessments.some((assessment) =>
        assessment.reasons.includes("untrusted_evidence_actor"),
      ),
    );
    assert.equal(report.ltg.maintenanceBacklog.distributedWritePressure, false);
    assert.equal(report.policy.maintenance.writeThreshold, 64);
    assert.equal(report.evidenceGaps.includes("no_stg_claim_outcomes"), false);
    assert.equal(statSync(ltgPath).size, ltgBefore.size);
    assert.equal(statSync(ltgPath).mtimeMs, ltgBefore.mtimeMs);
    assert.equal(statSync(stgPath).size, stgBefore.size);
    assert.equal(statSync(stgPath).mtimeMs, stgBefore.mtimeMs);
  } finally {
    removeTempDirectory(directory);
  }
});

test("natural maintenance audit reports a missing store without creating it", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-natural-maintenance-missing-"));
  const missing = join(directory, "missing.sqlite");
  try {
    const report = auditNaturalMaintenance({
      ltgPath: missing,
      stgPaths: [join(directory, "missing-stg.sqlite")],
      environment: {},
    });
    assert.equal(report.ltg.exists, false);
    assert.equal(report.stg[0]?.exists, false);
    assert.equal(existsSync(missing), false);
  } finally {
    removeTempDirectory(directory);
  }
});
