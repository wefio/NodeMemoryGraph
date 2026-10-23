// Guard tests for the arm E combo probe (preregistration:
// docs/experiments/benchmarks/locomo-arm-e-preregistration-2026-10-23.zh-CN.md).
// Guards: gold isolation, session boundary, ambiguous-anchor counting, exact
// budget slicing, and D100max-baseline resolution semantics.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BenchmarkCase } from "../../evals/benchmarks/types.ts";
import { buildConversation } from "../../evals/omnimemeval/research/audits/static-neighbor-recall.ts";
import {
  buildArmE,
  resolveBaselineTurns,
  type D100Entry,
  type EParams,
} from "../../evals/omnimemeval/research/audits/static-arm-e-recall.ts";

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

const E_PARAMS: EParams = { anchorCount: 5, radius: 2, keepBaseline: 10, capacity: 20 };

describe("arm E baseline resolution", () => {
  it("resolves D100max entries back to turns, raw first then normalized", () => {
    const entries: D100Entry[] = [
      { content: ingested("turn-0") },
      { content: ingested("turn-3") }, // multi-line turn as one entry
      { content: `  ${ingested("turn-5").toUpperCase()}  ` }, // normalized fallback
      { content: "Totally unrelated memory text" },
    ];
    const resolved = resolveBaselineTurns(entries, conversation);
    assert.deepEqual(
      resolved.refs.map((ref) => ref?.sourceId ?? null),
      ["turn-0", "turn-3", "turn-5", null],
    );
    assert.equal(resolved.unresolved, 1);
    assert.equal(resolved.ambiguous, 0);
  });

  it("counts ambiguous entries when duplicate texts map to distinct turns", () => {
    // Same normalized text exists twice in the conversation → first occurrence
    // wins (deterministic) but the entry is flagged ambiguous.
    const dupCase: BenchmarkCase = {
      ...conversationCase(),
      sessions: [
        {
          id: "session_1",
          turns: [
            { role: "user", speaker: "Ada", content: "Same line", sourceId: "dup-a" },
            { role: "user", speaker: "Ada", content: "Same line", sourceId: "dup-b" },
          ],
        },
      ],
    };
    const dupConversation = buildConversation(dupCase);
    const resolved = resolveBaselineTurns([{ content: "Ada: Same line" }], dupConversation);
    assert.equal(resolved.refs[0]?.sourceId, "dup-a");
    assert.equal(resolved.ambiguous, 1);
    assert.equal(resolved.unresolved, 0);
  });
});

describe("arm E construction", () => {
  it("fuses D100max prefix with same-session neighbors under the fixed rules", () => {
    const entries: D100Entry[] = [
      { content: ingested("turn-0") },
      { content: ingested("turn-1") },
      { content: ingested("turn-2") },
    ];
    const arm = buildArmE(entries, conversation, E_PARAMS);
    // Anchors: turn-0..2 (first 5 resolvable, only 3 exist). Excluded keys =
    // resolved refs within keepBaseline=10 → all three. Pool from ±2:
    // turn-3, turn-4 (cross-session turn-5/6 excluded by session boundary).
    assert.deepEqual(
      arm.anchors.map((turn) => turn.sourceId),
      ["turn-0", "turn-1", "turn-2"],
    );
    assert.deepEqual(
      arm.pool.map((turn) => turn.sourceId),
      ["turn-3", "turn-4"],
    );
    // Fusion: round-robin kept prefix (3) with pool (2), tail empty → 5 items.
    assert.deepEqual(arm.contents, [
      ingested("turn-0"),
      ingested("turn-3"),
      ingested("turn-1"),
      ingested("turn-4"),
      ingested("turn-2"),
    ]);
    assert.ok(arm.contents.length <= E_PARAMS.capacity);
  });

  it("gold isolation: identical arms with and without evidence labels present", () => {
    const entries: D100Entry[] = [{ content: ingested("turn-1") }, { content: ingested("turn-5") }];
    const withGold = buildArmE(
      entries,
      buildConversation(conversationCase()),
      E_PARAMS,
    ).contents.join("\u0000");
    const stripped = conversationCase();
    delete stripped.evidenceIds;
    const withoutGold = buildArmE(entries, buildConversation(stripped), E_PARAMS).contents.join(
      "\u0000",
    );
    assert.equal(withGold, withoutGold);
  });

  it("is byte-identical across runs (determinism)", () => {
    const entries: D100Entry[] = [
      { content: ingested("turn-0") },
      { content: ingested("turn-1") },
      { content: ingested("turn-5") },
    ];
    const first = buildArmE(entries, conversation, E_PARAMS);
    const second = buildArmE(entries, conversation, E_PARAMS);
    assert.deepEqual(first, second);
  });
});
