// Guard tests for the exact loss decomposition (loss-decomposition.ts).
// These pin the definitions that make the numbers reproducible: dedup vs
// path-sum, exact oracle feasibility under both budgets, call counting, and the
// rescue-locus classification. Gold is used for scoring decisions only.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  armInputCandidates,
  callCount,
  candidateUnion,
  classifyRescue,
  oracleCoverage,
  pathSum,
  recordedPaths,
  rescueLocusDelta,
  scaleOf,
  type RawPaths,
  type RescueLocusEntry,
} from "../../evals/omnimemeval/research/audits/loss-decomposition.ts";
import { buildConversation } from "../../evals/omnimemeval/research/audits/static-neighbor-recall.ts";
import type { BenchmarkCase } from "../../evals/benchmarks/types.ts";
import { normalizeText } from "../../evals/omnimemeval/research/audits/locomo-audit-shared.ts";

const cand = (content: string, id?: string) => ({ content, ...(id ? { id } : {}) });

describe("candidate union and path sum", () => {
  it("deduplicates by normalized content across every path", () => {
    const paths: RawPaths = {
      A: [cand("Alice: one"), cand("Bob: two")],
      B_full: [cand("  alice:   ONE  "), cand("Cat: three")],
      derived20: [[cand("Bob: two")], [cand("Dan: four")]],
      derived100: [[cand("Cat: three"), cand("Eve: five")]],
    };
    const union = candidateUnion(paths);
    assert.deepEqual(union, [
      normalizeText("Alice: one"),
      normalizeText("Bob: two"),
      normalizeText("Cat: three"),
      normalizeText("Dan: four"),
      normalizeText("Eve: five"),
    ]);
    // path-sum keeps every returned record, including repeats.
    assert.equal(pathSum(paths), 2 + 2 + 1 + 1 + 2);
    assert.equal(recordedPaths(paths).length, 2 + 2 + 1);
  });

  it("ignores empty content and preserves first-seen order", () => {
    const paths: RawPaths = { A: [cand(""), cand("first")], B_full: [cand("second")] };
    assert.deepEqual(candidateUnion(paths), ["first", "second"]);
  });
});

describe("call counting", () => {
  it("counts one original query plus one call per derived clause actually run", () => {
    assert.equal(callCount({ derived20: [] }), 1);
    assert.equal(callCount({ derived20: [[], []] }), 3);
    assert.equal(callCount({}), 1);
  });
});

describe("exact oracle feasibility", () => {
  const evidenceText = new Map<string, string>([
    ["t1", normalizeText("Alice: I moved from Brazil")],
    ["t2", normalizeText("Bob: when was that")],
  ]);

  it("is feasible when cheap covering records fit slots and characters", () => {
    const result = oracleCoverage(
      ["t1", "t2"],
      evidenceText,
      [normalizeText("Alice: I moved from Brazil"), normalizeText("Bob: when was that")],
      20,
      1000,
    );
    assert.equal(result.feasible, true);
    assert.equal(result.coveringRecords, 2);
    assert.equal(result.budgetBlocked, false);
  });

  it("reports the label as missing when no candidate contains it", () => {
    const result = oracleCoverage(
      ["t1", "t2"],
      evidenceText,
      [normalizeText("unrelated")],
      20,
      1000,
    );
    assert.equal(result.feasible, false);
    assert.deepEqual(result.missingLabels.sort(), ["t1", "t2"]);
  });

  it("is blocked by the slot budget", () => {
    const result = oracleCoverage(
      ["t1", "t2"],
      evidenceText,
      [normalizeText("Alice: I moved from Brazil"), normalizeText("Bob: when was that")],
      1,
      1000,
    );
    assert.equal(result.feasible, false);
    assert.equal(result.budgetBlocked, true);
    assert.equal(result.coveringRecords, 2);
  });

  it("is blocked by the character budget", () => {
    const result = oracleCoverage(
      ["t1"],
      evidenceText,
      [normalizeText("Alice: I moved from Brazil")],
      20,
      3,
    );
    assert.equal(result.feasible, false);
    assert.equal(result.budgetBlocked, true);
  });

  it("picks the cheapest covering record per label, not the first", () => {
    const long = normalizeText("prefix ".repeat(30) + "Alice: I moved from Brazil");
    const short = normalizeText("Alice: I moved from Brazil");
    const result = oracleCoverage(["t1"], evidenceText, [long, short], 20, 1000);
    assert.equal(result.coveringCharacters, short.length);
  });

  it("is exact under gold isolation: labels only select records, never generate them", () => {
    const candidates = [normalizeText("Alice: I moved from Brazil")];
    const withLabels = oracleCoverage(["t1"], evidenceText, candidates, 20, 1000);
    const withoutLabels = oracleCoverage([], evidenceText, candidates, 20, 1000);
    // Candidate set is untouched by either call; only the verdict differs.
    assert.equal(candidates.length, 1);
    assert.equal(withLabels.coveringRecords, 1);
    assert.equal(withoutLabels.coveringRecords, 0);
    assert.equal(withoutLabels.feasible, true);
  });
});

