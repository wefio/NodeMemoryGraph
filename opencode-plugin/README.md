# NMG adapter for OpenCode

A thin, transport-only adapter that connects [OpenCode](https://opencode.ai)
(v2 plugin contract, verified on 2.0.32) to the node-memory-graph daemon. The
adapter owns no memory capability of its own: recall staging, tool-flow
gating, attribution, board wake, and every model-visible surface live in
`src/*` and the daemon RPC layer (see
`skills/nmg-memory/references/harness-adapters.md`).

## Install

The package lives inside a node-memory-graph checkout and shares that
checkout's `src/`, so it should be loaded from wherever the repository is
cloned:

1. In the project's `opencode.json` (or `~/.config/opencode/opencode.json`)
   point `plugins` at the package directory:

   ```json
   {
     "plugins": ["C:/path/to/node-memory-graph/opencode-plugin"]
   }
   ```

2. Or link the whole `opencode-plugin/` directory into the project's
   `.opencode/plugins/` directory — a junction to the repo checkout works
   (junction transparency is verified: the host resolves the package's
   `package.json` export `.` to `index.ts`).
3. Optional: the TUI console (`./tui`) can be registered on the client side
   for a global `/nmg` menu (wake toggles only — session work stays in chat).

The plugin runs inside OpenCode's service process, which caches plugin
modules for its lifetime: after editing plugin code, unload the old server
(or use `opencode run --standalone`, which gets a fresh server per run) to
see the change.

Spawned tools are named `nmg_search`, `nmg_get`, `nmg_remember`, and
`nmg_state` in the Code Mode catalog (`namespace: nmg`).

## What it does

| Capability | Mechanism |
|---|---|
| Automatic recall | `prompt` hook stages a small-budget header search (`limit`≈13, `maxTier` 1, `graphHops` 1) per admitted user turn; the next `context` hook request appends the recall once as a trailing system-role parts message. Turn cost is fenced to ~1.5 s |
| Memory tools | `nmg_search` / `nmg_get` / `nmg_remember` render through the shared Agent Surface (`renderSearchSurface` / `renderEvidenceSurface` / `renderRememberSurface`); session-AG disclosure ledger dedups both injected and tool-surfaced candidates |
| Working state | `nmg_state space=ag` (read/status/replace/clear/enable/disable) with the shared `captureStateInvocation` fence |
| Task board | `nmg_state space=board` (put/read/claim/deliver/judge/subscribe/… + rename), world-channel lobby surfaced on world reads; `nmg_state` itself is SDK-neutral — see the lossy list below |
| Observation | `execute.after` observes memorable tool results into the runtime AG (`tool_observation`) and arms the weak completion nudge on a `git commit` |
| Attribution | `session.execution.succeeded` (plus any `session.idle` other builds emit) → answer-overlap attribution for recalled traces via `recordActiveGraphAttribution` (diagnostic only) |
| Board wake | Timer loop shared with Pi (`board-wake.json` / `board-wake-state.json` in the NMG data dir); delivery is a real user turn via `ctx.session.prompt` |
| Transport | Passive lease RPC (`<dataDir>/nmg.sqlite.server.json`) with one re-verify after failures; one-shot CLI (`node bin/nmg.mjs`) fallback for `search`/`get`/`remember` only |

## Capability notes (lossy item list)

- Staged injections retain for the whole execution: a provider step retry
  rebuilds the request context without them, so every rebuilt context is
  re-delivered (deduplicated by the recall preamble marker inside the
  pushed system message) until the execution completes.
- The tool executor context carries no project directory, and the OpenCode
  2.0.32 plugin event stream emits no `session.created`; sessions map to
  project dirs from the first event that carries
  `event.location.directory` — the first turn of a fresh server searches
  unscoped until then. `NMG_PROJECT_DIR` overrides explicitly.
- Wake emission is a real user turn and is routed to a recently-idle session
  from a small pool (subagent children excluded); `NMG_WAKE_PROJECT` narrows
  the pool. Directed (`to=`) entries only wake when the matching identity is
  in the pool.
- Bookkeeping RPCs (delivery receipts, disclosure, attribution, AG observe)
  have no CLI fallback — they need a live daemon lease.
- `claim_outcome` unsupported (no exact-match session-history API on
  OpenCode); evidence from a non-assistant actor degrades provenance via the
  `provenance_degraded` marker instead of pretending a bound witness.

## Environment

- `NMG_DATA_DIR` — NMG data directory (default `~/.nmg`)
- `NMG_AGENT_ID` / `NMG_AGENT_CAPABILITIES` — stable agent identity for the
  board registry (per-session identity otherwise)
- `NMG_ENABLE_COORDINATION` — `0/false/off/no` disables board tools and wake
- `NMG_WAKE_PROJECT` — restrict wake targets to one project directory
- `NMG_ROOT` — repository checkout root for the CLI fallback (derived from
  the package location otherwise)
- `NMG_AUTO_RECALL_LIMIT` / `NMG_AUTO_RECALL_TIER` — recall budget caps

## daemon

The adapter never starts or stops a daemon. Start one from a checkout:

```
nmg daemon start
```
