import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  beginEmbeddingIndex,
  completeEmbeddingIndex,
  embeddingIndexHealth,
  failEmbeddingIndex,
} from "../../../src/core/store/embedding-index.ts";
import { migrate } from "../../../src/core/store/schema.ts";

function withDatabase(run: (db: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-embedding-index-"));
  const db = new DatabaseSync(join(directory, "test.sqlite"));
  try {
    migrate(db);
    run(db);
  } finally {
    db.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

test("begin records a running index", () => {
  withDatabase((db) => {
    beginEmbeddingIndex(db, {
      indexId: "i1",
      model: "m",
      profile: "p",
      targets: ["nodes"],
    });
    assert.equal(embeddingIndexHealth(db, "i1")?.status, "running");
  });
});

test("complete and fail move the index to a terminal status", () => {
  withDatabase((db) => {
    const input = { indexId: "i1", model: "m", profile: "p", targets: ["nodes"] as const };

    beginEmbeddingIndex(db, { ...input, targets: [...input.targets] });
    completeEmbeddingIndex(db, "i1");
    const ready = embeddingIndexHealth(db, "i1");
    assert.equal(ready?.status, "ready");
    assert.equal(ready?.lastError, null);

    beginEmbeddingIndex(db, { ...input, targets: [...input.targets] });
    failEmbeddingIndex(db, "i1", new Error("boom"));
    const failed = embeddingIndexHealth(db, "i1");
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.lastError, "boom");
  });
});

test("restarting an index clears the previous error", () => {
  // An interrupted rebuild must not leave a stale error visible once a fresh
  // run starts, otherwise health reporting describes the wrong attempt.
  withDatabase((db) => {
    const input = { indexId: "i1", model: "m", profile: "p", targets: ["nodes"] as const };
    beginEmbeddingIndex(db, { ...input, targets: [...input.targets] });
    failEmbeddingIndex(db, "i1", new Error("boom"));

    beginEmbeddingIndex(db, { ...input, targets: [...input.targets] });
    const restarted = embeddingIndexHealth(db, "i1");
    assert.equal(restarted?.status, "running");
    assert.equal(restarted?.lastError, null);
  });
});

test("completing or failing an index that never started is an error", () => {
  withDatabase((db) => {
    assert.throws(() => completeEmbeddingIndex(db, "missing"), /was not started/u);
    assert.throws(() => failEmbeddingIndex(db, "missing", "x"), /was not started/u);
  });
});

test("an index requires at least one target", () => {
  withDatabase((db) => {
    assert.throws(
      () => beginEmbeddingIndex(db, { indexId: "i1", model: "m", profile: "p", targets: [] }),
      /at least one target/u,
    );
  });
});

test("health is null for an unknown index", () => {
  withDatabase((db) => {
    assert.equal(embeddingIndexHealth(db, "nope"), null);
  });
});
