import assert from "node:assert/strict";
import test from "node:test";

import { NmgStore } from "../../../src/core/store.ts";
import type { SearchOptions } from "../../../src/core/types.ts";

const QUERY = "scoring corpus";
const MODEL = "hybrid-binding-fixture";
const VECTOR = [1, 0, 0];
const FROM = "2026-10-05";
const TO = "2026-10-06";
const SCOPE = { project: "Atlas", tenant: "north" };

function withCorpus(run: (store: NmgStore, ids: string[]) => void): void {
  const store = new NmgStore(":memory:");
  try {
    const cases = [
      { eventTime: FROM, scope: SCOPE },
      { eventTime: TO, scope: SCOPE },
      { eventTime: "2026-10-04", scope: SCOPE },
      { eventTime: "2026-10-07", scope: SCOPE },
      { eventTime: FROM, scope: { project: "Other", tenant: "north" } },
      { eventTime: FROM, scope: { project: "Atlas" } },
      { scope: SCOPE },
      { eventTime: TO, scope: { project: "Atlas", tenant: "south" } },
    ];
    const records = store.rememberMany(
      cases.map((entry, index) => ({
        ...entry,
        statement: `${QUERY} entry ${index}`,
        nodeName: "Binding corpus",
        tier: 2 as const,
      })),
    );
    const ids = records.map((entry) => entry.memory.id);
    assert.equal(new Set(ids).size, 8);
    store.upsertExternalEmbeddings(
      MODEL,
      ids.map((memoryId) => ({ memoryId, vector: VECTOR })),
    );
    assert.equal(
      store.ftsCandidates(QUERY, 8).length,
      8,
      "the regression requires positive FTS hits",
    );
    run(store, ids);
  } finally {
    store.close();
  }
}

const cases: Array<{ name: string; options: SearchOptions; expected: number[] }> = [
  { name: "without filters", options: {}, expected: [0, 1, 2, 3, 4, 5, 6, 7] },
  {
    name: "lower event-time bound",
    options: { eventTimeFrom: FROM },
    expected: [0, 1, 3, 4, 5, 7],
  },
  { name: "upper event-time bound", options: { eventTimeTo: TO }, expected: [0, 1, 2, 4, 5, 7] },
  {
    name: "both event-time bounds",
    options: { eventTimeFrom: FROM, eventTimeTo: TO },
    expected: [0, 1, 4, 5, 7],
  },
  { name: "multi-key scope", options: { scope: SCOPE }, expected: [0, 1, 2, 3, 6] },
  {
    name: "event-time and multi-key scope together",
    options: { eventTimeFrom: FROM, eventTimeTo: TO, scope: SCOPE },
    expected: [0, 1],
  },
];

for (const { name, options, expected } of cases) {
  test(`hybrid retains positive FTS candidates with ${name}`, () => {
    withCorpus((store, ids) => {
      const search = () =>
        store.searchByVector(QUERY, VECTOR, MODEL, {
          ...options,
          retrievalMode: "hybrid",
          maxTier: 3,
          limit: 8,
        });
      const results = search();
      assert.deepEqual(
        results.map((entry) => entry.memory.id).sort(),
        expected.map((index) => ids[index]!).sort(),
      );
      assert.ok(results.every((entry) => entry.lexicalScore > 0 && entry.vectorScore > 0));
      assert.deepEqual(
        search().map((entry) => entry.memory.id),
        results.map((entry) => entry.memory.id),
        "ordering is deterministic",
      );
    });
  });
}

test("FTS-only, vector-only, hybrid fallback and forced candidates preserve the same time/scope constraints", () => {
  withCorpus((store, ids) => {
    const options: SearchOptions = {
      eventTimeFrom: FROM,
      eventTimeTo: TO,
      scope: SCOPE,
      maxTier: 3,
    };
    const expected = [ids[0], ids[1]].sort();
    for (const retrievalMode of ["fts5", "qwen3"] as const) {
      const results = store.searchByVector(QUERY, VECTOR, MODEL, { ...options, retrievalMode });
      assert.deepEqual(results.map((entry) => entry.memory.id).sort(), expected);
    }
    assert.equal(store.ftsCandidates("unmatchedsemanticprobe", 8).length, 0);
    const fallback = store.searchByVector("unmatchedsemanticprobe", VECTOR, MODEL, {
      ...options,
      retrievalMode: "hybrid",
    });
    assert.deepEqual(fallback.map((entry) => entry.memory.id).sort(), expected);
    const forced = store.searchByVectorCandidates(QUERY, VECTOR, MODEL, ids, {
      ...options,
      retrievalMode: "hybrid",
    });
    assert.deepEqual(forced.map((entry) => entry.memory.id).sort(), expected);
  });
});

test("hybrid context with second pass retains only positive FTS hits in the time/scope window", () => {
  withCorpus((store, ids) => {
    const context = store.searchContextWithSecondPass(QUERY, {
      retrievalMode: "hybrid",
      maxTier: 3,
      limit: 8,
      eventTimeFrom: FROM,
      eventTimeTo: TO,
      scope: SCOPE,
      initialEvidenceTarget: 1,
      qppThreshold: 1,
      persistTrace: false,
    });
    assert.deepEqual(
      context.results.map((entry) => entry.memory.id).sort(),
      [ids[0], ids[1]].sort(),
    );
    assert.ok(context.results.every((entry) => entry.lexicalScore > 0));
    assert.ok(context.activeGraph?.qpp?.expansion);
  });
});

test("hybrid FTS hits cannot bypass event-time or scope exclusions", () => {
  withCorpus((store) => {
    const options: SearchOptions = { retrievalMode: "hybrid", maxTier: 3 };
    for (const filter of [
      { eventTimeFrom: "2027-01-01" },
      { eventTimeTo: "2025-01-01" },
      { scope: { project: "Absent" } },
    ]) {
      assert.deepEqual(store.searchByVector(QUERY, VECTOR, MODEL, { ...options, ...filter }), []);
    }
  });
});
