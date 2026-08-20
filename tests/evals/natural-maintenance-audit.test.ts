import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditNaturalMaintenance } from "../../evals/natural-maintenance/audit.ts";
import { NmgStore } from "../../src/core/store.ts";
import { consolidateStgMemoryToLtg } from "../../src/core/stg.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

test("natural maintenance audit reads claim, consolidation, and topology evidence without mutation", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-natural-maintenance-"));
  const ltgPath = join(directory, "ltg.sqlite");
  const stgPath = join(directory, "stg.sqlite");
  const ltg = new NmgStore(ltgPath);
  const stg = new NmgStore(stgPath);
  let stgMemoryId = "";
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
    consolidateStgMemoryToLtg(stg, ltg, local.memory.id, "session-natural");

    const left = [0, 1, 2].map((index) =>
      ltg.remember({
        statement: `Sam identity evidence A${index}`,
        nodeName: "Sam A",
        scope: { person: "sam" },
      }),
    );
    const right = [0, 1, 2].map((index) =>
      ltg.remember({
        statement: `Sam identity evidence B${index}`,
        nodeName: "Sam B",
        scope: { person: "sam" },
      }),
    );
    for (let index = 0; index < 5; index += 1) {
      ltg.proposeSemanticRelation({
        sourceNodeId: left[0]!.node.id,
        targetNodeId: right[0]!.node.id,
        relationType: "same_as",
        evidenceMemoryIds: [left[index % 3]!.memory.id, right[index % 3]!.memory.id],
        confidence: 0.99,
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
      environment: {},
      generatedAt: "2026-08-20T00:00:00.000Z",
    });

    assert.equal(report.readOnly, true);
    assert.equal(report.stg[0]?.claims.outcomeEvents, 3);
    assert.equal(report.stg[0]?.claims.semanticTasks, 3);
    assert.deepEqual(report.stg[0]?.claims.promotionCandidates, [stgMemoryId]);
    assert.equal(report.ltg.consolidatedFromStg[0]?.sourceMemoryId, stgMemoryId);
    assert.equal(report.ltg.topology.proposalsByRelation.same_as, 1);
    assert.equal(report.ltg.topology.pendingAutomaticMergeAssessments.length, 1);
    assert.equal(report.ltg.topology.pendingAutomaticMergeAssessments[0]?.eligible, true);
    assert.equal(report.ltg.maintenanceBacklog.distributedWritePressure, false);
    assert.equal(report.policy.maintenance.writeThreshold, 16);
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
