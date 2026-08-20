import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { collectAgentRunTelemetry } from "../../evals/agent-telemetry.ts";

test("collects tool attempts, tool-bearing rounds, and every assistant usage", () => {
  const usage = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  const events = [
    { type: "tool_execution_start", toolName: "nmg_search" },
    { type: "tool_execution_start", toolName: "nmg_get" },
    { type: "turn_end", toolResults: [{}, {}] },
    { type: "turn_end", toolResults: [] },
    { type: "message_end", message: { role: "assistant", usage: usage(10, 2, 5, 1) } },
    { type: "message_end", message: { role: "assistant", usage: usage(7, 3, 4, 0) } },
  ] as AgentSessionEvent[];

  assert.deepEqual(collectAgentRunTelemetry(events), {
    toolCalls: 2,
    toolRounds: 1,
    tokenUsage: { input: 17, output: 5, cacheRead: 9, cacheWrite: 1, total: 32 },
  });
});

test("returns an explicit null token usage when Pi emitted no assistant usage", () => {
  assert.deepEqual(collectAgentRunTelemetry([]), {
    toolCalls: 0,
    toolRounds: 0,
    tokenUsage: null,
  });
});
