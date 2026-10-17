# OpenCode V2 Adapter as a Thin Transport Plugin

[中文](2026-10-17-opencode-adapter.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [shared session flows in the integration layer](2026-10-16-shared-session-flows.md),
[harness adapters as thin transports](../../../skills/nmg-memory/references/harness-adapters.md)

## Problem

OpenCode is the second harness (after pi) that must run NMG without forking
capability logic into the adapter. The host API differs from pi in three load
bearing ways: plugins load inside a shared background service and cache their
modules per process; the plugin event stream emits neither `session.created`
nor `session.idle`; and provider step retries rebuild a request's context from
the transcript without any message a plugin pushed during the previous attempt.
An adapter written against pi's assumptions would silently lose injection on
every retry, never flush attribution, and leave sessions unmapped.

## Decision

`opencode-plugin/` is a thin transport plugin in the worktree style already
used for `workbuddy-plugin/`: the package root holds `index.ts`, `rpc.ts`,
`tui.ts`, and a `package.json` that resolves through its exports; project
installs are a `.opencode/plugins/` entry that may be a junction pointing at
the repo (verified transparent in OpenCode 2.0.32, for top-level `.ts` files
and directory packages alike).

- Transport only: every capability is imported from `src/integration/*` and
  daemon RPC; model-visible memory text is rendered by
  `src/integration/agent-surface.ts`. The daemon lease is opened through
  `src/integration/lease-transport.ts` (JSON-RPC over the active lease HTTP
  port), with the one-shot CLI as the fallback; the plugin never owns,
  starts, or stops the daemon.
- Tools register under the Code Mode `nmg` namespace, so hosts surface them
  as `nmg_search`, `nmg_state`, and companions, schema-checked by the tool
  contract row in `tests/integration/tool-contract.test.ts`.
- Automatic recall is staged at `prompt` admission (bounded by the ~1.5 s
  prompt budget) and delivered by mutable `messages` in the `context` hook as
  a system-role parts array; a string payload crashes provider lowering.
- Staged injections retain for the whole execution. Redelivery after a
  provider retry is decided by content — system-role messages are scanned for
  the recall preamble header — so a rebuilt request context gets the block
  again, while step-tool requests that already carry it do not. Teardown
  purges the staged state at `session.execution.succeeded`/
  `session.execution.failed` (and any `session.idle` other builds emit).
- Idle parity hangs off `session.execution.succeeded`: attribution flush,
  `registerAgent` heartbeat with an `opencode`-namespaced identity anchor,
  and injection teardown. A missing session row is treated as a root session
  (`child: false`); a `parentID` event upgrades it stickily.
- Project directory mapping comes from any event carrying
  `event.location.directory` (`session.inbox.delivered`,
  `session.tool.called`); the CSV-covering executor contexts carry no
  directory, and `NMG_PROJECT_DIR` remains the explicit override.

Localization notes recorded for the matrix page: the plugin event stream of
2.0.32 (`session.execution.succeeded`/`failed`, `session.retry.scheduled`,
`session.inbox.*`) replaces the pi-era `session.created`/`session.idle`
symbols; `ctx.tool.transform` with `{ namespace: "nmg", codemode: true }` is
the verified tool-registration call; the service-level plugin module cache
means plugin code edits only reach a fresh server (per `opencode run
--standalone`, or the next shared-service restart).

Validation ran against OpenCode 2.0.32 on Windows with the maimaidx free lane
serving `glm-5.3-flash-free`; the opencode-zen anonymous lane was unusable
(sustained upstream 403s for the published request shape). Standalone smoke
runs confirmed: setup and hooks fire on fresh servers, injected recall
headers reach the model, `nmg_search`/`nmg_state` calls through Code Mode
work end to end against the live lease, and `execution.succeeded` writes
`~/.nmg/agents/<session>/identity.json`.

## Alternatives considered

- Fork the pi flows inside the plugin. Rejected: duplicated policy drifts —
  the defect the adapter boundary names.
- One-shot consumption of staged injections. Rejected on measurement: the
  first retry lost the recall block (probed on 2.0.32), so delivery is
  content-scanned and execution-scoped instead.
- Arming redelivery from `session.retry.scheduled`. Rejected: the retry event
  can arrive after the first request already consumed the staged body; the
  event ordering is not a delivery contract. The marker scan needs no event.
- Push flows into the daemon and let the plugin forward fewer calls.
  Rejected for now: the recycle windows and injection staging are
  per-session in-process state with sub-second budgets; RPC round trips
  would add latency to every admitted turn.

## Consequences

- The capability matrix (`docs/design/harness-capability-matrix.md`) gets the
  opencode column from this record plus the smoke above; OpenCode is
  complete on the core recall/tool/attribution paths, partial where the host
  has no event or directory signal.
- Known partials: the first turn of a fresh server has no
  `session.location` yet, so its recall searches are unscoped until the
  first event maps the directory (second turn onward); attribution flush
  granularity is per execution rather than true idle; the TUI `/nmg` console
  and the wake loop are wired but not live-smoked here (wake logic is shared
  with pi and covered by `tests/integration/session-flows.test.ts`).
- Plugin code changes on an installed host only take effect for a fresh
  service process — a documented operational property of the shared service.
- `lease-transport.ts` and the tool-contract `opencode` row are shared with
  future adapters; `agent-context.yaml` and the format/`pre-commit` surfaces
  register `opencode-plugin` (enforced by `tests/tools/test-groups.test.ts`).
