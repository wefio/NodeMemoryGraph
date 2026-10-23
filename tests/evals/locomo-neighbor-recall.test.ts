// Boundary/mechanism tests for the session-adjacency probe (P2). These test
// the pure construction functions only — scoring goes through the frozen
// contract in locomo-audit-shared.ts (tested separately). Determinism is a
// hard requirement: same inputs must yield byte-identical arms.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BenchmarkCase } from "../../evals/benchmarks/types.ts";
import {
  buildConversation,
  buildNeighborArm,
  DEFAULT_NEIGHBOR_PARAMS,
  expandNeighbors,
  fuseNeighborArm,
  reconstructBaseline,
  selectAnchors,
} from "../../evals/omnimemeval/research/audits/static-neighbor-recall.ts";

function conversationCase(): BenchmarkCase {
  return {
    id: "q1",
    benchmark: "LoCoMo",
    category: "1",
    question: "What happened next?",
    reference: "answer",
    officialMetadata: { sampleId: "conv-t", category: 1 },
    evidenceIds: ["turn-0"],
    sessions: [
      {
        id: "session_1",
        turns: [
          {
            role: "user",
            speaker: "Ada",
            content: "I won the hackathon yesterday.",
            sourceId: "turn-0",
          },
          {
            role: "assistant",
            speaker: "Bob",
            content: "Congrats! Which track?",
            sourceId: "turn-1",
          },
          {
            role: "user",
            speaker: "Ada",
            content: "The sustainability track.",
            sourceId: "turn-2",
          },
          {
            role: "user",
            speaker: "Ada",
            content: "next line one\nnext line two",
            sourceId: "turn-3",
          },
          { role: "assistant", speaker: "Bob", content: "Amazing.", sourceId: "turn-4" },
        ],
      },
      {
        id: "session_2",
        turns: [
          {
            role: "user",
            speaker: "Ada",
            content: "Back to the prize money question.",
            sourceId: "turn-5",
          },
          { role: "assistant", speaker: "Bob", content: "How much was it?", sourceId: "turn-6" },
        ],
      },
    ],
  };
}

const conversation = buildConversation(conversationCase());
const ingested = (sourceId: string): string => {
  const turn = [...conversation.sessions.flat()].find(
    (candidate) => candidate.sourceId === sourceId,
  );
  assert.ok(turn, `fixture missing ${sourceId}`);
  return turn.ingested;
};

describe("static-neighbor-recall reconstruction", () => {
  it("resolves single-line and multi-line context segments back to turns", () => {
    const context = [
      ingested("turn-0"),
      ingested("turn-1"),
      ingested("turn-3"),
      ingested("turn-4"),
    ].join("\n");
    const baseline = reconstructBaseline(context, conversation);
    assert.equal(baseline.unmapped, 0);
    assert.deepEqual(
      baseline.refs.map((ref) => ref?.sourceId ?? null),
      ["turn-0", "turn-1", "turn-3", "turn-4"],
    );
    assert.equal(baseline.contents[2], ingested("turn-3"));
  });

  it("keeps unresolvable segments verbatim with a null ref", () => {
    const baseline = reconstructBaseline(
      `${ingested("turn-0")}\nTotally unknown speaker line`,
      conversation,
    );
    assert.equal(baseline.unmapped, 1);
    assert.equal(baseline.refs[0]?.sourceId, "turn-0");
    assert.equal(baseline.refs[1], null);
    assert.equal(baseline.contents[1], "Totally unknown speaker line");
  });

  it("normalizes whitespace-only differences via the normalized fallback", () => {
    const baseline = reconstructBaseline(`  ${ingested("turn-0").toUpperCase()}  `, conversation);
    assert.equal(baseline.refs[0]?.sourceId, "turn-0");
  });
});

