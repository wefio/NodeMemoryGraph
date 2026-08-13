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
    assert.ok(board);
    assert.match(JSON.stringify(board.inputSchema), /discover/u);
    assert.match(JSON.stringify(board.inputSchema), /capabilities/u);
    assert.match(JSON.stringify(board.inputSchema), /"to"/u);

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
  } finally {
    await client.close().catch(() => undefined);
    const daemon = await connectDaemon(resolve(dataDir, "nmg.sqlite")).catch(() => null);
    if (daemon) await invokeDaemon(daemon, "shutdown", {}).catch(() => undefined);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
