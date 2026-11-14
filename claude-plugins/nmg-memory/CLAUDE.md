# NMG Memory MCP server

[中文](CLAUDE.zh-CN.md) · [Terms](CLAUDE.terms.yaml)

Durable-memory tools plus the task board, served over MCP stdio:

- `nmg_search` — compact memory headers (mid/node/type/tier/preview)
- `nmg_get` — exact memory statements and source evidence
- `nmg_remember` — save facts/preferences/constraints/states/events
  (`boardSource` marks a memory as distilled from a board entry)
- `nmg_state` — explicit AG working-state operations and Task Board access through
  `space=ag|board`; use board operations for discovery, subscriptions and replies.
- `nmg_lab` — listed optional capabilities, not ordinary state updates.

Board identity: `NMG_AGENT_ID` / `NMG_SESSION_ID` env vars win; otherwise the
server uses its own pid (`mcp:<pid>`), which is stable per host session.
The server registers this identity when it connects and refreshes its heartbeat
on board use. `NMG_AGENT_CAPABILITIES` is an optional comma-separated discovery
hint.
Reading open entries writes delivery receipts so wake loops never re-push
what this session already saw.

The MCP server manages the local daemon automatically (JSON-RPC over HTTP;
ensure on connect, stop only its own process on exit, reuse a compatible existing owner).

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

Reload the client connection, then inspect the actual tool list. First connection may require client approval. MCP alone does not add automatic recall, state carriage or idle wake.

Use an absolute path to `agents/memory-copilot.ts` in the `args` array when the client can start from different working directories. Keep `--experimental-strip-types` as a separate argument. Other clients may use a different configuration format for the same stdio fields.

The [adapter usage guide](../../skills/nmg-memory/references/adapter-usage.md#claude-code-and-other-mcp-clients) covers daily tools, state and combinations with hooks.

## Troubleshooting

- Tools missing? MCP server likely failed to connect. Check Node.js version,
  dependencies, absolute script path and client logs. Inspect daemon compatibility; do not delete a live lease or replace a shared owner.
- Empty search results are valid. Check the selected store and query before assuming a connection fault; do not invent a memory merely to make a test return data.
- Use the client's connection logs and `node bin/nmg.mjs daemon status --json` from the checkout to inspect the actual connection and daemon health.
