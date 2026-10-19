import assert from "node:assert/strict";
import test from "node:test";
import {
  captureMemoryReferenceTargets,
  resolveMemoryReferences,
} from "../../src/integration/memory-reference.ts";
import { searchResultFixture } from "../helpers/search-result.ts";

const A = "11110000-1111-4111-8111-111111111111";
const B = "11112200-1111-4111-8111-111111111111";

test("a current quote moving to another candidate cannot rebind an original reference", () => {
  const original = [
    searchResultFixture(A, "SQLite stores Atlas A."),
    searchResultFixture(B, "Postgres stores Atlas B."),
  ];
  const snapshot = captureMemoryReferenceTargets(original);
  original[0]!.memory.statement = "Postgres replaces Atlas A.";
  const current = [searchResultFixture(B, "SQLite stores Atlas B.")];
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot[0]!.memory));
  assert.throws(() => resolveMemoryReferences(["ref:1111|SQLite"], snapshot, current), /no match/u);
  assert.deepEqual(resolveMemoryReferences([A], snapshot, current), [A]);
});
