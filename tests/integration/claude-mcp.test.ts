import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { connectDaemon, invokeDaemon } from "../../src/cli/daemon-client.ts";

const serverPath = resolve(
  import.meta.dirname,
  "../../claude-plugins/nmg-memory/agents/memory-copilot.ts",
);

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

test("MCP adapter keeps coordination off the default tool surface", async () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), "nmg-claude-mcp-default-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", serverPath],
    env: { ...process.env, NMG_DATA_DIR: dataDir, NMG_ENABLE_COORDINATION: "0" },
    stderr: "pipe",
  });
  const client = new Client({ name: "nmg-mcp-default-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.some((tool) => tool.name === "nmg_board"), false);
    assert.equal(tools.tools.some((tool) => tool.name === "nmg_search"), true);
  } finally {
    await client.close().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("MCP adapter registers, discovers, and directs to a stable agent", async () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), "nmg-claude-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", serverPath],
    env: {
      ...process.env,
      NMG_DATA_DIR: dataDir,
      NMG_AGENT_ID: "claude-reviewer",
      NMG_AGENT_CAPABILITIES: "review,typescript",
      NMG_SESSION_ID: "claude-session",
      NMG_ENABLE_COORDINATION: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "nmg-mcp-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const board = tools.tools.find((tool) => tool.name === "nmg_board");
    const lab = tools.tools.find((tool) => tool.name === "nmg_lab");
    const search = tools.tools.find((tool) => tool.name === "nmg_search");
    const get = tools.tools.find((tool) => tool.name === "nmg_get");
    const remember = tools.tools.find((tool) => tool.name === "nmg_remember");
    assert.ok(board);
    assert.ok(lab);
    assert.ok(search);
    assert.ok(get);
    assert.ok(remember);
    assert.match(JSON.stringify(board.inputSchema), /discover/u);
    assert.match(JSON.stringify(board.inputSchema), /capabilities/u);
    assert.match(JSON.stringify(board.inputSchema), /"to"/u);
    assert.match(JSON.stringify(get.inputSchema), /activeGraphId/u);
    assert.match(JSON.stringify(remember.inputSchema), /claim_outcome/u);

    const saved = await client.callTool({
      name: "nmg_remember",
      arguments: {
        action: "save",
        statement: "The MCP adapter test uses a stable Active Graph session.",
        nodeName: "MCP adapter test",
        memoryType: "fact",
      },
    });
    const memoryId = /Saved ([0-9a-f-]+)/u.exec(textOf(saved))?.[1];
    assert.ok(memoryId);
    const recalled = await client.callTool({
      name: "nmg_search",
      arguments: { query: "stable Active Graph session", limit: 4 },
    });
    const activeGraphId = /activeGraphId=([^\s]+)/u.exec(textOf(recalled))?.[1];
    assert.ok(activeGraphId);
    assert.match(textOf(recalled), new RegExp(memoryId, "u"));
    const exact = await client.callTool({
      name: "nmg_get",
      arguments: { memoryIds: [memoryId], activeGraphId },
    });
    assert.match(textOf(exact), /stable Active Graph session/u);

    const roster = await client.callTool({
      name: "nmg_board",
      arguments: { action: "discover", capabilities: "typescript" },
    });
    assert.match(textOf(roster), /claude-reviewer/u);

    await client.callTool({
      name: "nmg_board",
      arguments: {
        action: "put",
        content: "Review the adapter boundary",
        kind: "handoff",
        to: "claude-reviewer",
      },
    });
    const read = await client.callTool({
      name: "nmg_board",
      arguments: { action: "read" },
    });
    assert.match(textOf(read), /Review the adapter boundary/u);

    const capabilities = await client.callTool({ name: "nmg_lab", arguments: { action: "list" } });
    assert.match(textOf(capabilities), /reasoning_workspace/u);
    await client.callTool({
      name: "nmg_lab",
      arguments: {
        action: "enable",
        capability: "reasoning_workspace",
        reason: "preserve a cross-tool investigation",
      },
    });
    const added = await client.callTool({
      name: "nmg_lab",
      arguments: {
        action: "invoke",
        capability: "reasoning_workspace",
        operation: "add",
        input: { kind: "hypothesis", content: "The MCP adapter owns this scratch node." },
      },
    });
    assert.match(textOf(added), /MCP adapter owns this scratch node/u);

    const forgotten = await client.callTool({
      name: "nmg_remember",
      arguments: { action: "forget", memoryId },
    });
    assert.match(textOf(forgotten), /withdrawn from normal retrieval/u);
  } finally {
    await client.close().catch(() => undefined);
    const daemon = await connectDaemon(resolve(dataDir, "nmg.sqlite")).catch(() => null);
    if (daemon) await invokeDaemon(daemon, "shutdown", {}).catch(() => undefined);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
