import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encodeContextFeatures } from "../../src/lab/context-features.ts";
import {
  admitContextIntervention,
  type ContextIntervention,
} from "../../src/lab/context-intervention.ts";
import { ContextTrialJournal } from "../../src/lab/context-journal.ts";
import type { ContextTrialEvent } from "../../src/lab/context-trial.ts";

function makeDirectory(): string {
  return mkdtempSync(join(tmpdir(), "nmg-context-journal-"));
}

function decisionSample(): ContextIntervention {
  return {
    schemaVersion: 1,
    decisionId: "journal-decision",
    taskId: "journal-task",
    sessionId: "journal-session",
    taskFrameId: "journal-frame",
    acceptanceVersion: "journal-acceptance-v1",
    featureVersion: "context-features-v1",
    policyVersion: "journal-policy-v1",
    origin: "synthetic",
    mode: "executed",
    decidedAt: 0,
    features: encodeContextFeatures({}),
    allowed: ["none", "cue", "resurface", "retrieve"],
    selected: "retrieve",
    probability: 1,
  };
}

function decisionEvent(): ContextTrialEvent {
  return { phase: "decision", sample: decisionSample() };
}

function executionEvent(): ContextTrialEvent {
  return {
    phase: "execution",
    sample: {
      ...decisionSample(),
      execution: {
        action: "retrieve",
        startedAt: 1,
        endedAt: 2,
        status: "completed",
        result: {
          contentHash: "a".repeat(64),
          evidenceIds: ["evidence-1"],
          characters: 7,
          toolCalls: 1,
        },
      },
    },
  };
}

function outcomeEvent(status: "observed" | "reopened" = "observed"): ContextTrialEvent {
  return {
    phase: "outcome",
    sample: {
      ...executionEvent().sample,
      outcome: {
        taskId: "journal-task",
        acceptanceVersion: "journal-acceptance-v1",
        windowStart: 1,
        windowEnd: 3,
        recordedAt: 4,
        status,
        reward: 0.5,
        evidenceRefs: ["evidence-1"],
        costs: { tokens: 7, toolCalls: 1, latencyMs: 1 },
      },
    },
  };
}

function cleanup(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

test("contract: journal replays the latest outcome after close and reopen", () => {
  const directory = makeDirectory();
  const path = join(directory, "trials.jsonl");
  try {
    const journal = new ContextTrialJournal(path);
    journal.append(decisionEvent());
    journal.append(executionEvent());
    journal.append(outcomeEvent());
    journal.close();

    const reopened = new ContextTrialJournal(path);
    assert.deepEqual(reopened.entries(), [outcomeEvent()]);
    reopened.close();
  } finally {
    cleanup(directory);
  }
});

test("safety: duplicate decisions cannot reserve the same decision twice", () => {
  const directory = makeDirectory();
  const path = join(directory, "trials.jsonl");
  try {
    const journal = new ContextTrialJournal(path);
    journal.append(decisionEvent());
    assert.throws(() => journal.append(decisionEvent()), /decision already reserved/);
    journal.close();
  } finally {
    cleanup(directory);
  }
});

test("safety: a second writer for the same journal path is rejected", () => {
  const directory = makeDirectory();
  const path = join(directory, "trials.jsonl");
  try {
    const first = new ContextTrialJournal(path);
    assert.throws(() => new ContextTrialJournal(path), /EEXIST/);
    first.close();
    const second = new ContextTrialJournal(path);
    second.close();
  } finally {
    cleanup(directory);
  }
});

test("safety: task and policy identity changes cannot cross a journal transition", () => {
  for (const change of ["taskId", "acceptanceVersion", "policyVersion"] as const) {
    const directory = makeDirectory();
    const path = join(directory, `${change}.jsonl`);
    try {
      const journal = new ContextTrialJournal(path);
      journal.append(decisionEvent());
      const changed = executionEvent();
      changed.sample[change] = `changed-${change}`;
      assert.throws(() => journal.append(changed), /decision identity drift/);
      journal.close();
    } finally {
      cleanup(directory);
    }
  }
});

test("safety: execution receipts are immutable across later phases", () => {
  const directory = makeDirectory();
  const path = join(directory, "immutable.jsonl");
  try {
    const journal = new ContextTrialJournal(path);
    journal.append(decisionEvent());
    journal.append(executionEvent());
    const changed = outcomeEvent();
    changed.sample.execution!.result!.toolCalls = 2;
    assert.throws(() => journal.append(changed), /execution identity drift/);
    journal.close();
  } finally {
    cleanup(directory);
  }
});

test("safety: a reopened outcome remains visible but is not admissible", () => {
  const directory = makeDirectory();
  const path = join(directory, "reopened.jsonl");
  try {
    const journal = new ContextTrialJournal(path);
    journal.append(decisionEvent());
    journal.append(executionEvent());
    journal.append(outcomeEvent());
    journal.append(outcomeEvent("reopened"));
    const latest = journal.entries()[0]?.sample;
    assert.equal(latest?.outcome?.status, "reopened");
    assert.equal(admitContextIntervention(latest!, () => true).reason, "invalid-outcome");
    journal.close();
  } finally {
    cleanup(directory);
  }
});

test("safety: capacity is checked before writing a record", () => {
  const directory = makeDirectory();
  const path = join(directory, "bounded.jsonl");
  try {
    const journal = new ContextTrialJournal(path, 1);
    assert.throws(() => journal.append(decisionEvent()), /capacity exceeded/);
    assert.deepEqual(journal.entries(), []);
    journal.close();
  } finally {
    cleanup(directory);
  }
});

test("safety: a torn final line rejects construction and releases its lock", () => {
  const directory = makeDirectory();
  const path = join(directory, "torn.jsonl");
  try {
    writeFileSync(path, JSON.stringify(decisionEvent()));
    assert.throws(() => new ContextTrialJournal(path), /torn journal tail/);
    assert.equal(existsSync(`${path}.lock`), false);
  } finally {
    cleanup(directory);
  }
});

test("contract: close is idempotent and releases the writer lock", () => {
  const directory = makeDirectory();
  const path = join(directory, "close.jsonl");
  try {
    const journal = new ContextTrialJournal(path);
    journal.close();
    journal.close();
    assert.equal(existsSync(`${path}.lock`), false);
    const reopened = new ContextTrialJournal(path);
    reopened.close();
  } finally {
    cleanup(directory);
  }
});
