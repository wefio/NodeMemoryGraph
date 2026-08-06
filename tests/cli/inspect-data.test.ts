import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getMemoryDetail,
  getTraceDetail,
  listMemories,
  listTraces,
  openInspectDb,
} from "../../src/cli/inspect-data.ts";
import { NmgService } from "../../src/cli/service.ts";

test("inspect queries read memories, evidence, and traces from a live database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-inspect-"));
  const databasePath = join(directory, "nmg.sqlite");
  const service = new NmgService({ databasePath, environment: {} });
  try {
    const remembered = await service.invoke("remember", {
      statement: "The Atlas project must remain offline-first.",
      nodeName: "Atlas architecture",
      memoryType: "constraint",
      evidence: "The Atlas project must remain offline-first.",
      scope: { project: "atlas" },
    });
    await service.invoke("search", { query: "Atlas offline first" });

    // Read-only inspection must be safe while the writer is still open (WAL).
    const db = openInspectDb(databasePath);
    try {
      const memories = listMemories(db);
      assert.equal(memories.length, 1);
      assert.equal(memories[0]!.id, remembered.memory.id);
      assert.equal(memories[0]!.memoryType, "constraint");
      assert.equal(memories[0]!.nodeName, "Atlas architecture");

      const detail = getMemoryDetail(db, remembered.memory.id);
      assert.ok(detail);
      assert.equal(detail.statement, "The Atlas project must remain offline-first.");
      assert.deepEqual(detail.scope, { project: "atlas" });
      assert.equal(detail.evidence.length, 1);
      assert.equal(
        detail.evidence[0]!.content,
        "The Atlas project must remain offline-first.",
      );
      assert.equal(getMemoryDetail(db, "missing-memory"), null);

      const traces = listTraces(db);
      assert.ok(traces.length >= 1);
      assert.equal(traces[0]!.query, "Atlas offline first");
      assert.ok(traces[0]!.resultCount >= 1);

      const traceDetail = getTraceDetail(db, traces[0]!.id);
      assert.ok(traceDetail);
      assert.ok(traceDetail.resultMemoryIds.includes(remembered.memory.id));
      assert.equal(getTraceDetail(db, "missing-trace"), null);
    } finally {
      db.close();
    }
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("openInspectDb rejects a missing database instead of creating it", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-inspect-missing-"));
  try {
    assert.throws(() => openInspectDb(join(directory, "nmg.sqlite")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
