import assert from "node:assert/strict";
import test from "node:test";

import { assessMemoryWrite } from "./write-policy.ts";

test("blocks credential-like values before semantic memory storage", () => {
  assert.deepEqual(
    assessMemoryWrite({
      statement: "The API key is sk-test-nmg-123456",
      memoryType: "fact",
    }),
    { allowed: false, reason: "secret" },
  );
});

test("blocks explicitly temporary instructions but permits durable preferences", () => {
  assert.equal(
    assessMemoryWrite({
      statement: "For this response only, answer briefly.",
      memoryType: "preference",
    }).allowed,
    false,
  );
  assert.equal(
    assessMemoryWrite({
      statement: "The user prefers concise Chinese explanations in future sessions.",
      memoryType: "preference",
    }).allowed,
    true,
  );
});

test("permits a temporary occurrence when deliberately encoded as an event", () => {
  assert.equal(
    assessMemoryWrite({
      statement: "The staging server was temporarily unavailable.",
      memoryType: "event",
    }).allowed,
    true,
  );
});
