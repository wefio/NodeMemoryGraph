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

`none` means NMG wiring is absent, not that the Harness cannot support it.
For gap analysis, distinguish missing implementation, an unverified host path,
and an explicit host restriction. Only the last supports a claim of inability,
and it needs a versioned host contract or a scoped reproducer. Existing DSH and
OpenCode context/tool/event hooks establish useful extension paths; unconnected
NMG behavior remains implementation or verification work.

Adapters compared:

| Adapter | Code | Contract home |
|---|---|---|
| Pi | `.pi/extensions/nmg/` | reference adapter — the baseline row |
| OpenCode v2 | `opencode-plugin/` | [adapter decision](../decisions/implemented/2026-10-17-opencode-adapter.md) |
| WorkBuddy hook | `workbuddy-plugin/nmg-hook.ts` | installable hook in `workbuddy-plugin/README.md` |
| Claude code (MCP stdio) | `claude-plugins/nmg-memory/agents/memory-copilot.ts` | [MCP plugin card](../../claude-plugins/nmg-memory/CLAUDE.md) |
| DeepSeek Harness | `dsh/dsh-nmg/src/plugin/index.ts` | Current [host package](../../dsh/dsh-nmg/README.md) and [installation recipe](../../skills/nmg-memory/references/harness-adapters.md#deepseek-harness-repository-package) |

DSH has one current integration target here: the host package. The older
`dsh/nmg-plugin.mjs` preset is historical integration code, not a second current
adapter target. It is excluded from the comparison and Magpie parity plan.

## Matrix

| Capability | Pi | OpenCode | WorkBuddy | MCP | DSH |
|---|---|---|---|---|---|
| Automatic recall (staged headers per admitted turn) | full | full* | full | none | full |
| Memory tools (`nmg_search`/`get`/`remember`) on the shared Agent Surface | full | full | none | partial | full |
| Working state (`space=ag` with the invocation fence) | full | full | none | full | full |
| Tool-result observation + weak completion nudge | full | full | partial | none | none |
| Attribution flush + agent identity heartbeat | full | full | partial | partial | partial |
| Board wake (poll → directed/world delivery) | full | partial | partial | none | partial |
| Interactive console (`/nmg`) | full | partial | none | none | none |
| Transport: lease fast path, CLI fallback, shared-daemon non-ownership | full | full | partial | partial | full |

`*` usable without qualification; the qualifier lists the one lossy nuance.

## Coordination extension

DSH refers to the same host package in both tables. These rows describe source
wiring, not deployment or a live idle-Agent/model test. `board-events` gates additive event/notification
fields; an older owner must refuse them rather than silently drop them.

| Capability | Pi | OpenCode | WorkBuddy | MCP | DSH |
|---|---|---|---|---|---|
| Event records and public task status | full | full | none | full | full |
| Direct/channel/event notification payload and invite-driven channel enrollment | full | full | none | full | full |
| Discussion/event wake emission and enqueue-before-receipt | full | partial | none | none | partial |
| Unified working state through `nmg_state` | full | full | none | full | full |

OpenCode and the DSH host package have private HTTP registration/forwarding
fixtures. Shared wake tests cover successful/rejected enqueue, no world
rebroadcast and no automatic claim. They do not establish live desktop idle wake
or model comprehension. MCP/CLI provide explicit reads, not push wake.
The [event contract](board-event-records.md) owns subscription boundaries.

## Per-adapter partials

- **OpenCode** — `*`: the first turn of a fresh server searches unscoped until
  the first mapped event supplies the project directory (second turn onward is
  exact); the attribution flush granularity is per execution
  (`session.execution.succeeded`) rather than a true idleness signal, and
  this NMG binding does not establish the `claim_outcome` witness path (missing
  witness becomes `provenance_degraded`, not proof of a host restriction);
  the wake loop wires through the shared
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
  attribution, wake loop, or console. The remember action enum includes feedback,
  but its labels and dispatch are missing from this NMG server implementation;
  this is an implementation gap, not an MCP protocol restriction.
  Working state uses the shared fenced state API; board use heartbeats and
  reads write delivery receipts.
- **DSH** — the host package registers shared memory/state tools and uses inbox
  events plus `systemPrompt.context` for recall. It registers actual sessions
  and provides directed wake delivery. Dedicated working-state carriage, general
  tool-result observation and answer-attribution flush are not wired in this
  NMG implementation. Context and lifecycle entry points exist; assess and test
  native implementation before treating Magpie as required for these features.

## Maintenance

When the shared layer gains a capability ([the flow modules](../decisions/implemented/2026-10-16-shared-session-flows.md)),
or an adapter wires one for the first time, move the cell here instead of
growing a per-adapter prose list. A cell change without its wiring change (or
vice versa) fails review; the row definitions stay judgement-light on
purpose, with the rationale in the linked decision records.
