import assert from "node:assert/strict";
import test from "node:test";
import type { NmgMethod } from "../../src/cli/protocol.ts";
import type { MemoryContext } from "../../src/core/types.ts";
import { createSearchTool } from "../../src/integration/search-tool.ts";
import { searchResultFixture } from "../helpers/search-result.ts";

test("explicit search sends the bound request and formats a folded provider degradation without network", async () => {
  const requests: Array<{ method: NmgMethod; params: Record<string, unknown>; cli?: string[] }> =
    [];
  const context: MemoryContext = {
    results: [searchResultFixture("already-read", "Fixture SQLite notes")],
    relations: [],
    retrieval: { mode: "lexical", degraded: true, reason: "embedding_http_429" },
  };
  const output = await createSearchTool(true).execute(
    {
      query: "Fixture SQLite",
      scope: { project: "test" },
      maxTier: 0,
      eventTimeFrom: "2026-08-20",
      recallCue: "SQLite",
      recallRevision: 2,
      recallSource: { prompt: "spoofed observation", generation: 1, turn: 1 },
      sessionId: "spoofed-session",
      projectDir: "spoofed-project",
      autoRecall: true,
      autoRecallBudgetMs: 1,
    },
    {
      sessionId: "native-session",
      requester: "agent:fixture",
      memory: { projectDir: "C:/native-project", search: { beginDisclosureTurn: true } },
      async invoke(method, params, cli) {
        requests.push({ method, params, cli });
        return method === "search"
          ? context
          : { freshMemoryIds: [], foldedMemoryIds: ["already-read"] };
      },
    },
  );
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["search", "sessionActiveGraph"],
  );
  assert.deepEqual(requests[0]?.params, {
    query: "Fixture SQLite",
    scope: { project: "test" },
    maxTier: 0,
    eventTimeFrom: "2026-08-20",
    recallCue: "SQLite",
    recallRevision: 2,
    sessionId: "native-session",
    projectDir: "C:/native-project",
  });
  assert.deepEqual(requests[0]?.cli, [
    "search",
    "Fixture SQLite",
    "--session-id",
    "native-session",
    "--json",
    "--project-dir",
    "C:/native-project",
    "--max-tier",
    "0",
    "--from",
    "2026-08-20",
    "--scope",
    "project=test",
  ]);
  assert.equal(requests[1]?.params.action, "disclose");
  assert.equal(requests[1]?.params.disclosure, "header");
  assert.match(output.text, /degraded retrieval: mode=lexical; reason=embedding_http_429/u);
  assert.match(output.text, /memory=already-read; already_in_context=true/u);
  assert.doesNotMatch(output.text, /Fixture SQLite notes|No NMG match/u);
});

test("search schema and RPC use the same endpoint selection", async () => {
  const tool = createSearchTool(false, ["query", "sessionId", "nodeName"]);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ["query", "nodeName"]);
  const output = await tool.execute(
    { query: "missing", nodeName: "fixture", eventTimeFrom: "2026-08-20" },
    {
      sessionId: "bound",
      requester: "agent:fixture",
      memory: { projectDir: "C:/local", search: { defaultTier: 3, beginDisclosureTurn: true } },
      async invoke(method, params) {
        assert.equal(method, "search");
        assert.deepEqual(params, { query: "missing", nodeName: "fixture", sessionId: "bound" });
        return { results: [], relations: [] };
      },
    },
  );
  assert.equal(output.text, "No NMG match.");
});
