# Harness adapters

[中文](harness-adapters.zh-CN.md) · [Terms used](harness-adapters.terms.yaml)

NMG ships a thin adapter per harness (Pi, Claude Code MCP, DeepSeek Harness,
plus the installable WorkBuddy hook in `workbuddy-plugin/` and the OpenCode v2
plugin in `opencode-plugin/`). This reference is the recipe for writing one.
Per-adapter coverage of the capability surface is compared in the
[harness capability matrix](../../../docs/design/harness-capability-matrix.md).
Read it when you need to expose NMG
to a new tool-capable harness, or when an existing adapter misbehaves.

## The stable contract

An adapter is **thin**: it never imports the NMG core store
(`src/core`, `src/cli/service.ts`). It talks to the running daemon over HTTP
JSON-RPC (read `<data-dir>/nmg.sqlite.server.json`, POST
`{ jsonrpc: '2.0', method, params, id }` with `Authorization: Bearer <token>`).
For operations whose host contract permits it, the adapter may fall back to the
one-shot CLI (`node bin/nmg.mjs`) when no daemon exists. Session-owned state
writes require the resident owner and must not use that fallback. The adapter
does not own daemon lifecycle and should avoid per-call process spawn (~180 ms)
while the daemon is up.

Expose the shared model-facing operations with compact output:

| Tool | Daemon RPC (CLI fallback where supported) |
|------|-------------------------------------------|
| `nmg_search(query, limit?, maxTier?, nodeName?, scope?, ...)` | RPC `search` · fallback `nmg search "<q>" --compact-json` |
| `nmg_get(memoryIds[], activeGraphId?)` | RPC `get` · fallback `nmg get <ids...> --json` |
| `nmg_remember(statement, nodeName, ...)` | RPC `remember` · fallback `nmg remember "<s>" --node "<n>" --json` |
| `nmg_state(action, space, operation?, ...)` | RPC `state`; `space="ag"` is private session state and `space="board"` is shared coordination. State writes require the resident owner; do not invent a CLI fallback if the host contract does not provide one. |
| `nmg_lab(action, capability?, ...)` (optional) | RPC `lab` · use only for listed optional capabilities, not routine working-state writes |
| `nmg_daemon(status)` (optional) | RPC `status` · fallback `nmg daemon status --json` |

Do not hand-build the shared search, evidence or remember result strings in the
adapter. Import the pure functions from `src/integration/agent-surface.ts`:

- `renderSearchSurface` for compact candidates and the `activeGraphId`;
- `renderEvidenceSurface` for exact records and bounded logical structure;
- `renderRememberSurface` for bounded semantic follow-up candidates;
- `renderTaskBoardSurface` only when maintaining a separate legacy board tool.

The unified `nmg_state` surface owns current AG and Task Board operations. Render
its result through `src/integration/state.ts`'s `renderStateOutput` or the host's
shared state wrapper; do not fork its field names, permissions or state machine.

`compactSearchContext` remains the structured compact DTO for shell/automatic
recall paths. It contains semantic candidate headers and operational continuation
handles, never storage tiers, scores, QPP internals, timings, or token estimates.
Native TypeBox, Zod, or JSON Schema definitions stay in the host;
shared action enums come from `tool-contract.ts`. Host code may add lifecycle
notices or host-only actions, but it must not fork field names, withdrawal
redaction, chain rendering, or remember/board semantics. A new tool therefore
needs one shared surface implementation and contract test, then only thin host
registration wrappers.

Benchmark adapters use the same boundary. They may preserve an official
request/response envelope and structured audit fields, but model-visible memory
text must come from the shared Agent Surface rather than an eval-specific
ranking/rendering mode.

Rules every adapter must preserve:

- `search` returns compact headers + `activeGraphId`; exact statements and evidence
  stay behind `get`.
- For routine state work, expose `nmg_state` with the `ag` and `board` spaces.
  Do not present a separate board tool or Lab invocation as the normal state
  entry point. A legacy `nmg_board` surface may remain for compatibility, but new
  adapters should route board operations through `nmg_state`.
- `get` forwards the `activeGraphId` so actual use is recorded, not mere exposure.
- Search headers expose logical-chain names per candidate and the represented
  chain count. Exact `get` consumes the shared Agent Surface, which delegates to
  `src/integration/chain-projection`
  to render each evidence statement once, prefix records with its returned
  response-local label, and append the bounded label-only DAG. Do not implement
  host-specific edge grouping or reuse these labels as stable IDs.
- A shell-only adapter may use `search --compact-json` for chain names/count and
  `get --json` for canonical `chainMemberships`/`chainEdges`. Benchmark renderers
  may retain official output formats but must not redefine the product contract.
- the board is temporary cross-agent coordination, never durable memory.
- the adapter never owns or stops a shared daemon — the one-shot CLI reuses it.

### Temporary AG state and Task Board

Use the unified `nmg_state` entry for temporary state. Enable the AG writer lease
through `action="write", space="ag", operation="enable"`; then replace the
complete current text or clear it. The Task Board uses the same entry with
`space="board"` and its domain operations. These are separate owners and state
machines, not one shared graph. Keep the operation enum, per-space permissions,
input fields and result shapes from `src/integration/state.ts` and the public
[state-space contract](../../../docs/design/state-spaces.md).

