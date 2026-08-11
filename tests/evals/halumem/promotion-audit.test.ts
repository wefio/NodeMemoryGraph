import assert from "node:assert/strict";
import test from "node:test";

import {
  exactUserEvidenceTurn,
  parsePromotionVotes,
} from "../../../evals/halumem/promotion-audit.ts";

const dialogue = [
  { role: "assistant", content: "You probably value quiet work." },
  { role: "user", content: "I value quiet work when I am writing." },
];

test("promotion votes require a known candidate and exact user evidence", () => {
  assert.deepEqual(
    parsePromotionVotes(
      JSON.stringify({
        votes: [
          {
            candidateId: "memory-1",
            outcome: "supported",
            evidence: "I value quiet work when I am writing.",
          },
        ],
      }),
      new Set(["memory-1"]),
      dialogue,
    ),
    [
      {
        candidateId: "memory-1",
        outcome: "supported",
        evidence: "I value quiet work when I am writing.",
      },
    ],
  );
  assert.throws(
    () =>
      parsePromotionVotes(
        JSON.stringify({
          votes: [
            {
              candidateId: "memory-1",
              outcome: "supported",
              evidence: "You probably value quiet work.",
            },
          ],
        }),
        new Set(["memory-1"]),
        dialogue,
      ),
    /not an exact user excerpt/u,
  );
});

test("origin evidence admission rejects assistant-only support", () => {
  assert.equal(exactUserEvidenceTurn(dialogue, "I value quiet work"), 1);
  assert.equal(exactUserEvidenceTurn(dialogue, "You probably value quiet work."), null);
});
