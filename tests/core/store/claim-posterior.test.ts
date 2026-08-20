import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../../src/core/store.ts";

test("claim posterior preserves its prior and deduplicates repeated semantic tasks", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-claim-posterior-"));
  const database = join(directory, "nmg.sqlite");
  let store = new NmgStore(database);
  try {
    const saved = store.remember({
      statement: "Atlas uses SQLite and remains offline-first.",
      nodeName: "Atlas architecture",
      confidence: 0.8,
      claims: [
        {
          text: "Atlas uses SQLite.",
          polarity: "affirmative",
          predicateKey: "atlas.database",
          confidence: 0.8,
          extractMethod: "llm",
        },
        {
          text: "Atlas remains offline-first.",
          polarity: "affirmative",
          predicateKey: "atlas.offline_first",
          confidence: 0.7,
          extractMethod: "llm",
        },
      ],
    });
    const rankingBefore = store
      .searchContext("Atlas SQLite offline", { limit: 5, persistTrace: false })
      .results.map((result) => result.memory.id);

    const first = store.recordClaimOutcomes({
      semanticTaskId: "task-atlas-db-1",
      votes: [
        {
          memoryId: saved.memory.id,
          claimIndexes: [0],
          outcome: "supported",
          source: "tool",
          sourceLineage: "sqlite-inspection-1",
          evidenceSource: {
            actor: "tool",
            content: "The inspected Atlas database reports SQLite.",
            sessionId: "session-atlas-db",
            sourceMessageId: "sqlite-inspection-1",
            sourceRef: "tool:sqlite-inspection",
          },
        },
      ],
    });
    assert.equal(first.events.length, 1);
    assert.ok(first.events[0]?.evidenceId);
    assert.deepEqual(store.getHistoryBySourceMessage("session-atlas-db", "sqlite-inspection-1"), {
      id: first.events[0]?.evidenceId,
      sessionId: "session-atlas-db",
      sourceMessageId: "sqlite-inspection-1",
      role: "tool",
      content: "The inspected Atlas database reports SQLite.",
      sourceRef: "tool:sqlite-inspection",
      createdAt: store.getHistoryBySourceMessage("session-atlas-db", "sqlite-inspection-1")
        ?.createdAt,
    });
    assert.equal(first.posteriors[0]?.priorConfidence, 0.8);
    assert.equal(first.posteriors[0]?.independentVoteCount, 1);
    assert.ok(first.posteriors[0]!.mean > 0.7);

    const duplicateTask = store.recordClaimOutcomes({
      semanticTaskId: "task-atlas-db-1",
      votes: [
        {
          memoryId: saved.memory.id,
          claimIndexes: [0],
          outcome: "supported",
          source: "user",
          sourceLineage: "same-task-repeated-turn",
        },
      ],
    });
    assert.deepEqual(duplicateTask.events, []);
    assert.deepEqual(duplicateTask.posteriors, []);

    store.recordClaimOutcomes({
      semanticTaskId: "task-atlas-db-2",
      votes: [
        {
          memoryId: saved.memory.id,
          claimIndexes: [0],
          outcome: "contradicted",
          source: "user",
          sourceLineage: "user-correction-2",
          weight: 0.5,
        },
      ],
    });
    const posterior = store.claimPosteriors(saved.memory.id)[0]!;
    assert.equal(posterior.independentVoteCount, 2);
    const events = store.claimOutcomeEvents(saved.memory.id);
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((event) => [
        event.semanticTaskId,
        event.source,
        event.sourceLineage,
        event.evidenceId,
        event.outcome,
      ]),
      [
        [
          "task-atlas-db-1",
          "tool",
          "sqlite-inspection-1",
          first.events[0]?.evidenceId,
          "supported",
        ],
        ["task-atlas-db-2", "user", "user-correction-2", null, "contradicted"],
      ],
      "posterior evidence remains attributable and auditable",
    );
    assert.ok(posterior.conservativeLowerBound >= 0 && posterior.conservativeLowerBound <= 1);
    assert.equal(store.getMemory(saved.memory.id)?.status, "active");
    assert.deepEqual(
      store
        .searchContext("Atlas SQLite offline", { limit: 5, persistTrace: false })
        .results.map((result) => result.memory.id),
      rankingBefore,
      "shadow posterior must neither suppress nor promote retrieval results",
    );

    store.close();
    store = new NmgStore(database);
    assert.equal(store.claimPosteriors(saved.memory.id)[0]?.independentVoteCount, 2);
    assert.equal(
      store.getMemory(saved.memory.id)?.confidence,
      0.8,
      "raw extraction prior is unchanged",
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("claim outcomes enforce Active Graph ownership and exposed-memory membership", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-claim-posterior-ag-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    const exposed = store.remember({ statement: "Exposed fact", nodeName: "facts" });
    const hidden = store.remember({ statement: "Hidden fact", nodeName: "other facts" });
    const context = store.searchContext("Exposed fact", {
      limit: 1,
      sessionId: "owner-session",
      taskId: "semantic-task",
    });
    assert.ok(context.activeGraph);
    assert.throws(() =>
      store.recordClaimOutcomes({
        semanticTaskId: "semantic-task",
        activeGraphId: context.activeGraph!.id,
        sessionId: "other-session",
        votes: [
          {
            memoryId: exposed.memory.id,
            outcome: "supported",
            source: "task",
            sourceLineage: "task-result",
          },
        ],
      }),
    );
    assert.throws(() =>
      store.recordClaimOutcomes({
        semanticTaskId: "semantic-task",
        activeGraphId: context.activeGraph!.id,
        sessionId: "owner-session",
        votes: [
          {
            memoryId: hidden.memory.id,
            outcome: "supported",
            source: "task",
            sourceLineage: "task-result",
          },
        ],
      }),
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("privacy deletion cascades claim posterior events and aggregate state", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-claim-posterior-delete-"));
  const store = new NmgStore(join(directory, "nmg.sqlite"));
  try {
    const saved = store.remember({ statement: "Disposable claim", nodeName: "disposable" });
    store.recordClaimOutcomes({
      semanticTaskId: "delete-task",
      votes: [
        {
          memoryId: saved.memory.id,
          outcome: "supported",
          source: "user",
          sourceLineage: "explicit-confirmation",
        },
      ],
    });
    assert.equal(store.claimPosteriors(saved.memory.id).length, 1);
    assert.equal(store.claimOutcomeEvents(saved.memory.id).length, 1);
    store.deleteMemory(saved.memory.id);
    assert.deepEqual(store.claimPosteriors(saved.memory.id), []);
    assert.deepEqual(store.claimOutcomeEvents(saved.memory.id), []);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
