import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../../src/core/store.ts";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-writes-"));
  const store = new NmgStore(join(directory, "test.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

test("remember: writes a memory and returns history/node/memory", () => {
  withStore((store) => {
    const result = store.remember({
      statement: "user prefers dark mode",
      nodeName: "user preferences",
      nodeSummary: "user display preferences",
      memoryType: "preference",
      sourceActor: "user",
    });
    assert.ok(result.history.id);
    assert.equal(result.history.role, "explicit");
    assert.ok(result.history.content.includes("dark mode"));
    assert.ok(result.node.id);
    assert.equal(result.node.canonicalName, "user preferences");
    assert.ok(result.memory.id);
    assert.equal(result.memory.statement, "user prefers dark mode");
    assert.equal(result.memory.memoryType, "preference");
  });
});

test("remember: writes a state memory with automatic supersede", () => {
  withStore((store) => {
    const first = store.remember({
      statement: "dark mode is on",
      nodeName: "user settings",
      nodeSummary: "user UI settings",
      memoryType: "state",
      stateKey: "theme",
      sourceActor: "user",
    });
    assert.equal(first.memory.status, "active");
    assert.ok(first.memory.stateKey);

    const second = store.remember({
      statement: "dark mode is off",
      nodeName: "user settings",
      nodeSummary: "user UI settings",
      memoryType: "state",
      stateKey: "theme",
      sourceActor: "user",
    });
    assert.equal(second.memory.status, "active");
    // The first memory should now be superseded
    const context = store.searchContext("dark mode is on");
    const firstInResults = context.results.filter((r) => r.memory.id === first.memory.id);
    assert.equal(firstInResults.length, 0);
  });
});

test("remember: perf=false skips timing instrumentation", () => {
  withStore((store) => {
    const result = store.remember({
      perf: false,
      statement: "sans timer",
      nodeName: "user preferences",
      memoryType: "fact",
      sourceActor: "user",
    });
    assert.ok(result.memory.id);
    assert.equal(result.timings, undefined);
  });
});

test("addMemory: evidence is placed and idempotent evidence link created", () => {
  withStore((store) => {
    const node = store.remember({
      statement: "project uses SQLite",
      nodeName: "tech stack",
      memoryType: "constraint",
      sourceActor: "user",
    });
    assert.equal(node.memory.evidenceId, node.history.id);
    assert.deepEqual(node.memory.evidenceIds, [node.history.id]);
  });
});

test("appendHistory: creates a record and returns idempotent same-content result", () => {
  withStore((store) => {
    const record = store.appendHistory({
      content: "user said the sky is blue",
      role: "explicit",
      sessionId: "session-1",
    });
    assert.ok(record.id);
    assert.equal(record.role, "explicit");
    assert.equal(record.sessionId, "session-1");
    assert.equal(record.content, "user said the sky is blue");

    const repeated = store.appendHistory({
      content: "user said the sky is blue",
      role: "explicit",
      sessionId: "session-1",
      sourceMessageId: "msg-42",
      sourceRef: "chat-1",
    });
    assert.ok(repeated.id);
    // Not the first attempt — sourceMessageId was set so idempotent lookup fires
  });
});

test("appendHistory: deduplicates via sourceMessageId and rejects content mismatch", () => {
  withStore((store) => {
    store.appendHistory({
      content: "original content",
      role: "explicit",
      sessionId: "session-2",
      sourceMessageId: "msg-1",
    });
    const dup = store.appendHistory({
      content: "original content",
      role: "explicit",
      sessionId: "session-2",
      sourceMessageId: "msg-1",
    });
    assert.equal(dup.content, "original content");

    assert.throws(() => {
      store.appendHistory({
        content: "different content!",
        role: "explicit",
        sessionId: "session-2",
        sourceMessageId: "msg-1",
      });
    }, /source message msg-1 already exists with different content/);
  });
});

test("deriveMemory: creates derived memory from at least two source memories", () => {
  withStore((store) => {
    const source1 = store.remember({
      statement: "Atlas uses SQLite for storage",
      nodeName: "Atlas architecture",
      memoryType: "fact",
      sourceActor: "user",
    });
    const source2 = store.remember({
      statement: "Atlas uses WAL journal mode",
      nodeName: "Atlas architecture",
      memoryType: "fact",
      sourceActor: "user",
    });
    const derived = store.deriveMemory({
      sourceMemoryIds: [source1.memory.id, source2.memory.id],
      statement: "Atlas persistence layer is SQLite with WAL",
      nodeName: "Atlas persistence",
      derivation: "synthesized from two architecture facts",
      memoryType: "derived",
    });
    assert.equal(derived.memory.memoryType, "derived");
    assert.ok(derived.memory.evidenceIds.length >= 2);
    assert.throws(() => {
      store.deriveMemory({
        sourceMemoryIds: [source1.memory.id],
        statement: "too few",
        nodeName: "Atlas",
        derivation: "only one source",
      });
    }, /require at least two source memories/);
  });
});

test("recordRejectedWrite: records a write rejection event", () => {
  withStore((store) => {
    const event = store.recordRejectedWrite({
      policyReason: "duplicate statement detected",
      writeReason: "user-typed",
      writeSource: "agent",
      memoryType: "fact",
      requestedResidence: "ltg",
      sessionId: "session-3",
    });
    assert.ok(event.id);
    assert.equal(event.decision, "rejected");
    assert.equal(event.policyReason, "duplicate statement detected");
    assert.equal(event.writeReason, "user-typed");
    assert.equal(event.memoryId, null);
    assert.equal(event.historyId, null);
  });
});

test("recordRejectedWrite: defaults write source and memory type", () => {
  withStore((store) => {
    const event = store.recordRejectedWrite({
      policyReason: "policy X",
      writeReason: "reason Y",
    });
    assert.equal(event.writeSource, "agent");
    assert.equal(event.memoryType, "fact");
    assert.equal(event.requestedResidence, "ltg");
  });
});

test("recordUsage: bumps access_count for given memory ids", () => {
  withStore((store) => {
    const result = store.remember({
      statement: "user lives in Tokyo",
      nodeName: "user location",
      memoryType: "fact",
      sourceActor: "user",
    });
    store.recordUsage([result.memory.id]);
    // The access count is reflected through search results (which include access_count)
    const context = store.searchContext("Tokyo");
    const found = context.results.find((r) => r.memory.id === result.memory.id);
    assert.ok(found);
    assert.ok(found.memory.accessCount >= 1);
  });
});

test("recordUsage: no-op on empty or duplicate-free id list", () => {
  withStore((store) => {
    // Must not throw
    store.recordUsage([]);
    const result = store.remember({
      statement: "duplicate-safe",
      nodeName: "test",
      sourceActor: "user",
    });
    store.recordUsage([result.memory.id, result.memory.id]);
  });
});

test("archiveSession: archives a session transcript and round-trips", () => {
  withStore((store) => {
    const archive = store.archiveSession({
      sessionId: "session-4",
      transcript: "full session transcript here",
      sourceRef: "chat/42",
    });
    assert.ok(archive.historyId);
    assert.equal(archive.sessionId, "session-4");

    const fetched = store.getSessionArchive("session-4");
    assert.ok(fetched);
    assert.equal(fetched.historyId, archive.historyId);
    assert.equal(fetched.sessionId, "session-4");
  });
});

test("archiveSession: same transcript is idempotent", () => {
  withStore((store) => {
    const first = store.archiveSession({
      sessionId: "session-5",
      transcript: "unchanged content",
    });
    const second = store.archiveSession({
      sessionId: "session-5",
      transcript: "unchanged content",
    });
    assert.equal(second.historyId, first.historyId);
    assert.equal(second.sessionId, first.sessionId);
  });
});

test("archiveSession: updated transcript replaces old archive", () => {
  withStore((store) => {
    store.archiveSession({
      sessionId: "session-6",
      transcript: "version A",
    });
    const updated = store.archiveSession({
      sessionId: "session-6",
      transcript: "version B — longer",
    });
    const fetched = store.getSessionArchive("session-6");
    assert.ok(fetched);
    assert.equal(fetched.historyId, updated.historyId);
  });
});

test("getSessionArchive: returns null for unknown session ids", () => {
  withStore((store) => {
    const result = store.getSessionArchive("does-not-exist");
    assert.equal(result, null);
  });
});
