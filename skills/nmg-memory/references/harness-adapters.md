# Harness adapters

NMG ships a thin adapter per harness (Pi, Claude Code MCP, DeepSeek Harness).
This reference is the recipe for writing one. Read it when you need to expose NMG
to a new tool-capable harness, or when an existing adapter misbehaves.

## The stable contract

An adapter is **thin**: it never imports the NMG core store
(`src/core`, `src/cli/service.ts`). It talks to the running daemon over HTTP
JSON-RPC (read `<data-dir>/nmg.sqlite.server.json`, POST
`{ jsonrpc: '2.0', method, params, id }` with `Authorization: Bearer <token>`),
falling back to the one-shot CLI (`node bin/nmg.mjs`) only when no daemon exists —
so the adapter needs no daemon lifecycle of its own and pays no per-call process
spawn (~180 ms) while a daemon is up.

Expose exactly this surface, with compact output:

| Tool | Daemon RPC (CLI fallback) |
|------|---------------------------|
| `nmg_search(query, limit?, maxTier?, nodeName?, scope?, ...)` | RPC `search` · fallback `nmg search "<q>" --compact-json` |
| `nmg_get(memoryIds[], activeGraphId?)` | RPC `get` · fallback `nmg get <ids...> --json` |
| `nmg_remember(statement, nodeName, ...)` | RPC `remember` · fallback `nmg remember "<s>" --node "<n>" --json` |
| `nmg_board(action, taskId?, ...)` | RPC `taskBoard` · fallback `nmg board <action> --json` |
| `nmg_daemon(status)` (optional) | RPC `status` · fallback `nmg daemon status --json` |

Rules every adapter must preserve:

- `search` returns compact headers + `activeGraphId`; exact statements and evidence
  stay behind `get`.
- `get` forwards the `activeGraphId` so actual use is recorded, not mere exposure.
- the board is temporary cross-agent coordination, never durable memory.
- the adapter never owns or stops a shared daemon — the one-shot CLI reuses it.

### Automatic recall (hook, optional but recommended)

Tools alone cannot make memory surface: the model will not reliably choose to
search on its own. On harnesses with a lifecycle hook, run a small-budget search at
each new user turn and inject the **Active-Graph header projection** (compact
headers + `activeGraphId`) as a context message — not bare text. Exact evidence
stays behind `get(activeGraphId)`, which records actual use on the AG trace; plain
injection must never be counted as use. Keep it cheap: one search per new user turn
(`limit` ≈ 13, `max-tier` 1, `graph-hops` 1, tiered disclosure), fold repeated ids
with a per-session window, and never let a failed recall block the turn.

DeepSeek Harness: hook `agent/pre-step` (waterfall; return
`{ kind: 'enter', messages: [...decision.messages, cue] }`), and only act on the
first step of a new turn (`turn` changed). Build the cue as a plain user message —
do NOT import `createUserMessage` from `@deepseek-ai/dsh-llm`: a local preset
module cannot reliably resolve bare packages across installs (a reinstall broke
the mount). Construct it directly, since `MessageId` is a branded string and any
unique id works:
`{ id: 'nmg-recall:' + sessionId + ':' + turn, role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'nmg', form: 'recall' } }`

**Performance:** do not spawn a fresh CLI process per call (a Node boot costs
~180 ms). Route EVERY call — automatic recall and the tools — straight to the
running daemon over HTTP JSON-RPC (single-digit-ms), fall back to the CLI only
when no live daemon exists, and cap the recall with an abort timeout so a slow or
dead memory layer never delays a turn.

## DeepSeek Harness (worked example)

DSH composes capabilities from Cordis plugin rows in `cordis.yml`. Two planes
decide where a row goes:

- **HOST composition** — the registries (`tools`, `systemPrompt`, `agents`, …),
  sandbox, approval, persistence, the model route, and the subagent registry. One
  instance per process. Do not edit the deployment's own copy: it is the install
  and an upgrade overwrites it.
