import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createNmgMcpServer } from "../../src/integration/mcp-tools.ts";

test("shared MCP feedback forwards explicit false labels and session scope without saving memory", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = createNmgMcpServer({
    resolveBinding: () => ({ sessionId: "feedback-owner", agentId: "feedback-owner" }),
    invoke: async (method, params) => {
      calls.push({ method, params });
      return { trained: false, activeGraphId: params.activeGraphId };
    },
  });
  const client = new Client({ name: "feedback-contract", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await adapter.ready;
    await adapter.server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "nmg_remember",
      arguments: {
        action: "feedback",
        activeGraphId: "rated-graph",
        taskSuccess: false,
        memoryMisleading: true,
        feedbackNote: "The answer contradicted the exact source.",
      },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "recordFeedback");
    assert.equal(calls[0]!.params.sessionId, "feedback-owner");
    assert.equal(calls[0]!.params.taskSuccess, false);
    assert.equal(calls[0]!.params.memoryMisleading, true);
    assert.equal(calls[0]!.params.note, "The answer contradicted the exact source.");
    for (const args of [
      { action: "feedback", activeGraphId: "rated-graph" },
      { action: "feedback", taskSuccess: true },
      { action: "feedback", activeGraphId: "rated-graph", taskSuccess: 1 },
    ]) {
      assert.equal(
        (await client.callTool({ name: "nmg_remember", arguments: args })).isError,
        true,
      );
    }
    assert.equal(calls.length, 1);
  } finally {
    await client.close();
    await adapter.server.close();
  }
});
