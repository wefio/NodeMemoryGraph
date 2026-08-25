# DeepSeek Harness adapter for NMG

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) adapter
that exposes [Node Memory Graph](../../README.md) durable memory to a DSH agent.

It mirrors the other NMG harness adapters — the [Pi extension](../../.pi/extensions/nmg/index.ts)
and the [Claude Code MCP plugin](../../claude-plugins/nmg-memory/agents/memory-copilot.ts) —
but targets DSH's Cordis plugin system. The agent-facing contract and the recall
workflow follow the packaged [NMG skill](../../skills/nmg-memory/SKILL.md).

## Files

- `nmg-plugin.mjs` — the **composition plugin module** (a real Cordis plugin,
  `export default { name, apply }`). This is what the persistent preset loads.
  For a one-off in-session load, the same five tools are expressed as a dynamic
  `code.host` body (using the `harness.defineTool`/`harness.registerTool` builtins
  instead of `ctx.tools.register`); that source also lives in the running
  `nmg-1` dynamic plugin (`cordis_inspect_self nmg-1 pkg-1`).

Both register the same five tools. Every call is **daemon-first**: it reads the
daemon's JSON-RPC endpoint (`<data-dir>/nmg.sqlite.server.json`) and POSTs
`{ jsonrpc: '2.0', method, params }` with a Bearer token (~10 ms), falling back
to the one-shot CLI (`node bin/nmg.mjs`, ~150-180 ms) only when no live daemon
exists:

| Tool | Purpose |
|------|---------|
| `nmg_search` | Compact memory headers (`mid`/`node`/`type`/`tier`/`preview`) + `activeGraphId` |
| `nmg_get` | Exact memory statements and bounded source evidence |
| `nmg_remember` | Save typed durable memories (fact/preference/constraint/state/event/strategy) |
| `nmg_board` | Temporary, task-scoped cross-agent coordination (put/read/resolve/claim/release/discover) |
| `nmg_daemon` | Read-only daemon health check |

The adapter never imports the NMG core store and never owns a daemon. It keeps the
agent-neutral CLI as the fallback transport, but the fast path is direct JSON-RPC
to the running daemon — the same envelope the CLI's own `http-client.ts` uses — so
tool calls and automatic recall all run in single-digit-ms with no per-call process
spawn. A dead or missing daemon degrades to the CLI.

## Automatic recall (DSH-native)

The adapter injects memory as a **`systemPrompt.context`** contribution named
`nmg:recall` — DSH's first-class "dynamic context materialized as a durable
user-role snapshot" — rather than fabricating a user message. Per user message the
adapter runs a small-budget `nmg search` (default `limit 13`, `max-tier 1`,
`graph-hops 1`, `tiered-disclosure`; override with `NMG_AUTO_RECALL_LIMIT` /
`NMG_AUTO_RECALL_TIER`) and serves the **Active-Graph header projection** —
compact `mid/node/type/tier/preview` lines plus `activeGraphId` — as that context.
The agent loop appends the resolved snapshot to the turn's messages itself.

The search is kicked off on `agent/inbox/inserted` (before the turn's first prompt
assembly); a fast path that lands after the first assembly just shows from the next
step, and being runtime context the memory stays in front of the model for the
**whole turn**, not only the first step. Exact evidence stays behind `nmg_get`;
passing that `activeGraphId` records actual use on the session's AG trace. A
per-session window folds ids injected in the last 12 messages.

**Performance:** every NMG call — the per-turn recall and all five tools — goes
straight to the running daemon over HTTP JSON-RPC (single-digit-ms); the one-shot
CLI (~180 ms) is only the fallback when no daemon is up. A 1.5 s budget
(`AbortSignal.timeout`) aborts a slow or dead recall, and the injection never
blocks a step — any failure falls back to `next()`.

## UI tool cards

`nmg-plugin.client.js` is the canonical Client half that gives the five NMG tools
custom conversation cards (keyed `tool.call.toolview` entries, per-tool accent
colors, compact header + bounded result, memoized, theme-aware). It is kept in
sync with the browser half of the `dsh-nmg` package below.

## Persistent install (dual-face host package) — recommended

As of the community-standard `dsh-nmg` package (`./dsh-nmg/`), the whole adapter is
delivered as a **dual-face host package** in one artifact: the node half
(`src/plugin/index.ts` → `lib/index.js`) registers the tools + automatic recall in
the host composition, and the browser half (`src/client/index.tsx` →
`lib/client.js`) registers the toolview cards through the DSH `window.__ModuleLoader__`
bundle handoff. Because it becomes a host row it is **global across sessions and
persists across restart** — the reason the preexisting preset install below is no
longer needed for persistent use.

