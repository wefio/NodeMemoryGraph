import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { attemptedToolCall, successfulToolCall } from "../../evals/tool-events.ts";

test("failed tool dispatch is still an attempt but not a success", () => {
  const events = [
    { type: "tool_execution_start", toolName: "nmg_search" },
    { type: "tool_execution_end", toolName: "nmg_search", isError: true },
  ] as AgentSessionEvent[];
  assert.equal(attemptedToolCall(events, "nmg_search"), true);
  assert.equal(successfulToolCall(events, "nmg_search"), false);
});

test("successful remember with saved=false is not a usable success", () => {
  const events = [
    {
      type: "tool_execution_end",
      toolName: "nmg_remember",
      isError: false,
      result: { details: { saved: false } },
    },
  ] as AgentSessionEvent[];
  assert.equal(attemptedToolCall(events, "nmg_remember"), true);
  assert.equal(successfulToolCall(events, "nmg_remember"), false);
});
