# NMG Memory MCP server

Durable-memory tools plus the task board, served over MCP stdio:

- `nmg_search` — compact memory headers (mid/node/type/tier/preview)
- `nmg_get` — exact memory statements and source evidence
- `nmg_remember` — save facts/preferences/constraints/states/events
  (`boardSource` marks a memory as distilled from a board entry)
- `nmg_board` — task-board channels: put/read/resolve/acknowledge/claim/
  release/subscribe/unsubscribe; no taskId means the shared world channel
  (the lobby), reading it lists active named channels

Board identity: `NMG_AGENT_ID` / `NMG_SESSION_ID` env vars win; otherwise the
server uses its own pid (`mcp:<pid>`), which is stable per host session.
Reading open entries writes delivery receipts so wake loops never re-push
what this session already saw.

The MCP server manages the local daemon automatically (JSON-RPC over HTTP;
start on connect, safe stop on exit, reuse if already running).

Requirements: Node.js ≥ 22.19, `npm install` run in the project.

## Performance feedback (off by default)

Set `NMG_AGENT_PERF=1` to make `nmg_search` append a compact per-phase timing
line (`[perf search.direct=..ms relations=..ms total=..ms]`) to its result.
The agent can use it for self-maintenance — e.g. a slow `search.direct` scan
on a large store suggests pruning or merging low-tier nodes. The switch is
per MCP server process: shared daemons keep their own timing behavior.

```bash
NMG_AGENT_PERF=1 node --experimental-strip-types claude-plugins/nmg-memory/agents/memory-copilot.ts
```

## Adding to any MCP client

Register the server as a stdio transport:

```json
{
  "mcpServers": {
    "nmg": {
      "type": "stdio",
      "command": "node",
      "args": ["--experimental-strip-types", "claude-plugins/nmg-memory/agents/memory-copilot.ts"]
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