describe("rescue locus delta between arms", () => {
  const entry = (
    arm: string,
    caliber: string,
    counts: [number, number, number],
  ): RescueLocusEntry => ({
    arm,
    caliber,
    counts: {
      "original-pool-tail": counts[0],
      "other-path-unselected": counts[1],
      "outside-all-paths": counts[2],
    },
  });

  it("reports per-bucket differences at the matching caliber only", () => {
    const entries = [
      entry("C2", "question-level", [4, 3, 16]),
      entry("E", "question-level", [4, 4, 17]),
      entry("C2", "label-level", [5, 3, 16]),
      entry("E", "label-level", [5, 4, 17]),
    ];
    const delta = rescueLocusDelta(entries, "E", "C2");
    assert.deepEqual(delta, [
      {
        caliber: "question-level",
        delta: { "original-pool-tail": 0, "other-path-unselected": 1, "outside-all-paths": 1 },
      },
      {
        caliber: "label-level",
        delta: { "original-pool-tail": 0, "other-path-unselected": 1, "outside-all-paths": 1 },
      },
    ]);
  });

  it("treats a missing baseline arm as zero rather than throwing", () => {
    const delta = rescueLocusDelta([entry("E", "question-level", [2, 1, 3])], "E", "C2");
    assert.deepEqual(delta[0]!.delta, {
      "original-pool-tail": 2,
      "other-path-unselected": 1,
      "outside-all-paths": 3,
    });
  });
});

describe("candidate scale quantiles", () => {
  it("uses the repository's nearest-rank convention", () => {
    // 1..10: p25 => ceil(10*0.25)-1 = index 2 => 3; p50 => index 4 => 5; p75 => index 7 => 8.
    const scale = scaleOf([10, 1, 9, 2, 8, 3, 7, 4, 6, 5]);
    assert.deepEqual(scale, { mean: 5.5, p25: 3, p50: 5, p75: 8, max: 10 });
  });

  it("returns zeros for an empty sample instead of NaN", () => {
    assert.deepEqual(scaleOf([]), { mean: 0, p25: 0, p50: 0, p75: 0, max: 0 });
  });
});

describe("arm input candidate sets", () => {
  const fixture: BenchmarkCase = {
    id: "q1",
    benchmark: "LoCoMo",
    category: "1",
    question: "Where did Ada move?",
    reference: "Brazil",
    officialMetadata: { sampleId: "conv-x", category: 1 },
    evidenceIds: ["t0"],
    sessions: [
      {
        id: "session_1",
        turns: [
          { role: "user", speaker: "Ada", content: "I moved from Brazil.", sourceId: "t0" },
          { role: "assistant", speaker: "Bob", content: "Nice.", sourceId: "t1" },
          { role: "user", speaker: "Ada", content: "It was warm there.", sourceId: "t2" },
        ],
      },
    ],
  };
  const conversation = buildConversation(fixture);

  it("arm E input keeps its own page and adds the neighbourhood, deduplicated", () => {
    // The page holds only the unrelated turn; the gold turn is a neighbour.
    const paths: RawPaths = { D100max: [cand("Bob: Nice.")], A: [cand("Bob: Nice.")] };
    const sets = armInputCandidates(paths, conversation);
    assert.deepEqual(sets.page, [normalizeText("Bob: Nice.")]);
    assert.ok(sets.E.includes(normalizeText("Ada: I moved from Brazil.")), "E gains the neighbour");
    assert.ok(sets.E.includes(normalizeText("Bob: Nice.")), "E keeps its own page");
    assert.equal(new Set(sets.E).size, sets.E.length, "E must be duplicate-free");
    assert.ok(sets.E.length > sets.page.length);
  });

  it("each arm keeps its own starting page record", () => {
    const paths: RawPaths = { D100max: [cand("Bob: Nice.")], A: [cand("Ada: It was warm there.")] };
    const sets = armInputCandidates(paths, conversation);
    assert.deepEqual(sets.page, [normalizeText("Bob: Nice.")]);
    // Arm E starts from the fused page; C2 starts from arm A. Both keep their
    // own seed even though the ±2 neighbourhoods overlap on this tiny fixture.
    assert.ok(sets.E.includes(normalizeText("Bob: Nice.")), "E keeps the D100max seed");
    assert.ok(sets.C2.includes(normalizeText("Ada: It was warm there.")), "C2 keeps the A seed");
  });

  it("the oracle sees a gold turn only reachable through the neighbourhood", () => {
    const paths: RawPaths = { A: [cand("Bob: Nice.")], D100max: [cand("Bob: Nice.")] };
    const sets = armInputCandidates(paths, conversation);
    const evidenceText = new Map([["t0", normalizeText("Ada: I moved from Brazil.")]]);
    assert.equal(oracleCoverage(["t0"], evidenceText, sets.page, 20, 1000).feasible, false);
    assert.equal(oracleCoverage(["t0"], evidenceText, sets.E, 20, 1000).feasible, true);
  });
});

describe("rescue locus classification", () => {
  const evidence = normalizeText("Alice: I moved from Brazil");

  it("records a turn sitting beyond the page in the original pool as pool-tail", () => {
    const pool = Array.from({ length: 25 }, (_, i) => normalizeText(`filler ${i}`));
    pool[22] = evidence;
    assert.equal(classifyRescue(evidence, pool, pool, 20), "original-pool-tail");
  });

  it("records a turn only in another path's output as other-path-unselected", () => {
    const pool = [normalizeText("filler")];
    assert.equal(classifyRescue(evidence, pool, [...pool, evidence], 20), "other-path-unselected");
  });

  it("records a turn absent from every recorded path as outside-all-paths", () => {
    const pool = [normalizeText("filler")];
    assert.equal(classifyRescue(evidence, pool, pool, 20), "outside-all-paths");
  });
});
