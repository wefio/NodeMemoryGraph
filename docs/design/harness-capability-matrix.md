# Harness adapter capability matrix

[中文](harness-capability-matrix.zh-CN.md) · [Terms used](harness-capability-matrix.terms.yaml)

**Status:** current

**Related:**
[the adapter boundary rule](design.md#42-modular-harness-adapters),
[shared session flows](../decisions/implemented/2026-10-16-shared-session-flows.md),
[the OpenCode adapter decision](../decisions/implemented/2026-10-17-opencode-adapter.md),
[the adapter recipe](../../skills/nmg-memory/references/harness-adapters.md)

## Rows and columns

One row per capability a harness can receive from NMG; one column per shipped
adapter. `full`, `partial`, and `none` describe what the adapter wires to the
shared layer and daemon RPC — the boundary rule in the design baseline decides
what the wiring is allowed to fork, so this page evaluates coverage, not
implementation quality.

Adapters compared:

| Adapter | Code | Contract home |
|---|---|---|
| Pi | `.pi/extensions/nmg/` | reference adapter — the baseline row |
| OpenCode v2 | `opencode-plugin/` | [adapter decision](../decisions/implemented/2026-10-17-opencode-adapter.md) |
| WorkBuddy hook | `workbuddy-plugin/nmg-hook.ts` | installable hook in `workbuddy-plugin/README.md` |
| Claude code (MCP stdio) | `claude-plugins/nmg-memory/agents/memory-copilot.ts` | [MCP plugin card](../../claude-plugins/nmg-memory/CLAUDE.md) |
| DeepSeek Harness | `dsh/nmg-plugin.mjs` | [dsh README](../../dsh/README.md) |

## Matrix

| Capability | Pi | OpenCode | WorkBuddy | MCP | DSH |
|---|---|---|---|---|---|
| Automatic recall (staged headers per admitted turn) | full | full* | full | none | none |
| Memory tools (`nmg_search`/`get`/`remember`) on the shared Agent Surface | full | full | none | full | full |
| Working state (`space=ag` with the invocation fence) | full | full | none | none | none |
| Tool-result observation + weak completion nudge | full | full | partial | none | none |
| Attribution flush + agent identity heartbeat | full | full | partial | partial | none |
| Board wake (poll → directed/world delivery) | full | partial | partial | none | none |
| Interactive console (`/nmg`) | full | partial | none | none | none |
| Transport: lease fast path, CLI fallback, shared-daemon non-ownership | full | full | partial | partial | full |

`*` usable without qualification; the qualifier lists the one lossy nuance.

## Per-adapter partials

- **OpenCode** — `*`: the first turn of a fresh server searches unscoped until
  the first mapped event supplies the project directory (second turn onward is
  exact); the attribution flush granularity is per execution
  (`session.execution.succeeded`) rather than a true idleness signal, and
  `claim_outcome` is unsupported (missing witness becomes a
  `provenance_degraded` marker); the wake loop wires through the shared
  `board-wake.ts` loop with a recent-session pool but was not live-smoked, and
  the client-side TUI module is registered on the client side only.
- **WorkBuddy** — the hook is passive: hint injection (compact recall headers
  with disclosure dedup from the hook payload), presence registration
  (`registerAgent`) per user turn, a board poll that returns one undelivered
  wake notice per invocation, and the git-commit nudge. Tool-result
  observation, working state, memory tools (they are left to the CLI/Skill
  path), attribution, and a console are not wired; the transport has no CLI
  fallback.
- **MCP** — the server starts its own daemon subprocess when none is running,
  reuses an existing daemon, and stops only what it started. There is no CLI
  fallback (the server guarantees its lease) and no turn-level observation,
  working state, attribution, wake loop, or console; board use heartbeats and
  reads write delivery receipts.
- **DSH** — five model-visible tools (`nmg_search`, `nmg_get`,
  `nmg_remember`, `nmg_board`, `nmg_daemon status`) over the shared
  transport (lease fast path with the one-shot CLI fallback). The CLI
  fallback path performs ordinary search without the learning side, there is
  no automatic recall, presence registration, observation, attribution, wake,
  or console by design: DSH exposes explicit preparation and search
  parameters.

## Maintenance

When the shared layer gains a capability ([the flow modules](../decisions/implemented/2026-10-16-shared-session-flows.md)),
or an adapter wires one for the first time, move the cell here instead of
growing a per-adapter prose list. A cell change without its wiring change (or
vice versa) fails review; the row definitions stay judgement-light on
purpose, with the rationale in the linked decision records.
