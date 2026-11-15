import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MemoryEngine } from "../../src/core/memory/engine.ts";
import { importMemoryGraph } from "../../src/core/memory/graph-import.ts";
import { LanceMemoryBackend } from "../../src/core/memory/lance-backend.ts";
import { SqliteMemoryBackend } from "../../src/core/memory/sqlite-backend.ts";
import { NmgStore } from "../../src/core/store.ts";
import { readLegacyMemorySnapshot } from "../../src/core/store/legacy-memory-snapshot.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

const liveSince = "2025-01-01T00:00:00.000Z";
const state = { nodeName: "Atlas", memoryType: "state", stateKey: "atlas.region" } as const;

test("SQLite installs a full legacy snapshot atomically and can reopen after new writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-migrate-"));
  const path = join(directory, "source.sqlite");
  try {
    const { current } = seedLegacy(path);
    const db = new DatabaseSync(path);
    try {
      db.exec(`WITH RECURSIVE ids(n) AS (
        VALUES(1) UNION ALL SELECT n + 1 FROM ids WHERE n < 600
      ) INSERT INTO history_records (id, role, content, created_at)
      SELECT 'extra-' || n, 'explicit', 'Archived test evidence', '${liveSince}' FROM ids`);
      db.prepare("UPDATE history_records SET session_id = ? WHERE id = ?").run(
        "originating-conversation",
        current.history.id,
      );
      db.prepare("UPDATE node_relations SET evidence_ids_json = '[]'").run();
      db.prepare(
        "INSERT INTO state_key_aliases VALUES ('atlas.location', '{}', 'atlas.region', ?)",
      ).run(liveSince);
    } finally {
      db.close();
    }
    const snapshot = readLegacyMemorySnapshot(path, { fullSqlite: true });
    assert.ok(snapshot.length > 512);
    const backend = new SqliteMemoryBackend(path, "local");
    try {
      const rejectWrite = new DatabaseSync(path);
      try {
        rejectWrite.exec(`CREATE TRIGGER fail_migration BEFORE INSERT ON nmg_memory_entities
          WHEN NEW.id = 'extra-300' BEGIN SELECT RAISE(ABORT, 'test import interruption'); END`);
        await assert.rejects(backend.installLegacySnapshot(snapshot), /test import interruption/);
        assert.equal(
          rejectWrite.prepare("SELECT count(*) AS n FROM nmg_memory_entities").get()?.n,
          0,
        );
        assert.equal(rejectWrite.prepare("SELECT count(*) AS n FROM nmg_memory_fts").get()?.n, 0);
        rejectWrite.exec("DROP TRIGGER fail_migration");
      } finally {
        rejectWrite.close();
      }
      const installed = await backend.installLegacySnapshot(snapshot);
      assert.equal(installed.revision, 1);
      const migrated = await new MemoryEngine(backend).get([current.memory.id]);
      assert.equal(migrated.tesserae?.[0]?.path, "deployment.md");
      assert.equal(migrated.tesserae?.[0]?.memoryId, current.memory.id);
      const update = await new MemoryEngine(backend).remember(
        { ...state, stateKey: "atlas.location", statement: "Atlas region is central" },
        "new-write",
      );
      assert.equal(update.memory.stateKey, "atlas.region");
      assert.equal(update.memory.supersedesId, current.memory.id);
      const historical = await new MemoryEngine(backend).search("Atlas", {
        includeHistorical: true,
      });
      assert.ok(historical.results.some((item) => item.memory.id === current.memory.id));
      assert.deepEqual(await backend.installLegacySnapshot(snapshot), installed);
      await backend.close();
      const reopened = new SqliteMemoryBackend(path, "local");
      try {
        const engine = new MemoryEngine(reopened);
        assert.equal(
          (await engine.get([update.memory.id])).results[0]?.memory.id,
          update.memory.id,
        );
        assert.equal((await engine.get([current.memory.id])).results.length, 0);
      } finally {
        await reopened.close();
      }
    } finally {
      await backend.close();
    }
  } finally {
    removeTempDirectory(directory);
  }
});

