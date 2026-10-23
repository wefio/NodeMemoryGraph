// Contract tests for the frozen LoCoMo zero-LLM evaluation helpers. The
// probe scripts in evals/omnimemeval/research/audits/ must score through
// these helpers; a change here is a contract change and needs coordinator
// sign-off on the locomo-zero-llm-2026-10-23 channel.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildEligibilityManifest,
  coverage,
  evidenceTextFor,
  hitPositions,
  locomoUserKey,
  normalizeText,
  pairedComparison,
  sliceByCharBudget,
  splitEvidenceLabels,
} from "../../evals/omnimemeval/research/audits/locomo-audit-shared.ts";
import type { BenchmarkCase } from "../../evals/benchmarks/types.ts";

const item: BenchmarkCase = {
  id: "q1",
  benchmark: "LoCoMo",
  category: "1",
  question: "Where did Caroline move from?",
  reference: "Brazil",
  officialMetadata: { sampleId: "conv-3", category: 1 },
  evidenceIds: ["turn-a", "turn-b", "turn-missing"],
  sessions: [
    {
      id: "session_1",
      date: "May 18, 2021",
      turns: [
        {
          role: "user",
          speaker: "Caroline",
          content: "I moved from my home country.",
          sourceId: "turn-a",
        },
        { role: "assistant", speaker: "Melanie", content: "Where to?", sourceId: "turn-b" },
      ],
    },
  ],
};

describe("locomo-audit-shared", () => {
  it("normalizes case and whitespace", () => {
    assert.equal(normalizeText("  Caroline: I   moved\nfrom Home "), "caroline: i moved from home");
  });

  it("builds the ingested turn text map", () => {
    const map = evidenceTextFor(item);
    assert.equal(map.get("turn-a"), "caroline: i moved from my home country.");
    assert.equal(map.get("turn-missing"), undefined);
  });

  it("ranks hits, marks absent turns -1 and dataset-missing labels -2", () => {
    const positions = hitPositions(
      [{ content: "Caroline: I moved from my home country." }, { content: "Melanie: unrelated" }],
      item,
      evidenceTextFor(item),
    );
    assert.deepEqual(positions, [0, -1, -2]);
  });

  it("coverage excludes -2 rows from every denominator", () => {
    const rows = [
      { arm: [0, -1] },
      { arm: { hitPositions: [-1, -1] } },
      { arm: [0, 1] },
      { arm: [0, -1, -2] },
    ];
    const result = coverage(rows, "arm");
    assert.equal(result.n, 3);
    assert.equal(result.anyPct, 66.7);
    assert.equal(result.allPct, 33.3);
    assert.equal(result.recallPct, 50);
  });

  it("coverage returns null rates at n=0 instead of a percentage", () => {
    assert.deepEqual(coverage([{ arm: [0, -2] }], "arm"), {
      n: 0,
      anyPct: null,
      allPct: null,
      recallPct: null,
    });
    assert.deepEqual(coverage([], "arm"), { n: 0, anyPct: null, allPct: null, recallPct: null });
  });

  it("expands composite labels per the official rule (real LoCoMo shape)", () => {
    // Real failing case from review: conv-26:37 carries "D8:6; D9:17" and
    // BOTH turns exist — the pre-fix helper looked up the whole string and
    // mislabeled the question -2.
    const compositeItem: BenchmarkCase = {
      ...item,
      id: "conv-26:37",
      evidenceIds: ["D8:6; D9:17"],
      sessions: [
        {
          id: "session_8",
          turns: [
            { role: "user", speaker: "D", content: "first hop fact", sourceId: "D8:6" },
            { role: "user", speaker: "D", content: "second hop fact", sourceId: "D9:17" },
          ],
        },
      ],
    };
    assert.deepEqual(splitEvidenceLabels(["D8:6; D9:17"]), ["D8:6", "D9:17"]);
    const positions = hitPositions(
      [
        { content: "D: first hop fact" },
        { content: "D: filler" },
        { content: "D: second hop fact" },
      ],
      compositeItem,
      evidenceTextFor(compositeItem),
    );
    assert.deepEqual(positions, [0, 2]);
  });

  it("eligible set: composite labels resolve, missing turns exclude the question", () => {
    const ok: BenchmarkCase = { ...item, id: "q-ok", evidenceIds: ["turn-a", "turn-b"] };
    const broken: BenchmarkCase = {
      ...item,
      id: "q-broken",
      evidenceIds: ["turn-a", "not-in-conversation"],
    };
    const manifest = buildEligibilityManifest([ok, broken]);
    assert.deepEqual(manifest.eligibleIds, ["q-ok"]);
    assert.deepEqual(manifest.excluded, [
      { id: "q-broken", missingLabels: ["not-in-conversation"] },
    ]);
    assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
  });

  it("result keys follow the audit's dataset-index convention, not sample_id", () => {
    assert.equal(locomoUserKey(3), "locomo_exp_user_3");
  });

  it("paired comparison scores both sides on one shared eligible denominator", () => {
    const rows = [
      { id: "q-ok", baseline: [0, -1], arm: [0, 1] },
      { id: "q2", baseline: [0, 1], arm: [-1, -1] },
      { id: "q-excluded", baseline: [0], arm: [0, -2] },
      { id: "q-not-eligible", baseline: [0], arm: [0] },
    ];
    const eligible = new Set(["q-ok", "q2"]);
    const result = pairedComparison(rows, "baseline", "arm", eligible);
    assert.equal(result.n, 2);
    assert.equal(result.allPct, 50);
    assert.equal(result.wins, 1);
    assert.equal(result.losses, 1);
    assert.equal(result.ties, 0);
  });

  it("text-budget slice keeps the first item and stops at the budget", () => {
    const memories = [{ content: "aaaa" }, { content: "bbbbbb" }, { content: "cc" }];
    assert.deepEqual(
      sliceByCharBudget(memories, 10).map((m) => m.content),
      ["aaaa", "bbbbbb"],
    );
    assert.deepEqual(
      sliceByCharBudget(memories, 3).map((m) => m.content),
      ["aaaa"],
    );
    assert.deepEqual(sliceByCharBudget(memories, 0), []);
  });
});
