import { stripProviderEnv } from "../helpers/test-env.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NmgService } from "../../src/cli/service.ts";
import { createNmgMcpServer } from "../../src/integration/mcp-tools.ts";
import { codexMcpBinding } from "../../codex-plugin/session.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

stripProviderEnv();

test("one MCP connection isolates concurrent native sessions and refuses a foreign projection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-mcp-scope-"));
  const service = new NmgService({ dataDirectory: directory, environment: {} });
  const adapter = createNmgMcpServer({
    resolveBinding: codexMcpBinding,
    invoke: async (method, params) => {
      await Promise.resolve();
      return service.invoke(method, params);
    },
  });
  const client = new Client({ name: "native-scope-test", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const a = "00000000-0000-7000-8000-000000000001";
  const b = "00000000-0000-7000-8000-000000000002";
  const call = (id: string, name: string, args: Record<string, unknown>) =>
    client.callTool({
      name,
      arguments: args,
      _meta: { "x-codex-turn-metadata": { thread_id: id, session_id: id, turn_id: id } },
    });
  try {
    await adapter.ready;
    await adapter.server.connect(serverTransport);
    await client.connect(clientTransport);
    await Promise.all(
      [a, b].map((id) =>
        call(id, "nmg_state", {
          action: "write",
          space: "ag",
          operation: "enable",
          reason: "Concurrent test",
        }),
      ),
    );
    await Promise.all(
      [a, b].map((id) =>
        call(id, "nmg_state", {
          action: "write",
          space: "ag",
          operation: "replace",
          text: `private-${id}`,
        }),
      ),
    );
    const states = await Promise.all(
      [a, b].map((id) => call(id, "nmg_state", { action: "read", space: "ag" })),
    );
    assert.match(JSON.stringify(states[0]), new RegExp(`private-${a}`));
    assert.doesNotMatch(JSON.stringify(states[0]), new RegExp(`private-${b}`));
    assert.match(JSON.stringify(states[1]), new RegExp(`private-${b}`));
    await service.invoke("remember", {
      statement: "ScopeFixture SQLite storage",
      nodeName: "scope",
    });
    const search = await call(a, "nmg_search", { query: "ScopeFixture SQLite" });
    const text = JSON.stringify(search);
    const projection = text.match(/activeGraphId=([0-9a-f-]+)/)?.[1];
    assert.ok(projection);
    const memoryId = (await service.invoke("search", { query: "ScopeFixture" })).results[0]!.memory
      .id;
    const refused = await call(b, "nmg_get", { memoryIds: [memoryId], activeGraphId: projection });
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused), /another session/);
    const missing = await client.callTool({
      name: "nmg_search",
      arguments: { query: "ScopeFixture", sessionId: a },
    });
    assert.equal(missing.isError, true);
    assert.match(JSON.stringify(missing), /metadata/);
  } finally {
    await client.close();
    await adapter.server.close();
    await service.close();
    removeTempDirectory(directory);
  }
});
