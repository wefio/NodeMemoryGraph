import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../../src/core/store.ts";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-fb-"));
  const store = new NmgStore(join(directory, "test.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

test("recordFeedback: full supersede (new + old) applies supersession", () => {
  withStore((store) => {
    const old = store.remember({
      statement: "I am Employed at Huaxin Consulting.",
      nodeName: "work",
      scope: { user: "a" },
    });
    const newer = store.remember({
      statement: "I am now self-employed.",
      nodeName: "work",
      scope: { user: "a" },
    });
    store.recordFeedback({
      supersede: { newMemoryId: newer.memory.id, supersededMemoryId: old.memory.id },
    });
    const results = store.search("employment status", {
      nodeName: "work",
      scope: { user: "a" },
      limit: 5,
    });
    const ids = results.map((r) => r.memory.id);
    assert.ok(!ids.includes(old.memory.id), "superseded predecessor not surfaced");
    assert.ok(ids.includes(newer.memory.id), "newer value surfaced");
  });
});

test("recordFeedback: old-only supersede marks the predecessor disputed", () => {
  withStore((store) => {
    const old = store.remember({
      statement: "I am Employed at Huaxin Consulting.",
      nodeName: "work",
      scope: { user: "a" },
    });
    store.recordFeedback({
      supersede: { supersededMemoryId: old.memory.id, reason: "user is no longer employed" },
    });
    const record = store.getMemory(old.memory.id);
    assert.equal(
      record?.status,
      "disputed",
      "old-only supersede marks disputed (stale, new value pending)",
    );
  });
});

test("recordFeedback: invalid supersede target is a soft no-op (never throws)", () => {
  withStore((store) => {
    const newer = store.remember({
      statement: "I am now self-employed.",
      nodeName: "work",
      scope: { user: "a" },
    });
    assert.doesNotThrow(() => {
      store.recordFeedback({
        supersede: { newMemoryId: newer.memory.id, supersededMemoryId: "missing-id" },
      });
    });
  });
});

test("recordFeedback: usedMemoryIds bumps access_count", () => {
  withStore((store) => {
    const mem = store.remember({
      statement: "Martin prefers spicy food.",
      nodeName: "pref",
      scope: { user: "a" },
    });
    store.recordFeedback({ usedMemoryIds: [mem.memory.id] });
    assert.equal(
      store.getMemory(mem.memory.id)?.accessCount,
      1,
      "used feedback increments access_count",
    );
  });
});

test("recordFeedback: retrieveHints stored as retrieveHint markers", () => {
  withStore((store) => {
    const mem = store.remember({
      statement: "Martin prefers spicy food.",
      nodeName: "pref",
      scope: { user: "a" },
    });
    store.recordFeedback({
      retrieveHints: [{ memoryId: mem.memory.id, hints: ["辣", "spicy"] }],
    });
    const markers = store.getMemory(mem.memory.id)?.markers ?? [];
    const hints = markers
      .filter((m) => m.kind === "retrieveHint")
      .map((m) => m.attributes?.value);
    assert.deepEqual(hints, ["辣", "spicy"], "retrieveHints stored as retrieveHint markers");
  });
});
