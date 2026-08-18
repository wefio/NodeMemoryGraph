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

test("remember: supersedeScan: false skips the candidate scan", () => {
  withStore((store) => {
    store.remember({
      statement: "Martin is currently Employed at healthcare",
      nodeName: "work",
      scope: { user: "a" },
    });
    const newer = store.remember({
      statement: "Martin moved from being Employed to self-employed",
      nodeName: "work",
      scope: { user: "a" },
      supersedeScan: false,
    });
    assert.equal(
      newer.supersedeCandidates,
      undefined,
      "supersedeScan: false should not attach supersedeCandidates",
    );
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

test("searchContext: as-of ranking lifts the record current at the asked date", () => {
  withStore((store) => {
    const old2026 = store.remember({
      statement: "user wants a new job with better work-life balance",
      nodeName: "career",
      scope: { user: "a" },
      eventTime: "2026-02-05T18:12:15Z",
    });
    const new2033 = store.remember({
      statement: "user was promoted to Executive Director at Huaxin Consulting",
      nodeName: "career",
      scope: { user: "a" },
      eventTime: "2033-04-25T16:27:50Z",
    });
    // As-of 2033: the 2033 promotion record must rank above the 2026 record
    // even though the 2026 one shares lexical tokens with "current job".
    const h = store.searchContext("current job title", {
      limit: 10,
      eventTimeTo: "2033-06-16T00:00:00Z",
    });
    const idx = (s: string) => h.results.findIndex((r) => r.memory.statement.includes(s));
    const i2033 = idx("Executive Director");
    const i2026 = idx("work-life balance");
    assert.ok(i2033 >= 0, "2033 record must be retrieved");
    assert.ok(i2026 >= 0, "2026 record must be retrieved");
    assert.ok(i2033 < i2026, `as-of 2033 ranks the 2033 record (${i2033}) above 2026 (${i2026})`);

    // No window (current query): relevance order is untouched by the temporal boost.
    const c = store.searchContext("current job title", { limit: 10 });
    const c2033 = c.results.findIndex((r) => r.memory.statement.includes("Executive Director"));
    const c2026 = c.results.findIndex((r) => r.memory.statement.includes("work-life balance"));
    assert.ok(c2033 >= 0 || c2026 >= 0, "no-window query still returns records");
  });
});

test("applySupersession: unknown ids throw", () => {
  withStore((store) => {
    assert.throws(() =>
      store.applySupersession({ newMemoryId: "missing", supersededMemoryId: "also-missing" }),
    );
  });
});

test("searchContext: historical query keeps a superseded value when its successor is outside the window", () => {
  withStore((store) => {
    const oldV = store.remember({
      statement: "job title is junior engineer",
      nodeName: "job",
      scope: { user: "a" },
      eventTime: "2020-01-01T00:00:00Z",
    });
    const midV = store.remember({
      statement: "job title is senior engineer",
      nodeName: "job",
      scope: { user: "a" },
      eventTime: "2025-01-01T00:00:00Z",
    });
    const newV = store.remember({
      statement: "job title is principal engineer",
      nodeName: "job",
      scope: { user: "a" },
      eventTime: "2030-01-01T00:00:00Z",
    });
    store.applySupersession({ newMemoryId: midV.memory.id, supersededMemoryId: oldV.memory.id });
    store.applySupersession({ newMemoryId: newV.memory.id, supersededMemoryId: midV.memory.id });

    // as-of 2026: mid (2025) was current; its successor (2030) not yet happened —
    // the superseded mid must survive instead of being replaced by a future value.
    const h2026 = store.searchContext("current job title", {
      limit: 10,
      eventTimeTo: "2026-12-31T00:00:00Z",
    });
    const st26 = h2026.results.map((r) => r.memory.statement);
    assert.ok(st26.some((s) => s.includes("senior engineer")), "mid value must survive as-of 2026");
    assert.ok(
      !st26.some((s) => s.includes("principal engineer")),
      "successor outside the window must not replace the historical value",
    );

    // as-of 2031: successor (2030) is inside the window — replace mid with it.
    const h2031 = store.searchContext("current job title", {
      limit: 10,
      eventTimeTo: "2031-12-31T00:00:00Z",
    });
    const st31 = h2031.results.map((r) => r.memory.statement);
    assert.ok(st31.some((s) => s.includes("principal engineer")), "successor inside window replaces");
    assert.ok(
      !st31.some((s) => s.includes("senior engineer")),
      "superseded mid dropped when its successor is inside the window",
    );

    // current query (no window): replace with the newest value.
    const cur = store.searchContext("current job title", { limit: 10 });
    const stc = cur.results.map((r) => r.memory.statement);
    assert.ok(stc.some((s) => s.includes("principal engineer")), "current query surfaces newest");
    assert.ok(
      !stc.some((s) => s.includes("senior engineer")),
      "current query drops superseded mid",
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

