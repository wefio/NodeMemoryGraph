import { stripProviderEnv } from "../helpers/test-env.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildCodexPlugin } from "../../scripts/build-codex-plugin.ts";

stripProviderEnv();

test("Codex distribution runs its MCP client without source dependencies and includes trusted-hook inputs", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "nmg-codex-package-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const result = await buildCodexPlugin({ output, revision: "test-revision" });
  assert.equal(result.sha256.length, 64);
  const files = await readdir(result.directory);
  assert.ok(!files.includes("node_modules"));
  const mcp = JSON.parse(await readFile(join(result.directory, ".mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.nmg.cwd, ".");
  assert.deepEqual(mcp.mcpServers.nmg.env_vars, ["NMG_DATA_DIR", "NMG_ENABLE_COORDINATION"]);
  const hooks = JSON.parse(await readFile(join(result.directory, "hooks/hooks.json"), "utf8"));
  assert.equal(
    hooks.hooks.UserPromptSubmit[0].hooks[0].command,
    'node "${PLUGIN_ROOT}/scripts/nmg.mjs" hook',
  );
  assert.ok(
    (await readFile(join(result.directory, "skills/nmg-memory/SKILL.md"), "utf8")).includes(
      "# NMG Memory",
    ),
  );
  const client = new Client({ name: "distribution-contract", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: mcp.mcpServers.nmg.args,
    cwd: result.directory,
    env: { ...process.env, NMG_DATA_DIR: join(output, "no-daemon") } as Record<string, string>,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "nmg_get",
      "nmg_lab",
      "nmg_remember",
      "nmg_search",
      "nmg_state",
    ]);
    const unbound = await client.callTool({
      name: "nmg_state",
      arguments: { action: "read", space: "ag" },
    });
    assert.equal(unbound.isError, true);
    assert.match(JSON.stringify(unbound), /metadata/);
  } finally {
    await client.close();
  }
});

test("Codex build refuses existing unmanaged output", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "nmg-codex-unmanaged-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  await mkdir(join(output, "plugin"));
  await writeFile(join(output, "plugin/user-file"), "keep");
  await assert.rejects(buildCodexPlugin({ output }), /unmanaged/);
  assert.equal(await readFile(join(output, "plugin/user-file"), "utf8"), "keep");
});
