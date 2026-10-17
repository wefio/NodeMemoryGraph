import assert from "node:assert/strict";
import test from "node:test";

import { NmgStore } from "../../src/core/store.ts";
import type { MemoryContext, MemorySearchResult } from "../../src/core/types.ts";
import {
  createMemoryReferences,
  resolveMemoryReferences,
} from "../../src/integration/memory-reference.ts";
import { renderSearchSurface } from "../../src/integration/agent-surface.ts";
import {
  compactSearchContext,
  memoryDisclosureEntries,
} from "../../src/integration/search-projection.ts";
import { searchResultFixture } from "../helpers/search-result.ts";

const store = new NmgStore(":memory:");
const graph = store.searchContext("fixture without records").activeGraph!;
store.close();
const A = "11110000-1111-4111-8111-111111111111";
const B = "11112200-1111-4111-8111-111111111111";
const C = "22220000-1111-4111-8111-111111111111";

function context(results: MemorySearchResult[]): MemoryContext {
  return {
    results,
    relations: [],
    activeGraph: { ...graph, memoryIds: results.map((r) => r.memory.id) },
  };
}

function record(id = A, statement = "SQLite stores Atlas data."): MemorySearchResult {
  const result = searchResultFixture(id, statement);
  result.node.canonicalName = "Atlas storage";
  return result;
}

test("compound references preserve input, canonical DTOs, previews and disclosure IDs", () => {
  const original = context([record()]);
  const before = structuredClone(original);
  const mapped = {
    ...original,
    memoryReferences: createMemoryReferences(original),
  };
  assert.equal(mapped.memoryReferences[A], "ref:1111|SQLite");
  assert.deepEqual(original, before);
  assert.deepEqual(compactSearchContext(mapped), compactSearchContext(original));
  assert.deepEqual(
    memoryDisclosureEntries(mapped, "header"),
    memoryDisclosureEntries(original, "header"),
  );
  assert.equal(
    renderSearchSurface(mapped),
    renderSearchSurface(original).replace(`memory=${A};`, "memory=ref:1111|SQLite;"),
  );
  assert.deepEqual(
    resolveMemoryReferences(
      [mapped.memoryReferences[A]!, A, "unknown-legacy-id"],
      original.results,
    ),
    [A, A, "unknown-legacy-id"],
  );
});

test("repeated quotes and prefix collisions use both constraints, not first match", () => {
  const distinctIds = context([record(), record(C)]);
  assert.equal(createMemoryReferences(distinctIds)[A], "ref:1111|SQLite");
  const differentQuotes = context([record(), record(B, "Postgres stores Atlas data.")]);
  const refs = createMemoryReferences(differentQuotes);
  assert.equal(refs[A], "ref:1111|SQLite");
  assert.equal(refs[B], "ref:1111|Postgr");
  assert.deepEqual(resolveMemoryReferences([refs[A]!, refs[B]!], differentQuotes.results), [A, B]);
});

test("remaining compound ambiguity extends the prefix or fails closed", () => {
  const ambiguous = context([record(), record(B)]);
  const refs = createMemoryReferences(ambiguous);
  assert.equal(refs[A], "ref:111100|SQLite");
  assert.equal(refs[B], "ref:111122|SQLite");
  assert.throws(
    () => resolveMemoryReferences(["ref:1111|SQLite"], ambiguous.results),
    /ambiguous/u,
  );
  assert.deepEqual(resolveMemoryReferences([refs[A]!, refs[B]!], ambiguous.results), [A, B]);
  const reversed = { ...ambiguous, results: [...ambiguous.results].reverse() };
  assert.deepEqual(createMemoryReferences(reversed), refs);
});

test("generation checks graph targets that are not rendered in the selected subset", () => {
  const selected = context([record()]);
  const targets = [...selected.results, record(B)];
  assert.equal(createMemoryReferences(selected, targets)[A], "ref:111100|SQLite");
  assert.throws(() => resolveMemoryReferences(["ref:1111|SQLite"], targets), /ambiguous/u);
});

