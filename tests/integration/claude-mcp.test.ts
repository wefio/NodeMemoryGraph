import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { connectDaemon, invokeDaemon } from "../../src/cli/daemon-client.ts";
import { NmgStore } from "../../src/core/store.ts";

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

test("MCP adapter permits coordination to be explicitly disabled", async () => {
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
    assert.equal(
      tools.tools.some((tool) => tool.name === "nmg_board"),
      false,
    );
    assert.equal(
      tools.tools.some((tool) => tool.name === "nmg_search"),
      true,
    );
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
    const repeated = await client.callTool({
      name: "nmg_search",
      arguments: { query: "stable Active Graph session", limit: 4 },
    });
    assert.match(textOf(repeated), /already_in_context=true/u);
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

test("MCP adapter exposes shared logical-chain structure", async () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), "nmg-claude-mcp-chains-"));
  const databasePath = resolve(dataDir, "nmg.sqlite");
  const store = new NmgStore(databasePath);
  const ids = [
    "Claude chain anchor input A.",
    "Claude chain combines both inputs.",
    "Claude chain input C is available.",
  ].map(
    (statement, index) =>
      store.remember({
        nodeName: `Claude chain ${index}`,
        nodeKind: "topic",
        nodeSummary: "Claude shared projection",
        statement,
        sourceActor: "user",
      }).memory.id,
  );
  const chain = store.createMemoryChain({
    chainType: "logical",
    topic: "Claude shared projection",
  });
  store.addMemoryChainEdge({ chainId: chain.id, sourceMemoryId: ids[0]!, targetMemoryId: ids[1]! });
  store.addMemoryChainEdge({ chainId: chain.id, sourceMemoryId: ids[2]!, targetMemoryId: ids[1]! });
  store.close();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", serverPath],
    env: { ...process.env, NMG_DATA_DIR: dataDir, NMG_ENABLE_COORDINATION: "0" },
    stderr: "pipe",
  });
  const client = new Client({ name: "nmg-mcp-chain-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const recalled = await client.callTool({
      name: "nmg_search",
      arguments: { query: "Claude chain anchor", limit: 4 },
    });
    assert.match(textOf(recalled), /chains=Claude shared projection/u);
    assert.match(textOf(recalled), /logical_chains=1/u);

    const exact = await client.callTool({
      name: "nmg_get",
      arguments: { memoryIds: ids },
    });
    const exactText = textOf(exact);
    assert.match(exactText, /<nmg_logical_chains>/u);
    assert.match(exactText, /A & C --> B/u);
    for (const statement of [
      "Claude chain anchor input A.",
      "Claude chain combines both inputs.",
      "Claude chain input C is available.",
    ]) {
      assert.equal(exactText.split(statement).length - 1, 1, `${statement} is emitted once`);
    }
  } finally {
    await client.close().catch(() => undefined);
    const daemon = await connectDaemon(databasePath).catch(() => null);
    if (daemon) await invokeDaemon(daemon, "shutdown", {}).catch(() => undefined);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