describe("static-neighbor-recall anchors and expansion", () => {
  it("selects the earliest resolvable ranks as anchors and dedupes repeats", () => {
    const baseline = reconstructBaseline(
      [ingested("turn-1"), ingested("turn-0"), ingested("turn-1")].join("\n"),
      conversation,
    );
    const anchors = selectAnchors(baseline.refs, 5);
    assert.deepEqual(
      anchors.map((turn) => turn.sourceId),
      ["turn-1", "turn-0"],
    );
  });

  it("expands ±radius within the session, nearest first, backward before forward", () => {
    const anchors = selectAnchors(reconstructBaseline(ingested("turn-2"), conversation).refs, 1);
    const pool = expandNeighbors(anchors, conversation, 2, new Set());
    // turn-2 neighbors at distance 1: turn-1 (−) and turn-3 (+);
    // at distance 2: turn-0 (−) and turn-4 (+).
    assert.deepEqual(
      pool.map((turn) => turn.sourceId),
      ["turn-1", "turn-3", "turn-0", "turn-4"],
    );
  });

  it("never crosses a session boundary", () => {
    const anchors = selectAnchors(reconstructBaseline(ingested("turn-6"), conversation).refs, 1);
    const pool = expandNeighbors(anchors, conversation, 2, new Set());
    assert.deepEqual(
      pool.map((turn) => turn.sourceId),
      ["turn-5"],
    );
  });

  it("skips excluded turns (kept baseline prefix) and dedupes across anchors", () => {
    const anchors = selectAnchors(
      reconstructBaseline([ingested("turn-1"), ingested("turn-2")].join("\n"), conversation).refs,
      5,
    );
    // In real usage anchors sit inside the kept baseline prefix, so their
    // keys are excluded exactly like any other already-retrieved turn.
    const excluded = new Set(["t:0:1", "t:0:2"]);
    const pool = expandNeighbors(anchors, conversation, 1, excluded);
    // anchor turn-1: turn-0 kept, turn-2 excluded;
    // anchor turn-2: turn-1 excluded, turn-3 added.
    assert.deepEqual(
      pool.map((turn) => turn.sourceId),
      ["turn-0", "turn-3"],
    );
  });
});

describe("static-neighbor-recall fusion", () => {
  it("round-robins kept baseline with neighbors, then fills the tail, capped at capacity", () => {
    const context = ["turn-0", "turn-1", "turn-2", "turn-3", "turn-4"]
      .map((id) => ingested(id))
      .join("\n");
    const baseline = reconstructBaseline(context, conversation);
    const anchors = selectAnchors(baseline.refs, 2); // turn-0, turn-1
    const pool = expandNeighbors(anchors, conversation, 2, new Set([`t:0:0`, `t:0:1`]));
    // pool: turn-2, turn-3 (from turn-0), turn-2 skipped dup, turn-3 dup → turn-2, turn-3
    const fused = fuseNeighborArm(baseline, pool, {
      anchorCount: 2,
      radius: 2,
      keepBaseline: 3,
      capacity: 6,
    });
    // Round-robin: turn-0 | pool turn-2 | turn-1 | pool turn-3 | turn-2 (dup,
    // skipped — already fused as a neighbor) → pool exhausted → tail turn-3
    // (dup, skipped), turn-4. Capacity 6 not reached because dedupe removed
    // two entries — membership is duplicate-free, never padded.
    assert.deepEqual(fused, [
      ingested("turn-0"),
      ingested("turn-2"),
      ingested("turn-1"),
      ingested("turn-3"),
      ingested("turn-4"),
    ]);
  });

  it("never exceeds capacity and never duplicates a turn", () => {
    const context = ["turn-0", "turn-1", "turn-2", "turn-3", "turn-4"]
      .map((id) => ingested(id))
      .join("\n");
    const baseline = reconstructBaseline(context, conversation);
    const anchors = selectAnchors(baseline.refs, 5);
    const pool = expandNeighbors(anchors, conversation, 2, new Set());
    const fused = fuseNeighborArm(baseline, pool, {
      anchorCount: 5,
      radius: 2,
      keepBaseline: 10,
      capacity: 20,
    });
    assert.ok(fused.length <= 20);
    assert.equal(new Set(fused).size, fused.length, "fused list must be duplicate-free");
  });

  it("keeps the full baseline when the pool is empty", () => {
    const context = ["turn-0", "turn-1", "turn-2"].map((id) => ingested(id)).join("\n");
    const baseline = reconstructBaseline(context, conversation);
    const fused = fuseNeighborArm(baseline, [], DEFAULT_NEIGHBOR_PARAMS);
    assert.deepEqual(fused, [ingested("turn-0"), ingested("turn-1"), ingested("turn-2")]);
  });
});

describe("static-neighbor-recall determinism", () => {
  it("buildNeighborArm is byte-identical across runs", () => {
    const context = ["turn-0", "turn-1", "turn-3", "turn-5"].map((id) => ingested(id)).join("\n");
    const first = buildNeighborArm(context, conversation, DEFAULT_NEIGHBOR_PARAMS);
    const second = buildNeighborArm(context, conversation, DEFAULT_NEIGHBOR_PARAMS);
    assert.deepEqual(first, second);
    assert.ok(first.contents.length <= DEFAULT_NEIGHBOR_PARAMS.capacity);
    assert.equal(first.baseline.unmapped, 0);
    assert.ok(first.anchors.length <= DEFAULT_NEIGHBOR_PARAMS.anchorCount);
  });
});