Build and install:

```powershell
cd dsh/dsh-nmg
pnpm install
pnpm build                 # lib/index.js (node half) + lib/client.js (browser bundle)
dsh plugin --profile web add "link:C:/.../dsh-nmg"   # adds bundle to the web profile
# then restart the web host so the recomposed profile (id: nmg, name: @nmg/dsh-nmg) loads
```

> **Verify the bundle resolves before relying on it.** `dsh plugin add` records the
> package in `dependencies` and, when it declares `dsh.bundle`, also appends it to
> `dsh.profile.bundles`. Only the **two together** make the plugin load. A package
> that is listed in `dependencies` but whose `node_modules/<name>` link is dangling
> or not materialized will still crash the host at boot:
>
> ```text
> dsh: cannot resolve profile bundle "<name>" from the dsh installation or <profileDir>; run 'dsh plugin --profile <name> install' if its dependency is not installed
> ```
>
> This bites after a repo relocate or a cache-miss/pnpm rewrite that re-emits
> `package.json` without re-materializing the link. A junction/symlink "looking"
> present is *not* proof — a dangling link points at a path that no longer exists and
> fails `existsSync` on the package.json. Check with the **same resolver the boot
> uses** (`resolveBundleDir` → `packageDirFromAnchor`, profile anchor first):
>
> ```js
> // node --input-type=module -e '...'
> const { createRequire } = await import('node:module');
> const { join } = await import('node:path');
> const { existsSync } = await import('node:fs');
> const anchor = 'C:\\Users\\LEGION\\.dsh\\profiles\\web\\package.json';
> const name = '@nmg/dsh-nmg';
> for (const sp of createRequire(anchor).resolve.paths(name) ?? []) {
>   const dir = join(sp, name);
>   if (existsSync(join(dir, 'package.json'))) { console.log('resolves:', dir); break; }
> }
> ```
>
> If it prints nothing, the link is missing/dangling — run `dsh plugin --profile web
> install` (or `pnpm install` in the profile dir) to materialize it, then re-check.
> For a true end-to-end compose check, `dsh --profile web --dump-config` prints the
> whole composed tree, but it rewrites the profile's `cordis.yml`, so it is not usable
> under the default `workspace-write` sandbox.

Retire the legacy preset when the package is confirmed working (they register the
same tool names and would otherwise double-register): run `agentPresets.remove('nmg')`
and clear `agent-presets.default` from `~/.dsh/settings.yaml`, then restart once more.

Legacy alternatives kept for reference:

### Persistent install (agent preset)

NMG registers **model tools**, so it belongs on the **agent-preset plane**, not the
host composition (which owns the registries, sandbox/approval, persistence, and the
model route — the deployment install you must not edit). The persistent install is a
user-authored preset:

1. `agentPresets.copy('standard', 'nmg', 'NMG 记忆')` — copy the full coding agent.
   (`standard`, not `cordis`: `cordis` ships `tool-cordis`, whose Host inspect
   providers are process singletons and collide with a second mount.)
2. Copy `nmg-plugin.mjs` into the preset directory and append the row to
   `agent.cordis.yml`:
   ```yaml
   - id: nmg
     name: './nmg-plugin.mjs'
   ```
   (The module publishes no service, so no `isolate` realm is needed.)
3. Write `preset.yml` with the `name` and `description`.
4. Set the default so new sessions load it:
   ```yaml
   # ~/.dsh/settings.yaml
   agent-presets:
     default: nmg
   ```
5. Mount-validate: `agentPresets.standingKeyFor('nmg')` must return normally.

A new session then composes `standard` + the five NMG tools automatically; this
session's default is unchanged until it is recreated.

## Dynamic install (this session only)

Paste the dynamic `code.host` body (the five tools, via the `harness` builtins)
through `cordis_define` (`kind: "new"`, `idPrefix: "nmg"`) and activate it with
`cordis_run`. It disappears on restart; use the preset for anything that must survive.

## Manual fallback

The same commands are available through the ordinary `pwsh` tool:

```powershell
node bin/nmg.mjs daemon status --json
node bin/nmg.mjs search "How should answers be written?" --limit 8 --compact-json
node bin/nmg.mjs get <mid> --active-graph-id <id> --json
node bin/nmg.mjs remember "User prefers concise answers" --node "Response preferences" --type preference
```

See the [skill workflow](../../skills/nmg-memory/SKILL.md) for the full
status → search → get → remember contract and the write-policy rules.
