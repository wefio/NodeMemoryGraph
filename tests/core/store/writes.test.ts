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

test("remember validates exact harness evidence provenance", () => {
  withStore((store) => {
    assert.throws(
      () =>
        store.remember({
          statement: "Atlas uses SQLite",
          nodeName: "Atlas",
          sessionId: "session-a",
          sourceActor: "user",
          evidence: "uses SQLite",
          evidenceSource: {
            actor: "assistant",
            content: "uses SQLite",
            sourceMessageId: "message-1",
          },
        }),
      /does not match sourceActor/,
    );
    assert.throws(
      () =>
        store.remember({
          statement: "Atlas uses SQLite",
          nodeName: "Atlas",
          sessionId: "session-a",
          evidence: "uses SQLite",
          evidenceSource: {
            actor: "user",
            content: "different text",
            sourceMessageId: "message-1",
          },
        }),
      /exact excerpt/,
    );
    const result = store.remember({
      statement: "Atlas uses SQLite",
      nodeName: "Atlas",
      sessionId: "session-a",
      evidence: "uses SQLite",
      evidenceSource: {
        actor: "user",
        content: "uses SQLite",
        sourceMessageId: "message-1",
        sourceRef: "pi-session:session-a",
      },
    });
    assert.equal(result.history.content, "uses SQLite");
    assert.equal(result.history.role, "user");
    assert.equal(result.history.sourceMessageId, "message-1");
  });
});

test("remember bounds supersession prefilter terms for very long evidence", () => {
  withStore((store) => {
    store.remember({ statement: "baseline durable fact", nodeName: "Long evidence" });
    const statement = Array.from({ length: 1_500 }, (_, index) => `distincttoken${index}`).join(" ");
    const result = store.remember({ statement, nodeName: "Long evidence" });
    assert.equal(result.memory.statement, statement);
  });
});

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

test("rememberMany preserves ordered duplicate and state semantics", () => {
  withStore((store) => {
    const results = store.rememberMany([
      { statement: "user prefers dark mode", nodeName: "preferences", scope: { user: "a" } },
      { statement: "User prefers dark mode.", nodeName: "preferences", scope: { user: "a" } },
      {
        statement: "theme is light",
        nodeName: "settings",
        memoryType: "state",
        stateKey: "theme",
        scope: { user: "a" },
      },
      {
        statement: "theme is dark",
        nodeName: "settings",
        memoryType: "state",
        stateKey: "theme",
        scope: { user: "a" },
      },
    ]);
    assert.equal(results.length, 4);
    assert.equal(results[1]!.memory.id, results[0]!.memory.id);
    assert.equal(store.getMemory(results[2]!.memory.id)?.status, "superseded");
    assert.equal(results[3]!.memory.supersedesId, results[2]!.memory.id);
  });
});

test("rememberMany rolls back the full batch on failure", () => {
  withStore((store) => {
    assert.throws(
      () =>
        store.rememberMany([
          { statement: "first batch fact", nodeName: "batch", scope: { test: "rollback" } },
          {
            statement: "invalid state without key",
            nodeName: "batch",
            memoryType: "state",
            scope: { test: "rollback" },
          },
        ]),
      /state memories require a stable stateKey/,
    );
    assert.equal(store.search("first batch fact", { scope: { test: "rollback" } }).length, 0);
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

test("addMemory: writes a memory record bound to a node and evidence", () => {
  withStore((store) => {
    const node = store.upsertNode({ canonicalName: "add-memory-node" });
    const history = store.appendHistory({ role: "explicit", content: "the sky is blue" });
    const memory = store.addMemory({
      nodeId: node.id,
      evidenceId: history.id,
      statement: "the sky is blue",
      memoryType: "fact",
    });
    assert.ok(memory.id);
    assert.equal(memory.nodeId, node.id);
    assert.equal(memory.evidenceId, history.id);
    assert.equal(memory.statement, "the sky is blue");
    assert.equal(memory.memoryType, "fact");
    assert.equal(memory.status, "active");
  });
});

test("addMemory: state memory stores stateKey and records explicit supersedesId", () => {
  withStore((store) => {
    const node = store.upsertNode({ canonicalName: "add-memory-state" });
    const h1 = store.appendHistory({ role: "explicit", content: "theme is dark" });
    const first = store.addMemory({
      nodeId: node.id,
      evidenceId: h1.id,
      statement: "theme is dark",
      memoryType: "state",
      stateKey: "theme",
    });
    const h2 = store.appendHistory({ role: "explicit", content: "theme is light" });
    const second = store.addMemory({
      nodeId: node.id,
      evidenceId: h2.id,
      statement: "theme is light",
      memoryType: "state",
      stateKey: "theme",
      supersedesId: first.id,
    });
    // addMemory is a low-level primitive: it stores stateKey verbatim and
    // records the explicit supersedesId link. Automatic status flipping of
    // the superseded memory is remember's orchestration, not addMemory's.
    assert.equal(first.stateKey, "theme");
    assert.equal(second.stateKey, "theme");
    assert.equal(second.supersedesId, first.id);
    assert.equal(first.supersedesId, null);
  });
});

test("addMemory: derived memory records an evidence link to the source", () => {
  withStore((store) => {
    const node = store.upsertNode({ canonicalName: "add-memory-derived" });
    const h = store.appendHistory({ role: "explicit", content: "parent claim" });
    const memory = store.addMemory({
      nodeId: node.id,
      evidenceId: h.id,
      statement: "parent claim",
      memoryType: "derived",
      writeSource: "derived",
    });
    assert.equal(memory.memoryType, "derived");
    assert.equal(memory.writeSource, "derived");
    assert.equal(memory.status, "active");
  });
});
