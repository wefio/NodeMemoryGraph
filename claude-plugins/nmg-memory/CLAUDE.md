# NMG Memory MCP server

Three durable-memory tools served over MCP stdio:

- `nmg_search` — compact memory headers (mid/node/type/tier/preview)
- `nmg_get` — exact memory statements and source evidence
- `nmg_remember` — save facts/preferences/constraints/states/events

The MCP server manages the local gRPC daemon automatically (start on
connect, safe stop on exit, reuse if already running).

Requirements: Node.js ≥ 22.19, `npm install` run in the project.

## Adding to any MCP client

Register the server as a stdio transport:

```json
{
  "mcpServers": {
    "nmg": {
      "type": "stdio",
      "command": "node",
      "args": [
        "--experimental-strip-types",
        "claude-plugins/nmg-memory/agents/memory-copilot.ts"
      ]
    }
  }
}
```

- **Claude Code**: place the block above in a `.mcp.json` at the project
  root. Auto-discovered at session start.
- **Claude Desktop**: add to `claude_desktop_config.json` under `mcpServers`.
- **VS Code / Cursor / Codex**: add to the editor's MCP config file.
- **Any MCP-compatible client**: same JSON block, same stdio protocol.

After restarting the client, restart it. The three NMG tools appear
automatically. First connection may require a one-time approval.

**Alternative — global install**: to make NMG available across all projects
regardless of cwd, use an absolute path for `args` and for `--experimental-strip-types` include `--experimental-strip-types` pointing at the plugin's
`CLAUDE.md` directory.

## Troubleshooting

- Tools missing? MCP server likely failed to connect. Check Node.js version,
  `npm install`, and remove a stale daemon lockfile if present
  (`rm .nmg/nmg.sqlite.server.json`).
- Empty search results? The database may not have been written to yet. Any
  `nmg_remember` call populates it.
- Run `npx claude mcp list` (Claude Code) or `node bin/nmg.mjs daemon status --json` (terminal) to inspect daemon and embedding health.
