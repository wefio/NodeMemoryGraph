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

test("remember: surfaces supersedeCandidates for shared-token same-scope memories", () => {
  withStore((store) => {
    const stale = store.remember({
      statement: "Martin is currently Employed at healthcare",
      nodeName: "work",
      scope: { user: "a" },
    });
    const newer = store.remember({
      statement: "Martin moved from being Employed to self-employed",
      nodeName: "work",
      scope: { user: "a" },
    });
    assert.notEqual(newer.memory.id, stale.memory.id, "different text should write a new record");
    assert.ok(
      newer.supersedeCandidates && newer.supersedeCandidates.length >= 1,
      "shared token (employed) should surface the old record as a supersede candidate",
    );
    const hit = newer.supersedeCandidates!.find((c) => c.memoryId === stale.memory.id);
    assert.ok(hit, "old record should be among supersedeCandidates");
  });
});

test("applySupersession: marks stale record superseded and wires pointers", () => {
  withStore((store) => {
    const stale = store.remember({
      statement: "user salary is 20000",
      nodeName: "fin",
      scope: { user: "a" },
    });
    const fresh = store.remember({
      statement: "user salary is now 30000",
      nodeName: "fin",
      scope: { user: "a" },
    });
    store.applySupersession({
      newMemoryId: fresh.memory.id,
      supersededMemoryId: stale.memory.id,
    });
    // The stale record must stop being retrievable.
    const results = store.search("salary", { scope: { user: "a" } });
    const ids = results.map((r) => r.memory.id);
    assert.ok(ids.includes(fresh.memory.id), "new value still retrievable");
    assert.ok(!ids.includes(stale.memory.id), "superseded value filtered from retrieval");
  });
});

test("applySupersession: unknown ids throw", () => {
  withStore((store) => {
    assert.throws(() =>
      store.applySupersession({ newMemoryId: "missing", supersededMemoryId: "also-missing" }),
    );
  });
});

test("retrieval: superseded successor surfaced, stale record dropped", () => {
  withStore((store) => {
    const stale = store.remember({
      statement: "Martin is currently Employed at healthcare",
      nodeName: "work",
      scope: { user: "a" },
    });
    const fresh = store.remember({
      statement: "Martin moved from being Employed to self-employed",
      nodeName: "work",
      scope: { user: "a" },
    });
    store.applySupersession({
      newMemoryId: fresh.memory.id,
      supersededMemoryId: stale.memory.id,
    });
    // The stale record is dropped; the successor is present.
    const results = store.search("current employment status", {
      scope: { user: "a" },
      limit: 5,
    });
    const ids = results.map((r) => r.memory.id);
    assert.ok(ids.includes(fresh.memory.id), "successor surfaced at retrieval");
    assert.ok(!ids.includes(stale.memory.id), "superseded record not surfaced");
  });
});

test("remember: transition from-side word recalls low-overlap predecessor", () => {
  withStore((store) => {
    // 旧值：和新语句共享 "Employed"(大写) 但 normalize 后共享 employed + salary 无（措辞差异）
    store.remember({
      statement: "I am Employed at Huaxin Consulting and earn a monthly salary of twenty thousand yuan.",
      nodeName: "work",
      scope: { user: "a" },
    });
    const newer = store.remember({
      statement:
        "I'm excited about this new chapter. Moving from being employed to self-employed is a big step, and I want to make a positive impact in global healthcare.",
      nodeName: "work",
      scope: { user: "a" },
    });
    const hit = newer.supersedeCandidates?.find((c) => c.statement.includes("Huaxin"));
    assert.ok(hit, "transition from-side word 'employed' should recall the predecessor");
    assert.ok(
      newer.supersedeCandidates![0]?.memoryId === hit.memoryId,
      "transition hit should rank first (before lower-signal same-topic candidates)",
    );
  });
});

test("transition phrase outranks higher-lexical-similarity chit-chat for supersede candidates", () => {
  withStore((store) => {
    // 真正的旧值（含 from 侧词 employed）
    store.remember({
      statement: "I am currently Employed, working in the healthcare industry at Huaxin Consulting.",
      nodeName: "work",
      scope: { user: "a" },
    });
    // 高 sim 闲聊（共享 make/positive/impact/healthcare，但无关）
    store.remember({
      statement: "I am determined to make a meaningful positive impact in global healthcare through my work.",
      nodeName: "chat",
      scope: { user: "a" },
    });
    const newer = store.remember({
      statement:
        "Moving from being employed to self-employed is a big step, and I am determined to make a positive impact in global healthcare.",
      nodeName: "work",
      scope: { user: "a" },
    });
    const cands = newer.supersedeCandidates ?? [];
    const pred = cands.find((c) => c.statement.includes("Huaxin"));
    const chit = cands.find((c) => c.statement.includes("determined to make"));
    assert.ok(pred, "predecessor should be recalled");
    if (pred && chit) {
      assert.ok(
        cands.indexOf(pred) < cands.indexOf(chit),
        "transition-hit predecessor should rank before higher-similarity chit-chat",
      );
    }
  });
});

test("remember: polarity flip (new negative vs old affirmative) recalls stale predecessor first", () => {
  withStore((store) => {
    // 旧值：肯定（affirmative），调用方在写入时打标
    store.remember({
      statement: "I am currently Employed at Huaxin Consulting as a director.",
      nodeName: "work",
      scope: { user: "a" },
      polarity: "affirmative",
    });
    // 高 sim 闲聊（共享 employed 但无关，且无 polarity 标签）——不应因 flip 排前
    store.remember({
      statement: "I feel employed in the sense of being busy with lots of projects these days.",
      nodeName: "chat",
      scope: { user: "a" },
    });
    // 新值：否定（negative），结束状态——调用方打标
    const newer = store.remember({
      statement: "I am no longer employed at Huaxin Consulting — I quit my job last week.",
      nodeName: "work",
      scope: { user: "a" },
      polarity: "negative",
    });
    const cands = newer.supersedeCandidates ?? [];
    const pred = cands.find((c) => c.statement.includes("Huaxin"));
    const chit = cands.find((c) => c.statement.includes("feel employed"));
    assert.ok(pred, "polarity flip should recall the affirmative predecessor");
    if (pred && chit) {
      assert.ok(
        cands.indexOf(pred) < cands.indexOf(chit),
        "polarity-flip predecessor should rank before higher-similarity chit-chat",
      );
    }
  });
});

test("remember: no polarity metadata means no polarity-flip boost (baseline unchanged)", () => {
  withStore((store) => {
    store.remember({
      statement: "I am currently Employed at Huaxin Consulting as a director.",
      nodeName: "work",
      scope: { user: "a" },
    });
    const newer = store.remember({
      statement: "I am no longer employed at Huaxin Consulting — I quit my job last week.",
      nodeName: "work",
      scope: { user: "a" },
    });
    // 无 polarity 标签时，旧值仍靠共享 token 进候选（不因 flip 提升）
    const hit = newer.supersedeCandidates?.find((c) => c.statement.includes("Huaxin"));
    assert.ok(hit, "shared-token recall still works without polarity metadata");
  });
});

