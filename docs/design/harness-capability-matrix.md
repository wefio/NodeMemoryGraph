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
| Kimi Code hook | `kimi-plugin/nmg-hook.mjs` | [Hook setup](../../kimi-plugin/README.md); tools connect separately through MCP |
| DeepSeek Harness | `dsh/dsh-nmg/src/plugin/index.ts` | Current [host package](../../dsh/dsh-nmg/README.md) and [installation recipe](../../skills/nmg-memory/references/harness-adapters.md#deepseek-harness-repository-package) |

DSH has one current integration target here: the host package. The older
`dsh/nmg-plugin.mjs` preset is historical integration code, not a second current
adapter target. It is excluded from the comparison and Magpie parity plan.

The [Codex package](../../codex-plugin/README.md) combines native hooks and MCP
in one adapter. Its [native exercise](../experiments/runtime/codex-plugin-capabilities-2026-11-13.md)
records artifact installation and multi-session evidence.

## Matrix

| Capability | Pi | OpenCode | WorkBuddy | MCP | DSH | Kimi | Codex |
|---|---|---|---|---|---|---|---|
| Automatic recall (staged headers per admitted turn) | full | full | full | none | full | none | full |
| Memory tools (`nmg_search`/`get`/`remember`) on the shared Agent Surface | full | full | full | full | full | none | full |
| Working state (`space=ag` with the invocation fence) | full | full | none | full | full | none | full |
| Tool-result observation + weak completion nudge | full | full | partial | none | full | partial | partial |
| Attribution flush + agent identity heartbeat | full | full | partial | partial | full | partial | full |
| Board wake (poll → directed/world delivery) | full | partial | partial | none | partial | partial | partial |
| Interactive console (`/nmg`) | full | partial | none | none | none | none | none |
| Transport: lease fast path, CLI fallback, shared-daemon non-ownership | full | full | partial | partial | full | partial | partial |

Maintained-state carriage uses the same complete-body InformationView projection in Pi, OpenCode, DSH and Codex. Preparation remains unconfirmed; its native transport differs by host.

## Coordination extension

WorkBuddy and Kimi columns describe their hook alone; connected MCP tools add
the separately listed MCP surface. Kimi has no automatic memory search or state
carriage in its hook. A pre-execution reminder is not a successful-tool observation.

DSH refers to the same host package in both tables. These rows describe source
wiring, not deployment or a live idle-Agent/model test. `board-events` gates additive event/notification
fields; an older owner must refuse them rather than silently drop them.

| Capability | Pi | OpenCode | WorkBuddy | MCP | DSH | Kimi | Codex |
|---|---|---|---|---|---|---|---|
| Event records and public task status | full | full | none | full | full | none | full |
| Direct/channel/event notification payload and invite-driven channel enrollment | full | full | none | full | full | none | full |
| Discussion/event wake emission and enqueue-before-receipt | full | partial | none | none | partial | none | partial |
| Unified working state through `nmg_state` | full | full | none | full | full | none | full |

OpenCode and the DSH host package have private HTTP registration/forwarding
fixtures. Shared wake tests cover successful/rejected enqueue, no world
rebroadcast and no automatic claim. They do not establish live desktop idle wake
or model comprehension. MCP/CLI provide explicit reads, not push wake.
The [event contract](board-event-records.md) owns subscription boundaries.


Codex carries complete owner state and uses native transport session metadata.
Its board batches arrive on user prompts. Stop reports unknown processing state.
Tool observation handles native stdout and resolves recognized final exit metadata
from a bounded, session/turn-bound transcript read. Native Stop records versioned
answer-overlap diagnostics and can continue once with a budgeted board batch.
Background idle wake, interactive console and CLI fallback are unconnected.

## Per-adapter partials

- **OpenCode** — Native `session.get` resolves the session directory and child status before first-turn recall, with `ctx.location.directory` as a fallback and `NMG_PROJECT_DIR` as an explicit override. Failed lookup without any directory leaves scope unavailable. The attribution flush granularity is per execution
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
- **Kimi** — The event hook reports presence and polls for a board notice on user input, plus completion-keyword/pre-commit reminders. It does not search memory, expose memory/state tools, observe final tool results or flush answer attribution. Explicit tools come from a separate MCP connection; prompt-time polling is not idle wake. These are missing hook implementations, not claims about Kimi platform limits.
- **MCP** — the server starts its own daemon subprocess when none is running,
  reuses an existing daemon, and stops only what it started. There is no CLI
  fallback (the server guarantees its lease) and no turn-level observation,
  attribution, wake loop, or console. Shared `nmg_remember action=feedback`
  accepts explicit labels and returns the daemon's training result.
  Working state uses the shared fenced state API; board use heartbeats and
  reads write delivery receipts.
- **DSH** — The host package carries complete state and recall through `systemPrompt.context`, prepared at native request admission. `tools/result` feeds shared AG observation and commit nudges. Committed `assistant/message` plus completed `turn/end` flush diagnostic answer overlap once per turn. Aborted, foreign and duplicate events do not produce attribution. Desktop lifecycle edges and live wake remain separate validation tasks.

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
smoke evidence with API availability. Installed-core and loopback-host checks validate the bounded native wiring below. They do not establish every lifecycle edge or production deployment.

| NMG behavior | DSH native path and classification | OpenCode native path and classification |
| --- | --- | --- |
| Maintained-state carriage | **Can wire natively.** `systemPrompt.context` and admission refresh exist; installed prompt refresh/disposal passed. NMG prepares complete owner state at admission and carries it through this channel. | **Wired and exercised.** Prompt admission prepares complete owner state; `context` carries it independently of recall. An installed host sent the state to a loopback model. |
| Tool-result observation/nudges | **Can wire natively.** `tools/result` emits final success/error results; installed-service probe passed. NMG uses shared filtering, AG writes and weak completion nudges. | **Already wired.** `ctx.tool.hook("execute.after")` feeds shared observation/nudge logic. |
| Diagnostic attribution | **Wired at committed turn completion.** `session/event` supplies committed answers and completed `turn/end`. Installed-core execution and cancellation/deduplication fixtures validate this bounded path. | **Already wired at execution completion.** The original smoke verifies the path; it is not a proof of true idle or correctness. |
| First-turn scope | Current package binds actual Agent/session identity; further scope changes require native mapping checks. | **Wired and exercised.** Native SDK `session.get` returns location before recall. The installed-host run validates first-turn project scope; deadline tests reject late preparations. |
| Board wake and busy | **Native paths exist and are partly wired.** Agent status plus `send`/`followup`/`steer`; private fixtures cover NMG delivery. Live host enqueue and child-resume still need runtime validation. | **Native delivery path wired; live behavior needs validation.** `ctx.session.prompt` and execution events exist; queue/idle semantics remain to test. Gateway traffic is not a substitute. |
| Fork/reset/compaction fencing | **Needs integration validation.** Lifecycle creation source distinguishes startup/resume/clear/compact; map these to NMG incarnation/frame fences. | **Needs integration validation.** Manual compaction and subsequent state carriage pass the installed-host loopback run. Fork/reconnect generations and interrupted or automatic compaction remain unverified. |
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
