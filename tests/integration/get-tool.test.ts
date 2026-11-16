import assert from "node:assert/strict";
import test from "node:test";
import { createGetTool } from "../../src/integration/get-tool.ts";
import { searchResultFixture } from "../helpers/search-result.ts";

test("shared exact lookup binds the native owner and renders a folded disclosure", async () => {
  const entry = searchResultFixture("memory-in-scope", "Verified backup was completed.");
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const output = await createGetTool(true).execute(
    { memoryIds: [entry.memory.id], activeGraphId: "graph", sessionId: "forged" },
    {
      sessionId: "native",
      requester: "agent:test",
      memory: { projectDir: "/fixture" },
      invoke: async (method, args) => {
        calls.push({ method, args });
        return method === "get"
          ? { results: [entry], relations: [] }
          : { freshMemoryIds: [], foldedMemoryIds: [entry.memory.id] };
      },
    },
  );
  assert.deepEqual(calls[0], {
    method: "get",
    args: {
      memoryIds: [entry.memory.id],
      graphHops: undefined,
      activeGraphId: "graph",
      sessionId: "native",
      projectDir: "/fixture",
    },
  });
  assert.equal(calls[1]?.args.sessionId, "native");
  assert.match(output.text, /already_in_context=true/u);
  assert.doesNotMatch(output.text, /Verified backup/u);
});