- **AGENT PRESET** — what one session contributes: its tool plugins, persona, and
  prompt sections. One standing mount per preset. **Model-facing tools belong
  here**, not in the host composition.

So an NMG adapter's tools go in an agent preset.

> **Newer recommended route — dual-face host package.** To make the adapter
> global *and* persist client tool cards across restarts in one artifact, build a
> community-standard dual-face package (node half hosts the tools + recall in the
> host composition; browser half ships the cards through the
> `window.__ModuleLoader__` bundle handoff). See
> `dsh/dsh-nmg/` — `tsdown` emits
> `lib/index.js` + `lib/client.js`, install with
> `dsh plugin --profile web add link:<path>`, restart the host, then retire the
> legacy preset (they register the same tool names). This supersedes the preset
> install below for anything read from this repository.

### Persistent install

1. Copy the full coding preset — `standard`, **not** `cordis`:
   ```
   agentPresets.copy('standard', 'nmg', 'NMG 记忆')
   ```
   `cordis` ships `tool-cordis`, whose Host inspect providers (`Service`/`Event`/
   …) are process singletons; a second mount collides
   (`Host Cordis inspect provider "Service" is already registered`).
2. Write the adapter as a composition module — `export default { name, apply }` —
   that consumes `ctx.get('subprocess')` and registers tools via
   `ctx.tools.register(...)`. It publishes no service, so it needs **no isolate
   realm**. The working module is `harness-adapters/deepseek-harness/nmg-plugin.mjs`
   in the repository.
3. Append one row to the preset's `agent.cordis.yml`:
   ```yaml
   - id: nmg
     name: './nmg-plugin.mjs'
   ```
4. Write `preset.yml` with `name` and `description`.
5. Set the default so new sessions load it (`~/.dsh/settings.yaml`):
   ```yaml
   agent-presets:
     default: nmg
   ```
6. Mount-validate: `agentPresets.standingKeyFor('nmg')` must return normally.

A `ToolDefinition` for `ctx.tools.register` is the raw shape — JSON-Schema
`parameters`, plus `output` and `execute`:

```js
{
  name: 'nmg_search',
  description: '…',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: '…' } },
    required: ['query'],
  },
  output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }] },
  async execute(args, exec) { /* run `node bin/nmg.mjs …`, return a string */ },
}
```

### Gotchas

- `agentPresets.remove(id)` clears `agent-presets.default` when the removed preset
  was the default — reset it after a remove/re-copy cycle.
- User presets live under `~/.dsh/.agent-presets/<id>/`, **outside** the session
  workspace: file writes there are denied under the default sandbox and need a
  one-shot escalation.
- The dynamic form (a `code.host` body using the `harness.defineTool` /
  `harness.registerTool` builtins) is for trialling in one process only; it
  disappears on restart. The composition module above is the persistent form.
- **Client UI does not ride the preset.** Custom tool cards (`tool.call.toolview`,
  keyed by tool name) live in the browser, and DSH persistent client modules are
  **host-composition packages**: declare `dsh.client` in `package.json` with
  `exports["./client"]` pointing at a **built bundle** (the
  `window.__ModuleLoader__.load` handoff), scanned from host Loader entries;
  package-set changes need a host restart. A dynamic plugin's `code.client` works
  in the current process only. Budget for a small package + bundle if cards must
  survive restarts.

### Dynamic install (trial only)

Define and run a dynamic plugin with the same five tools as a `code.host` body via
`cordis_define` (`kind: "new"`, `idPrefix: "nmg"`) + `cordis_run`. Use it only to
verify the CLI contract before writing the persistent preset.

## Manual fallback

Any harness with a shell can use the CLI directly (`pwsh` on DSH):

```powershell
node bin/nmg.mjs daemon status --json
node bin/nmg.mjs search "How should answers be written?" --limit 8 --compact-json
node bin/nmg.mjs get <mid> --active-graph-id <id> --json
node bin/nmg.mjs remember "User prefers concise answers" --node "Response preferences" --type preference
```
