import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createStgStore,
  purgeSessionFromStg,
  stgStorePath,
} from "../../src/core/stg.ts";
import { NmgStore } from "../../src/core/store.ts";
import { HashingVectorEmbedder } from "../../src/core/vector.ts";

/**
 * STG Shared-Store v2 (docs/design/stg-shared-store-v2-2026-08-12.md):
 *   - one shared stg.sqlite per project (physical), session isolation is
 *     row-level via memory_records.session_id (logical)
 *   - escape-hatch rule: provisional writes REQUIRE sessionId; shared
 *     (session_id NULL) rows are only reachable through explicit channels
 *     (cached_from_ltg / LTG)
 *   - session purge removes only that session's provisional rows
 *   - close() checkpoints WAL (no -wal residue)
 */

function withStg(run: (directory: string, stg: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-stg-v2-"));
  const stg = createStgStore(directory, new HashingVectorEmbedder());
  try {
    run(directory, stg);
  } finally {
    stg.close();
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Windows may hold a transient lock; ignore in teardown.
    }
  }
}

test("v2: one shared stg.sqlite per project (no per-session files)", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-stg-v2-path-"));
  try {
    const a = stgStorePath(directory, "session-a");
    const b = stgStorePath(directory, "session-b");
    assert.equal(a, b, "all sessions share the single project file");
    assert.ok(a.endsWith(join(".nmg", "stg.sqlite")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("v2 escape-hatch: provisional write without sessionId is rejected", () => {
  withStg((_dir, stg) => {
    assert.throws(
      () =>
        stg.remember({
          statement: "Private scratch",
          nodeName: "scratch",
          residence: "stg",
        }),
      /explicit sessionId/,
    );
  });
});

test("v2 escape-hatch: cached_from_ltg copy is explicitly shared (no sessionId needed)", () => {
  withStg((_dir, stg) => {
    const saved = stg.remember({
      statement: "Hot LTG memory cached in project STG",
      nodeName: "cached",
      residence: "stg",
      markers: [
        {
          kind: "cached_from_ltg",
          attributes: { sourceMemoryId: "ltg-mem-1", cachedAt: "2026-08-12" },
        },
      ],
    });
    assert.equal(saved.memory.sessionId, null, "shared row has session_id NULL");
  });
});

test("v2: session-scoped search isolates provisional rows", () => {
  withStg((_dir, stg) => {
    stg.remember({
      statement: "Session A's private plan: launch Atlas 2.0 in March.",
      nodeName: "Atlas plan",
      residence: "stg",
      sessionId: "session-a",
    });
    stg.remember({
      statement: "Session B's private plan: retire the legacy pipeline.",
      nodeName: "Pipeline plan",
      residence: "stg",
      sessionId: "session-b",
    });

    const forA = stg.searchContext("private plan", { sessionId: "session-a", maxTier: 3 });
    const aStatements = forA.results.map((r) => r.memory.statement);
    assert.ok(aStatements.some((s) => s.includes("Atlas 2.0")), "A sees its own row");
    assert.ok(!aStatements.some((s) => s.includes("legacy pipeline")), "A does not see B's row");

    const forB = stg.searchContext("private plan", { sessionId: "session-b", maxTier: 3 });
    const bStatements = forB.results.map((r) => r.memory.statement);
    assert.ok(bStatements.some((s) => s.includes("legacy pipeline")), "B sees its own row");
    assert.ok(!bStatements.some((s) => s.includes("Atlas 2.0")), "B does not see A's row");

    // anonymous read (no sessionId): provisional rows must NOT leak — only
    // explicitly shared (session_id NULL) rows may surface without a session.
    const anon = stg.searchContext("private plan", { maxTier: 3 });
    const anonStatements = anon.results.map((r) => r.memory.statement);
    assert.ok(
      !anonStatements.some((s) => s.includes("Atlas 2.0")) &&
        !anonStatements.some((s) => s.includes("legacy pipeline")),
      "anonymous read does not see any session's provisional row",
    );
  });
});

test("v2: derived retrieval paths cannot expose another session's provisional rows", () => {
  withStg((_dir, stg) => {
    const anchor = stg.remember({
      statement: "Session A Atlas launch anchor uses the cobalt protocol.",
      nodeName: "Atlas launch anchor",
      residence: "stg",
      sessionId: "session-a",
    });
    const graphNeighbor = stg.remember({
      statement: "Session B private graph-expansion secret is marigold.",
      nodeName: "Private graph neighbor",
      residence: "stg",
      sessionId: "session-b",
    });
    const openAttachment = stg.remember({
      statement: "Session B private open attachment contains the obsidian code.",
      nodeName: "Private open attachment",
      residence: "stg",
      sessionId: "session-b",
      resolution: "open",
      relatedMemoryIds: [anchor.memory.id],
    });
    stg.linkNodes({
      sourceNodeId: anchor.node.id,
      targetNodeId: graphNeighbor.node.id,
      type: "related_to",
      evidenceIds: [],
    });

    const context = stg.searchContext("Atlas cobalt protocol", {
      sessionId: "session-a",
      retrievalMode: "fts5",
      graphHops: 1,
      maxTier: 3,
      limit: 8,
    });
    const resultIds = new Set(context.results.map((result) => result.memory.id));

    assert.ok(resultIds.has(anchor.memory.id), "session A sees its own anchor");
    assert.ok(!resultIds.has(graphNeighbor.memory.id), "graph expansion keeps session B private");
    assert.ok(!resultIds.has(openAttachment.memory.id), "open attachment keeps session B private");
    assert.ok(
      !context.relations.some(
        (relation) =>
          relation.sourceNodeId === graphNeighbor.node.id ||
          relation.targetNodeId === graphNeighbor.node.id,
      ),
      "relations do not disclose a private neighboring node",
    );

    const exact = stg.getContext([anchor.memory.id], 1, "session-a");
    assert.deepEqual(exact.results.map((result) => result.memory.id), [anchor.memory.id]);
    assert.equal(exact.relations.length, 0, "exact expansion also hides session B's relation");
  });
});

test("v2: shared (session_id NULL) rows are visible to every session", () => {
  withStg((_dir, stg) => {
    stg.remember({
      statement: "Shared project convention: blackboard notes are temporary.",
      nodeName: "Project convention",
      residence: "stg",
      sessionId: "session-a",
    });
    stg.remember({
      statement: "Shared cache hint: Atlas schema uses SQLite.",
      nodeName: "Cached hint",
      residence: "stg",
      markers: [
        {
          kind: "cached_from_ltg",
          attributes: { sourceMemoryId: "ltg-hint-1", cachedAt: "2026-08-12" },
        },
      ],
    });
    const forB = stg.searchContext("shared", { sessionId: "session-b", maxTier: 3 });
    const bStatements = forB.results.map((r) => r.memory.statement);
    assert.ok(
      bStatements.some((s) => s.includes("Atlas schema")),
      "session B sees the shared cached row",
    );
    assert.ok(
      !bStatements.some((s) => s.includes("blackboard notes")),
      "session B does not see session A's provisional row",
    );
    // anonymous read sees the shared cached row but not A's provisional row
    const anon = stg.searchContext("shared", { maxTier: 3 });
    const anonStatements = anon.results.map((r) => r.memory.statement);
    assert.ok(
      anonStatements.some((s) => s.includes("Atlas schema")),
      "anonymous read sees the shared cached row",
    );
    assert.ok(
      !anonStatements.some((s) => s.includes("blackboard notes")),
      "anonymous read does not see session A's provisional row",
    );
  });
});

test("v2: getMemory exact access is session-scoped (no cross-session read)", () => {
  withStg((_dir, stg) => {
    const a = stg.remember({
      statement: "A's private secret plan.",
      nodeName: "Secret",
      residence: "stg",
      sessionId: "session-a",
    });
    const shared = stg.remember({
      statement: "Shared cached fact.",
      nodeName: "Shared",
      residence: "stg",
      markers: [
        {
          kind: "cached_from_ltg",
          attributes: { sourceMemoryId: "ltg-s", cachedAt: "2026-08-12" },
        },
      ],
    });
    // owner sees its own row
    assert.ok(stg.getMemory(a.memory.id, "session-a"));
    // another session cannot read A's provisional by id
    assert.equal(stg.getMemory(a.memory.id, "session-b"), null, "cross-session read denied");
    // anonymous read (no sessionId): provisional row invisible, shared visible
    assert.equal(stg.getMemory(a.memory.id), null, "anonymous read of provisional denied");
    assert.ok(stg.getMemory(shared.memory.id), "anonymous read of shared allowed");
    // shared rows visible to every session
    assert.ok(stg.getMemory(shared.memory.id, "session-b"));
  });
});

test("v2: purgeSession removes only that session's provisional rows", () => {
  withStg((_dir, stg) => {
    const a = stg.remember({
      statement: "A's stale scratch.",
      nodeName: "Scratch A",
      residence: "stg",
      sessionId: "session-a",
    });
    stg.remember({
      statement: "B's fresh scratch.",
      nodeName: "Scratch B",
      residence: "stg",
      sessionId: "session-b",
    });
    const cached = stg.remember({
      statement: "Shared cache stays.",
      nodeName: "Cache",
      residence: "stg",
      markers: [
        {
          kind: "cached_from_ltg",
          attributes: { sourceMemoryId: "ltg-c", cachedAt: "2026-08-12" },
        },
      ],
    });

    const purged = purgeSessionFromStg(stg, "session-a");
    assert.ok(purged >= 1, "at least A's row removed");

    // A's row gone (its id no longer resolves even unfiltered)
    assert.equal(stg.getMemory(a.memory.id), null);
    // B's row and the shared cache survive
    assert.ok(stg.getMemory(cached.memory.id));
    // B's row survives under its own session; A's row is gone from its own
    // session (physical purge, not just a visibility filter).
    const forB = stg.searchContext("scratch", { sessionId: "session-b", maxTier: 3 }).results.map(
      (r) => r.memory.statement,
    );
    assert.ok(forB.some((s) => s.includes("B's fresh")), "B's row kept");
    const forA = stg.searchContext("scratch", { sessionId: "session-a", maxTier: 3 }).results.map(
      (r) => r.memory.statement,
    );
    assert.ok(!forA.some((s) => s.includes("A's stale")), "A's row purged from its own session");
    // anonymous read: private rows stay invisible (shared visibility is
    // already covered by getMemory(cached.memory.id) above)
    const remaining = stg.searchContext("scratch", { maxTier: 3 }).results.map(
      (r) => r.memory.statement,
    );
    assert.ok(!remaining.some((s) => s.includes("A's stale")), "A's row purged / invisible anonymously");
    assert.ok(!remaining.some((s) => s.includes("B's fresh")), "anonymous does not see B's private row");
  });
});

test("v2: close() checkpoints WAL (no -wal residue)", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-stg-v2-wal-"));
  const stg = createStgStore(directory, new HashingVectorEmbedder());
  try {
    for (let i = 0; i < 20; i += 1) {
      stg.remember({
        statement: `WAL fill row ${i}`,
        nodeName: "wal-fill",
        residence: "stg",
        sessionId: "session-wal",
      });
    }
  } finally {
    stg.close();
  }
  const wal = join(directory, ".nmg", "stg.sqlite-wal");
  const shm = join(directory, ".nmg", "stg.sqlite-shm");
  assert.equal(existsSync(wal), false, "no -wal residue after close");
  assert.equal(existsSync(shm), false, "no -shm residue after close");
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

test("v2: STG session purge does not touch task-board entries (shared store, different isolation)", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-stg-v2-board-"));
  const store = new NmgStore(join(directory, "ltg.sqlite"), new HashingVectorEmbedder());
  try {
    const board = store.putTaskBoardEntry({
      taskId: "proj-1",
      agentId: "agent-a",
      kind: "handoff",
      content: "board entry survives STG purge",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    store.remember({
      statement: "Session A's scratch provisional.",
      nodeName: "Scratch A",
      residence: "stg",
      sessionId: "session-a",
    });
    const purged = store.purgeSession("session-a");
    assert.ok(purged >= 1, "STG provisional purged");
    // task-board rows live in the same store but under a different isolation
    // policy (project-shared); purge must not touch them.
    const after = store.readTaskBoard({ taskId: "proj-1", includeResolved: true });
    assert.ok(
      after.entries.some((entry) => entry.id === board.id),
      "task-board entry survives STG session purge",
    );
  } finally {
    store.close();
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test("v2: checkpoint-on-open keeps WAL clean across reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-stg-v2-reopen-"));
  try {
    {
      const stg = createStgStore(directory, new HashingVectorEmbedder());
      stg.remember({
        statement: "survives reopen",
        nodeName: "reopen",
        residence: "stg",
        sessionId: "s1",
      });
      stg.close();
    }
    assert.equal(existsSync(join(directory, ".nmg", "stg.sqlite-wal")), false);
    // reopen (simulates a restart that sees a leftover -wal from a force-exit):
    // checkpoint-on-open folds any residual WAL and reads still work.
    {
      const stg2 = createStgStore(directory, new HashingVectorEmbedder());
      assert.equal(
        stg2.searchContext("survives", { sessionId: "s1", maxTier: 3 }).results.length >= 1,
        true,
      );
      stg2.close();
    }
    assert.equal(existsSync(join(directory, ".nmg", "stg.sqlite-wal")), false);
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test("v2: consolidation to LTG is the explicit escape hatch (session -> global)", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-stg-v2-cons-"));
  const ltg = new NmgStore(join(directory, "ltg.sqlite"), new HashingVectorEmbedder());
  const stg = createStgStore(directory, new HashingVectorEmbedder());
  try {
    stg.remember({
      statement: "Atlas promotion decision: keep SQLite backend.",
      nodeName: "Atlas backend",
      evidence: "User confirmed keeping SQLite.",
      scope: { project: "atlas" },
      residence: "stg",
      sessionId: "session-a",
    });
    const promoted = ltg.remember({
      statement: "Atlas promotion decision: keep SQLite backend.",
      nodeName: "Atlas backend",
      evidence: "User confirmed keeping SQLite.",
      scope: { project: "atlas" },
      residence: "ltg",
      writeReason: "stg_outcome_consolidation",
    });
    // consolidated LTG row is global (session_id NULL) and searchable without
    // any session filter
    assert.equal(promoted.memory.residence, "ltg");
    assert.equal(promoted.memory.sessionId, null);
    assert.equal(ltg.searchContext("Atlas promotion", { maxTier: 3 }).results.length >= 1, true);
  } finally {
    ltg.close();
    stg.close();
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});
