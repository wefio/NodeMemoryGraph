# Activating NMG Memory in Claude Code

Zero-dependency durable memory for the current project. After setup, three
tools appear automatically in every session:

- `nmg_search` — recall compact memory headers (mid/node/type/tier/preview)
- `nmg_get` — load exact memory statements and source evidence
- `nmg_remember` — save facts, preferences, constraints, states, events

The MCP server manages the local gRPC daemon automatically (start on connect,
safe stop on exit, reuse if already running).

## One-time setup

Add this `.mcp.json` file to the project root:

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

Requirements: Node.js ≥ 22.19 and `npm install` already run.

## Verifying

After restarting Claude Code, `nmg_search` / `nmg_get` / `nmg_remember`
should appear in the tool list. The first MCP connection needs a one-time
approval.

## Troubleshooting

If tools are missing, the MCP server likely failed to connect. Check that

- Node.js ≥ 22.19 is installed (`node --version`)
- `npm install` was run in the project
- NMG daemon is not already running with a stale lockfile
  (`rm .nmg/nmg.sqlite.server.json`)

If the daemon is running but search returns nothing, the database may be
empty. Any `nmg_remember` call populates it. Use `nmg daemon status --json`
(in a terminal) to inspect embedding availability and database size.
