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

See [native host findings](#native-host-capability-findings) before treating an
unwired row as a host restriction.

When the shared layer gains a capability ([the flow modules](../decisions/implemented/2026-10-16-shared-session-flows.md)),
or an adapter wires one for the first time, move the cell here instead of
growing a per-adapter prose list. A cell change without its wiring change (or
vice versa) fails review; the row definitions stay judgement-light on
purpose, with the rationale in the linked decision records.

## Native host capability findings

The [OpenCode adapter decision](../decisions/implemented/2026-10-17-opencode-adapter.md)
already supplies the original runtime evidence behind this matrix. The
[native plugin audit](../experiments/runtime/native-plugin-capabilities-2026-11-12.md)
adds pinned DSH contracts, installed-core probes and OpenCode private API results.
It records source/package versions separately and does not overwrite historical
smoke evidence with API availability. These findings classify implementation
work; they do not promote the delivered cells above.

| NMG behavior | DSH native path and classification | OpenCode native path and classification |
| --- | --- | --- |
| Maintained-state carriage | **Can wire natively.** `systemPrompt.context` and admission refresh exist; installed prompt refresh/disposal passed. NMG dedicated state carriage is not wired. | **Can wire natively.** Existing `ctx.session.hook("context")` carries staged recall; extend shared state preparation into this path and test its distinct carriage rules. |
| Tool-result observation/nudges | **Can wire natively.** `tools/result` emits final success/error results; installed-service probe passed. NMG filtering/AG writes still need wiring. | **Already wired.** `ctx.tool.hook("execute.after")` feeds shared observation/nudge logic. |
| Diagnostic attribution | **Native entry points confirmed; integration needs validation.** `agent/turn-stopping`, `agent/status`, committed session events and assistant stream provide boundaries. Test final-event selection, cancellation and deduplication. | **Already wired at execution completion.** The original smoke verifies the path; it is not a proof of true idle or correctness. |
| First-turn scope | Current package binds actual Agent/session identity; further scope changes require native mapping checks. | **Native lookup available.** The private `session.get` returned location before any prompt. Calling the corresponding authorized path before recall is an NMG integration task; SDK mapping/deadline behavior remains to verify. |
| Board wake and busy | **Native paths exist and are partly wired.** Agent status plus `send`/`followup`/`steer`; private fixtures cover NMG delivery. Live host enqueue and child-resume still need runtime validation. | **Native delivery path wired; live behavior needs validation.** `ctx.session.prompt` and execution events exist; queue/idle semantics remain to test. Gateway traffic is not a substitute. |
| Fork/reset/compaction fencing | **Needs integration validation.** Lifecycle creation source distinguishes startup/resume/clear/compact; map these to NMG incarnation/frame fences. | **Needs integration validation.** Fork/compact/session APIs exist and compaction is wired; event ordering, reconnect and generation mapping are not established by API listing. |
| Claim-outcome witnesses | **Needs semantic/lineage validation.** Native tool identity exists; that alone does not make a result an admissible claim witness. | **Needs implementation/validation.** The NMG handler lacks the witness mapping. Existing tools/log APIs are candidates; no host impossibility is established. |
| Final provider-input receipt | **Unverified.** Prompt projection and log commits do not establish final provider receipt. | **Unverified.** Mutable context and successful execution do not establish final provider receipt. |

The following are confirmed restrictions of particular entry points, not proof
that whole NMG features are impossible:

- DSH context text providers are synchronous. Prepare asynchronously elsewhere
  and expose a bounded snapshot through the supported context channel.
- DSH `agent/request` replaces call configuration, not messages. Content uses
  logged context channels. `tools/result` observes rather than vetoes; an
  execution gate belongs in the pre-execute policy path.
- The historical OpenCode 2.0.32 run did not emit `session.created` or
  `session.idle`. Do not rely on those names. Session lookup and execution
  events offer native alternatives; exact lifecycle equivalence remains a test.

No reviewed evidence establishes a DSH/OpenCode core NMG feature that must be
outsourced to Magpie. The complete Magpie plugin remains an independent
provider. Composition can select native or gateway providers after their shared
contracts and handoffs are validated.
