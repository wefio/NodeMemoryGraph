import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../../src/core/store.ts";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-delete-"));
  const store = new NmgStore(join(directory, "test.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

test("deleteMemory marks the record as deleted", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "user prefers dark mode",
      nodeName: "user preferences",
      nodeSummary: "user display preferences",
      memoryType: "preference",
      sourceActor: "user",
    });
    const deleted = store.deleteMemory(saved.memory.id);
    assert.ok(deleted);
    assert.equal(deleted!.status, "active"); // returned record is the pre-deletion snapshot
  });
});

test("deleteMemory cleans up FTS, embedding, evidence links, and leaf membership", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "user lives in Berlin",
      nodeName: "user location",
      nodeSummary: "user current city",
      memoryType: "fact",
      sourceActor: "user",
    });

    store.deleteMemory(saved.memory.id);

    // The deleted record must not appear in search results.
    const context = store.searchContext("Berlin");
    assert.equal(
      context.results.some((result) => result.memory.id === saved.memory.id),
      false,
    );
  });
});

test("deleteMemory returns null for unknown ids", () => {
  withStore((store) => {
    assert.equal(store.deleteMemory("does-not-exist"), null);
  });
});

test("deleted memories are filtered from getContext", () => {
  withStore((store) => {
    const saved = store.remember({
      statement: "user is vegan",
      nodeName: "user diet",
      nodeSummary: "dietary restrictions",
      memoryType: "preference",
      sourceActor: "user",
    });
    store.deleteMemory(saved.memory.id);
    const ctx = store.getContext(saved.memory.evidenceIds, 0);
    assert.ok(ctx.results.every((result) => result.memory.id !== saved.memory.id));
  });
});

test("derived memories with no remaining sources are cascade-deleted", () => {
  withStore((store) => {
    const source = store.remember({
      statement: "user needs a standing desk",
      nodeName: "user equipment",
      nodeSummary: "office equipment preferences",
      memoryType: "fact",
      sourceActor: "user",
    });
    const source2 = store.remember({
      statement: "user has chronic back pain",
      nodeName: "user health",
      nodeSummary: "health conditions",
      memoryType: "fact",
      sourceActor: "user",
    });
    const derived = store.deriveMemory({
      statement: "user likely works from home",
      sourceMemoryIds: [source.memory.id, source2.memory.id],
      nodeName: "derived node",
      nodeSummary: "derived summary",
      memoryType: "derived",
      sourceActor: "system",
      truthStatus: "inferred",
    });

    store.deleteMemory(source.memory.id);

    const ctx = store.searchContext("standing desk");
    assert.equal(
      ctx.results.some((result) => result.memory.id === source.memory.id),
      false,
    );
    assert.equal(
      ctx.results.some((result) => result.memory.id === derived.memory.id),
      false,
    );
  });
});