An AG replacement or clear must carry the binding captured for that lease outside
model-authored input. Use `captureStateInvocation` from
`src/integration/state.ts` (or the equivalent shared host helper) before
transport. Preserve a supplied fence across retries; never re-read status to
borrow a newer activation. A binding fences context changes; it is not
authentication. Do not silently fall back to another writer after capturing a
state mutation. The ordinary daily entry point is `nmg_state`; Lab is not the
normal interface for working-state updates. See
[optional capabilities](optional-capabilities.md#daily-work-status) for status
maintenance, and its [Lab section](optional-capabilities.md#session-lab-capabilities)
for optional experiments and administrative compatibility paths.

State carriage into model input is a separate, host-specific contract. Use
`integration/working-state-input.ts` only where the host has an admitted carriage
path. Pi carries one labelled state block once per user turn in the persisted
`nmg-context` message; it does not re-inject state through a `context` hook on
every inference. Final provider-input confirmation remains unsupported. Do not
infer carriage from a successful state write, prepared view or tool result, and do
not remove mixed recall or tool history. Other hosts must report their actual
input behavior rather than inheriting Pi's contract. The shared preparation
never writes disclosures. See the
[runtime input contract](../../../docs/design/session-active-graph-runtime-design.md#dedicated-state-carriage)
for protection, budget and compaction limits.

### Automatic recall (optional)

A tool surface does not itself make the model search. Where the host has a
suitable lifecycle integration, an adapter may run a bounded search for each new
user turn and expose the **Active-Graph header projection** (compact headers plus
`activeGraphId`) through the host's supported context mechanism. Keep exact
statements and evidence behind `get(activeGraphId)`, which records actual use on
the AG trace; merely showing an injected header is not use. Bound the search,
fold repeated IDs according to the shared disclosure contract, and let the user
turn proceed when recall fails.

Automatic context preparation uses one absolute five-second waiting budget, not a fresh allowance per RPC. Keep timely completed candidates if a later phase expires, propagate cancellation where supported, and do not imply that a timeout preempts synchronous SQLite work or stops remote work. Explicit model-requested search is outside this automatic deadline. Use the [waiting-budget contract](../../../docs/design/session-memory-lifecycle-hooks-2026-08-10/automatic-recall-budget.md) for checkpoints, remaining-budget admission and daemon limits.

The right insertion mechanism is host-specific. The DSH package in this
repository starts recall when the user message enters the inbox and supplies the
result through DSH's `systemPrompt.context`; Pi uses its own persisted
`nmg-context` message path. Do not fabricate user messages when the host provides
a supported context API. A projection handle is valid only when the hook and
model-facing tools share the same host session identity. A detached WorkBuddy hook
uses the namespaced `workbuddy-hook:<sessionId>` identity and emits a projection
handle owned by that separate AG; do not pass that handle to tool-side `nmg_get`.
The current hook path does not issue a `release` RPC, so do not claim immediate AG
cleanup. The Agent must call tool-side `nmg_search` before `nmg_get`; never weaken
session ownership to reuse a hook-created handle.

Use the resident daemon for operations whose adapter contract supports JSON-RPC,
with bounded waits for automatic recall. A CLI fallback is operation- and host-
specific; do not promise that every state mutation can fall back to a new process.
Never let a slow or unavailable memory layer block the user turn.

## DeepSeek Harness (repository package)

This repository's DSH adapter is the dual-face package at
[`dsh/dsh-nmg/`](../../../dsh/dsh-nmg/README.md). Its host half registers the
NMG tools and automatic recall; its browser half renders persistent tool cards.
The package composes through DSH's host plugin mechanism, so the older agent-preset
recipe below is not the installation path for this repository.

From `dsh/dsh-nmg/`, build the package before starting the host:

```sh
pnpm install --frozen-lockfile
pnpm run build
```

Then install the local package into the web profile and restart DSH:

```text
dsh plugin --profile web add link:<path-to-this-repository>/dsh/dsh-nmg
```

The build emits `lib/index.js` and `lib/client.js`; `lib/` is generated and is
not committed. The `cordis.patch.yml` inserts the package into web host
composition. Do not edit an installed copy under a deployment directory or
assume that building/reloading updates the host automatically. The package's
README and source own current setup and behavior.

The DSH host adapter registers `nmg_search`, `nmg_get`, `nmg_remember`,
`nmg_state`, `nmg_lab` and the optional daemon health tool. Board operations use
`nmg_state` with `space="board"`; working-state operations use `space="ag"`.
The package starts bounded automatic recall before the turn's first context
assembly and exposes it through DSH's `systemPrompt.context`. That recall path is
not proof that DSH also carries maintained AG working state into the model input.
The Pi per-user-turn carriage contract must not be projected onto DSH.

Do not use the removed preset instructions, `harness-adapters/deepseek-harness/`
module paths, dynamic `cordis_define` trial recipe, or manual `createUserMessage`
construction as this repository's current DSH setup. Those instructions describe
a superseded integration and are not a supported fallback.

## Manual CLI path

For operations supported by the CLI, a harness with shell access can use it directly (`pwsh` on Windows):

```powershell
node bin/nmg.mjs daemon status --json
node bin/nmg.mjs search "How should answers be written?" --limit 8 --compact-json
node bin/nmg.mjs get <mid> --active-graph-id <id> --json
node bin/nmg.mjs remember "User prefers concise answers" --node "Response preferences" --type preference
```
