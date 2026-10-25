import assert from "node:assert/strict";
import test from "node:test";
import {
  MEMORY_EMBEDDING_REPRESENTATION,
  memoryEmbeddingModelId,
  memoryEmbeddingText,
} from "../../src/core/store/search-ranking.ts";

test("without context the representation is the plain statement", () => {
  // The node name is not embedded: measured on LoCoMo through the product path,
  // carrying `Conversation batch-<hash>` in the vector text cost 4-5pp of recall.
  assert.equal(memoryEmbeddingText("I started swimming."), "I started swimming.");
  assert.equal(memoryEmbeddingText("x", {}), "x");
  assert.equal(memoryEmbeddingText("x", { eventTime: "", previousTurn: "  " }), "x");
});

test("the event day is prefixed, and only the day is used", () => {
  assert.equal(
    memoryEmbeddingText("I started swimming.", { eventTime: "2023-01-20T16:04:00+00:00" }),
    "2023-01-20 I started swimming.",
  );
  // A bare date passes through; an unreadable value contributes nothing rather
  // than an arbitrary string.
  assert.equal(memoryEmbeddingText("x", { eventTime: "2023-01-20" }), "2023-01-20 x");
  assert.equal(memoryEmbeddingText("x", { eventTime: "not a date" }), "x");
});

test("the previous turn is appended on its own line and bounded", () => {
  assert.equal(
    memoryEmbeddingText("I stopped going.", { previousTurn: "When did you take up swimming?" }),
    "I stopped going.\nprevious: When did you take up swimming?",
  );
  const long = "y".repeat(400);
  const text = memoryEmbeddingText("x", { previousTurn: long });
  assert.equal(text.endsWith("…"), true);
  assert.equal(text.length < long.length, true);
  assert.equal(memoryEmbeddingText("x", { previousTurn: "a\n\n  b" }), "x\nprevious: a b");
});

test("both parts together keep the date first and the turn last", () => {
  assert.equal(
    memoryEmbeddingText("I stopped going.", {
      eventTime: "2023-05-12T09:00:00Z",
      previousTurn: "So you still swim every week?",
    }),
    "2023-05-12 I stopped going.\nprevious: So you still swim every week?",
  );
});

test("the stored vector identity carries the representation version", () => {
  // A changed text under an unchanged id would leave stale vectors in place,
  // because the indexer only re-embeds rows whose model id is missing.
  const id = memoryEmbeddingModelId("nmg-hashing-v1");
  assert.equal(id, `nmg-hashing-v1@${MEMORY_EMBEDDING_REPRESENTATION}`);
  assert.notEqual(id, "nmg-hashing-v1");
});

test("unpaired surrogates are replaced so the text stays encodable", () => {
  // A lone surrogate cannot be encoded as UTF-8; an embedding tokenizer rejects
  // it and (measured on LongMemEval) fails the whole merged batch.
  const text = memoryEmbeddingText("bad \uD800 value", { eventTime: "2023-05-27T10:00:00Z" });
  assert.equal(text.includes("\uD800"), false);
  assert.equal(text, "2023-05-27 bad \uFFFD value");
  assert.doesNotThrow(() => Buffer.from(text, "utf8").toString("utf8"));
});

test("well-formed surrogate pairs survive sanitising", () => {
  const text = memoryEmbeddingText("emoji \u{1F600} kept");
  assert.equal(text, "emoji \u{1F600} kept");
});

test("unpaired surrogates in the previous turn are replaced too", () => {
  // The corpus text that actually broke the tokenizer sat in the previous-turn
  // segment, so sanitising only the statement was not enough.
  const text = memoryEmbeddingText("continue", {
    eventTime: "2023-05-27T10:00:00Z",
    previousTurn: "thanks \uD800",
  });
  assert.equal(text, "2023-05-27 continue\nprevious: thanks \uFFFD");
  assert.doesNotThrow(() => Buffer.from(text, "utf8").toString("utf8"));
});
