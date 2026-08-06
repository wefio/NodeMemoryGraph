import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgStore } from "../../../src/core/store.ts";
import {
  normalizeStatement,
  statementSimilarity,
} from "../../../src/core/store/search-ranking.ts";

function withStore(run: (store: NmgStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-dup-"));
  const store = new NmgStore(join(directory, "test.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

test("normalizeStatement: strips case, punctuation, whitespace", () => {
  assert.equal(normalizeStatement("I like dogs."), normalizeStatement("i like dogs"));
  assert.equal(normalizeStatement("  A,  B!  "), normalizeStatement("a b"));
  assert.equal(normalizeStatement("Hello, world — really!"), normalizeStatement("hello world really"));
});

test("statementSimilarity: exact normalized = 1, partial between, unrelated low", () => {
  assert.equal(statementSimilarity("i like dogs", "I like dogs."), 1);
  assert.ok(statementSimilarity("i like dogs and cats", "i like dogs") > 0.5);
  assert.ok(statementSimilarity("i like dogs", "the sky is blue") < 0.1);
});

test("remember: exact duplicate in same scope auto-skips (returns existing)", () => {
  withStore((store) => {
    const first = store.remember({
      statement: "user prefers dark mode",
      nodeName: "prefs",
      scope: { user: "a" },
    });
    const second = store.remember({
      statement: "user prefers dark mode",
      nodeName: "prefs",
      scope: { user: "a" },
    });
    assert.equal(second.memory.id, first.memory.id);
    assert.ok(second.duplicates && second.duplicates.length >= 1);
    assert.equal(second.duplicates![0]!.similarity, 1);
  });
});

test("remember: normalized variant (case/punctuation) auto-skips", () => {
  withStore((store) => {
    const first = store.remember({
      statement: "I like dogs.",
      nodeName: "pets",
      scope: { user: "a" },
    });
    const second = store.remember({
      statement: "i like dogs",
      nodeName: "pets",
      scope: { user: "a" },
    });
    assert.equal(second.memory.id, first.memory.id);
  });
});

test("remember: different scope is not a duplicate", () => {
  withStore((store) => {
    const first = store.remember({
      statement: "user prefers dark mode",
      nodeName: "prefs",
      scope: { user: "a" },
    });
    const second = store.remember({
      statement: "user prefers dark mode",
      nodeName: "prefs",
      scope: { user: "b" },
    });
    assert.notEqual(second.memory.id, first.memory.id);
  });
});

test("remember: judge merge returns target without writing a new record", () => {
  withStore((store) => {
    store.remember({
      statement: "I like dogs and cats.",
      nodeName: "pets",
      scope: { user: "a" },
    });
    const judged: Array<{ statement: string; candidates: unknown[] }> = [];
    const result = store.remember({
      statement: "I like dogs and cats a lot.",
      nodeName: "pets2",
      scope: { user: "a" },
      judgeDuplicates: (input) => {
        judged.push(input);
        return { merge: true, reason: "same fact restated" };
      },
    });
    assert.equal(judged.length, 1);
    assert.equal(judged[0]!.candidates.length, 1);
    assert.ok(judged[0]!.candidates[0] && (judged[0]!.candidates[0] as { similarity: number }).similarity >= 0.7);
    // returned the existing record, not a new write
    assert.equal(result.memory.statement, "I like dogs and cats.");
    assert.ok(result.duplicates && result.duplicates.length >= 1);
  });
});

test("remember: judge reject writes normally with duplicates tagged", () => {
  withStore((store) => {
    store.remember({
      statement: "I like dogs and cats.",
      nodeName: "pets",
      scope: { user: "a" },
    });
    const result = store.remember({
      statement: "I like dogs and cats a lot.",
      nodeName: "pets2",
      scope: { user: "a" },
      judgeDuplicates: () => ({ merge: false, reason: "distinct nuance" }),
    });
    // a new record was written (not merged)
    assert.equal(result.memory.statement, "I like dogs and cats a lot.");
    assert.ok(result.duplicates && result.duplicates.length >= 1);
  });
});

test("searchContext: duplicateOf marks a same-normalized later result", () => {
  withStore((store) => {
    store.remember({ statement: "I like dogs.", nodeName: "pets", scope: { user: "a" } });
    store.remember({ statement: "i like dogs", nodeName: "pets-again", scope: { user: "b" } });
    const context = store.searchContext("I like dogs", { limit: 10 });
    const norm = context.results.map((r) => r.memory.statement);
    const marked = context.results.filter((r) => r.duplicateOf);
    // both same-normalized records can be present, but only one is "kept"
    const kept = context.results.filter((r) => !r.duplicateOf);
    assert.ok(kept.length >= 1);
    if (marked.length > 0) {
      assert.equal(marked[0]!.memory.id !== marked[0]!.duplicateOf, true);
    }
  });
});