test("no match, malformed key and truncated quote cannot silently select a record", () => {
  const targets = [record()];
  assert.throws(() => resolveMemoryReferences(["ref:ffff|SQLite"], targets), /no match/u);
  assert.throws(() => resolveMemoryReferences(["ref:1111|S"], targets), /no match/u);
  for (const key of [
    "ref:111|SQLite",
    "ref:11111|SQLite",
    "ref:1111|",
    "ref:1111| SQLite",
    "ref:1111|SQLiteX",
    "ref:1111|A;B",
  ]) {
    assert.throws(() => resolveMemoryReferences([key], targets), /Invalid/u);
  }
});

test("Unicode code points and whitespace are defined without NFKC or fuzzy matching", () => {
  const values = context([
    record(A, "  SQLite\n\tstores Atlas data."),
    record(C, "😀计划采用数据库存储"),
  ]);
  const refs = createMemoryReferences(values);
  assert.equal(refs[A], "ref:1111|SQLite");
  assert.equal(refs[C], "ref:2222|😀计划采用数");
  assert.deepEqual(resolveMemoryReferences(Object.values(refs), values.results), [A, C]);
  const alphaId = "aabb0000-1111-4111-8111-111111111111";
  assert.deepEqual(resolveMemoryReferences(["ref:AABB|SQLite"], [record(alphaId)]), [alphaId]);
  const decomposed = context([record(A, "e\u0301cole stores data")]);
  const key = createMemoryReferences(decomposed)[A]!;
  assert.equal(key, "ref:1111|e\u0301cole");
  assert.throws(
    () => resolveMemoryReferences([key.normalize("NFC")], decomposed.results),
    /no match/u,
  );
});

test("statement prefix changes invalidate a selector but suffix edits retain identity", () => {
  const original = context([record()]);
  const key = createMemoryReferences(original)[A]!;
  assert.deepEqual(
    resolveMemoryReferences([key], [record(A, "SQLite now stores another value.")]),
    [A],
  );
  assert.throws(
    () => resolveMemoryReferences([key], [record(A, "Postgres replaces SQLite.")]),
    /no match/u,
  );
  assert.deepEqual(resolveMemoryReferences([A], [record(A, "Postgres replaces SQLite.")]), [A]);
});

test("long collisions, row delimiters, empty quotes and legacy IDs retain full IDs", () => {
  const collisionA = "11111111-1111-4111-8111-111111110001";
  const collisionB = "11111111-1111-4111-8111-111111110002";
  for (const records of [
    [record(collisionA), record(collisionB)],
    [record(A, "A;B data")],
    [record(A, " ")],
    [record("__proto__")],
  ]) {
    const value = context(records);
    assert.deepEqual(createMemoryReferences(value), {});
    assert.equal(
      renderSearchSurface({ ...value, memoryReferences: {} }),
      renderSearchSurface(value),
    );
  }
  const noGraph = { results: [record()], relations: [] };
  assert.deepEqual(createMemoryReferences(noGraph), {});
});

test("withdrawal keeps canonical ID and never inserts former text through a reference", () => {
  const withdrawn = record();
  withdrawn.memory.markers = [{ kind: "forget" }];
  const value = context([withdrawn]);
  assert.deepEqual(createMemoryReferences(value), {});
  const rendered = renderSearchSurface({
    ...value,
    memoryReferences: { [A]: "ref:1111|SQLite" },
  });
  assert.ok(rendered.includes(`memory=${A};`));
  assert.ok(rendered.includes("[forget] (content withdrawn)"));
  assert.ok(!rendered.includes("SQLite"));
});

test("deferred ID-only entries get no newly disclosed quote or extra candidate", () => {
  const value = context([record()]);
  value.progressiveDisclosure = {
    strategy: "warm_halves",
    rankedWarmCandidates: 2,
    initiallyVisible: 1,
    deferredMemoryIds: [B],
  };
  const refs = createMemoryReferences(value, [...value.results, record(B, "Postgres stores data")]);
  assert.equal(refs[B], undefined);
  const compact = compactSearchContext({ ...value, memoryReferences: refs });
  assert.equal(compact.candidates.length, 1);
  assert.deepEqual(compact.deferredMemoryIds, [B]);
});