function seedLegacy(path: string) {
  const store = new NmgStore(path);
  try {
    const previous = store.remember({
      ...state,
      statement: "Atlas region is east",
      validFrom: "2024-01-01T00:00:00.000Z",
    });
    const current = store.remember({
      ...state,
      statement: "Atlas region is west",
      validFrom: liveSince,
      tesserae: [{ path: "deployment.md", snippet: "Atlas region is west" }],
    });
    const dependency = store.remember({
      nodeName: "Registry",
      statement: "Registry retains build artifacts",
    });
    const edge = store.linkNodes({
      sourceNodeId: current.node.id,
      targetNodeId: dependency.node.id,
      type: "depends_on",
      evidenceIds: [current.history.id],
    });
    store.remember({
      nodeName: "Private case",
      statement: "The customer uses an internal registry",
      residence: "stg",
      sessionId: "session-one",
      relatedMemoryIds: [dependency.memory.id],
    });
    store.putTaskBoardEntry({
      taskId: "delivery",
      agentId: "migration-fixture",
      kind: "note",
      content: "CoordinationMarker",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    return { previous, current, dependency, edge };
  } finally {
    store.close();
  }
}

for (const kind of ["sqlite", "lancedb"] as const) {
  test(`legacy graph rehearsal preserves identity, evidence and state on ${kind}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "nmg-migrate-"));
    const path = join(directory, "source.sqlite");
    try {
      const { previous, current, dependency, edge } = seedLegacy(path);
      const db = new DatabaseSync(path);
      try {
        db.prepare("INSERT INTO memory_evidence_links (memory_id, history_id) VALUES (?, ?)").run(
          current.memory.id,
          previous.history.id,
        );
      } finally {
        db.close();
      }
      const snapshot = readLegacyMemorySnapshot(path);
      const backend =
        kind === "sqlite"
          ? new SqliteMemoryBackend(path, "rehearsal")
          : await LanceMemoryBackend.open(join(directory, "objects"), "rehearsal");
      try {
        const broken = snapshot.filter((entity) => entity.value.id !== current.history.id);
        await assert.rejects(importMemoryGraph(backend, broken), /missing history/);
        const receipt = await importMemoryGraph(backend, snapshot);
        assert.equal(receipt.revision, 1);
        assert.deepEqual(await importMemoryGraph(backend, snapshot), receipt);
        const read = await backend.openRead();
        try {
          for (const entity of snapshot) {
            assert.deepEqual(
              await backend.scan(read, {
                kind: entity.kind,
                ids: [entity.value.id],
                sessionId: "session-one",
              }),
              [entity],
            );
          }
        } finally {
          await backend.closeRead(read);
        }
        const engine = new MemoryEngine(backend);
        const search = await engine.search("Atlas", { graphHops: 1 });
        assert.deepEqual(
          search.relations.map((relation) => relation.id),
          [edge.id],
        );
        assert.ok(search.results.some((item) => item.memory.id === dependency.memory.id));
        const ids = snapshot.flatMap((entity) =>
          entity.kind === "memory" ? [entity.value.id] : [],
        );
        const shared = await engine.get(ids);
        assert.deepEqual(
          new Set(shared.results.map((item) => item.memory.id)),
          new Set([current.memory.id, dependency.memory.id]),
        );
        const source = new NmgStore(path);
        try {
          const legacy = source.getContext([current.memory.id]).results[0];
          const imported = shared.results.find((item) => item.memory.id === current.memory.id);
          assert.ok(legacy && imported);
          const { evidenceIds, ...memory } = legacy.memory;
          assert.deepEqual(imported.memory, {
            ...memory,
            evidenceIds: imported.memory.evidenceIds,
          });
          assert.deepEqual(new Set(imported.memory.evidenceIds), new Set(evidenceIds));
          assert.deepEqual(imported.node, legacy.node);
          assert.deepEqual(imported.evidence, legacy.evidence);
          assert.equal(
            source.readTaskBoard({ taskId: "delivery" }).entries[0]?.content,
            "CoordinationMarker",
          );
        } finally {
          source.close();
        }
        assert.equal((await engine.get(ids, { sessionId: "session-one" })).results.length, 3);
        const update = await engine.remember({ ...state, statement: "Atlas region is central" });
        assert.equal(update.node.id, current.node.id);
        assert.equal(update.memory.supersedesId, current.memory.id);
        assert.equal(update.memory.evidenceRole, "update");
        assert.equal((await engine.get([current.memory.id])).results.length, 0);
        assert.deepEqual(readLegacyMemorySnapshot(path), snapshot);
      } finally {
        await backend.close();
      }
    } finally {
      removeTempDirectory(directory);
    }
  });
}

test("rehearsal rejects unsupported retention state and an unrelated nonempty target", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-migrate-"));
  const path = join(directory, "source.sqlite");
  try {
    const { current } = seedLegacy(path);
    const snapshot = readLegacyMemorySnapshot(path);
    const backend = new SqliteMemoryBackend(path, "occupied");
    try {
      const engine = new MemoryEngine(backend);
      await engine.remember({ nodeName: "Existing", statement: "Existing target data" });
      await assert.rejects(importMemoryGraph(backend, snapshot), /empty namespace/);
      assert.equal((await engine.search("Existing")).results.length, 1);
    } finally {
      await backend.close();
    }
    const db = new DatabaseSync(path);
    try {
      db.prepare("UPDATE memory_records SET storage_state = 'dormant' WHERE id = ?").run(
        current.memory.id,
      );
      assert.throws(() => readLegacyMemorySnapshot(path), /dormant or quarantined/);
    } finally {
      db.close();
    }
  } finally {
    removeTempDirectory(directory);
  }
});
