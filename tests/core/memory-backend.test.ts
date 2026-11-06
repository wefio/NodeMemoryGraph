import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openMemoryBackend } from "../../src/core/memory/open.ts";
import type { MemoryCommitRequest, MemoryEntity } from "../../src/core/memory/backend.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

const node = (id: string, name: string): MemoryEntity => ({
  kind: "node",
  value: {
    id,
    canonicalName: name,
    summary: name,
    kind: "topic",
    createdAt: "2026-11-05T00:00:00Z",
    updatedAt: "2026-11-05T00:00:00Z",
    status: "active",
    residence: "ltg",
  },
});

for (const kind of ["sqlite", "lancedb"] as const) {
  test(`${kind}: atomic revisions, replay, concurrency, namespaces and read lifetimes`, async () => {
    const directory = mkdtempSync(join(tmpdir(), `nmg-${kind}-`));
    const options =
      kind === "sqlite"
        ? ({ kind, path: join(directory, "memory.sqlite"), namespace: "tenant-a" } as const)
        : ({ kind, uri: join(directory, "objects"), namespace: "tenant-a" } as const);
    const backend = await openMemoryBackend(options);
    const rival = await openMemoryBackend(options);
    const isolated = await openMemoryBackend({ ...options, namespace: "tenant-b" });
    const initial = await backend.openRead();
    try {
      const request: MemoryCommitRequest = {
        operationId: "first",
        requestHash: "content-one",
        expectedRevision: 0,
        changes: { upsert: [node("a", "Atlas")] },
        resultIds: ["a"],
      };
      assert.equal((await backend.commit(request)).status, "committed");
      assert.equal((await backend.commit(request)).status, "replayed");
      await assert.rejects(
        backend.commit({ ...request, requestHash: "different" }),
        /different content/,
      );
      assert.deepEqual(await backend.scan(initial, { kind: "node" }), []);
      const concurrent = await Promise.all([
        backend.commit({
          ...request,
          operationId: "left",
          expectedRevision: 1,
          changes: { upsert: [node("b", "Left")] },
        }),
        rival.commit({
          ...request,
          operationId: "right",
          expectedRevision: 1,
          changes: { upsert: [node("c", "Right")] },
        }),
      ]);
      assert.deepEqual(concurrent.map((outcome) => outcome.status).sort(), [
        "committed",
        "conflict",
      ]);
      const current = await backend.openRead();
      try {
        assert.equal(current.revision, 2);
        assert.equal((await backend.scan(current, { kind: "node" })).length, 2);
        await assert.rejects(isolated.scan(current, { kind: "node" }), /another backend/);
        await assert.rejects(backend.scan(current, { kind: "node", limit: 0 }), /Read limit/);
      } finally {
        await backend.closeRead(current);
      }
      const other = await isolated.openRead();
      try {
        assert.deepEqual(await isolated.scan(other, { kind: "node" }), []);
      } finally {
        await isolated.closeRead(other);
      }
      await backend.closeRead(initial);
      await assert.rejects(backend.scan(initial, { kind: "node" }), /closed/);
    } finally {
      await backend.close();
      await rival.close();
      await isolated.close();
    }
    const reopened = await openMemoryBackend(options);
    try {
      const view = await reopened.openRead();
      assert.equal(view.revision, 2);
      assert.equal((await reopened.scan(view, { kind: "node", nodeName: "ATLAS" })).length, 1);
      assert.equal((await reopened.receipt(view, "first"))?.resultIds[0], "a");
      await reopened.closeRead(view);
    } finally {
      await reopened.close();
      removeTempDirectory(directory);
    }
  });
}
