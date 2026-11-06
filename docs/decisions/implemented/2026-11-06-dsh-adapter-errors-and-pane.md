# DSH adapter: domain errors, session binding, and a right-pane recall tab

[中文](2026-11-06-dsh-adapter-errors-and-pane.zh-CN.md) · [Terms](2026-11-06-dsh-adapter-errors-and-pane.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

The `@nmg/dsh-nmg` host adapter treated every daemon refusal as a transport
failure. `daemonCall` checked `!response.ok` before parsing the body, so a
JSON-RPC error carrying an actionable reason ("explicit STG writes require a
sessionId", "state AG requires an enabled host binding") was swallowed, the
daemon handle was cleared, and the call fell back to the CLI. The CLI repeated
the same request and reported the raw JSON-RPC envelope, so the model saw
`NMG exit 1: {"jsonrpc":…}` instead of the reason. A refused `nmg_remember`
also surfaced as `NMG daemon is unavailable for resolveRemember` when the
failure happened outside the CLI path.

Three smaller defects rode along. `nmg_remember save` never sent `sessionId`,
so session-scoped provisional writes were rejected outright. `nmg_get` reused
the `activeGraphId` from a previous turn, which belongs to the previous agent
session and is refused. `nmg_state` validated a shared board/AG parameter table
against the AG field list, so a model following the tool schema could trip
"Unsupported AG state field".

The browser half also carried a draggable, resizable recall pill floating over
the conversation. It obscured content, had no entry point in the frame chrome,
and duplicated information the side pane can carry without covering anything.

## Decision

Distinguish domain refusals from transport failures once, in `daemonCall`: parse
the body first and throw a dedicated `NmgRpcError` when it carries an `error`,
before any status-code branch. `invoke` and `invokeRpcOnly` return that message
verbatim instead of collapsing it into `NMG call aborted` or `daemon
unavailable`, and `daemonCall` keeps the resolved endpoint on a domain refusal
because the daemon is reachable.

`disclose` becomes best-effort: a refused disclosure degrades to "nothing has
been shown yet" rather than failing the whole recall. `nmg_get` retries once
without the id when the daemon rejects it as foreign. `nmg_remember save` sends
the session id. `nmg_state` filters an AG request down to `STATE_AG_FIELDS`
before validation, keeping the shared schema while validating each space on its
own terms.

The floating pill is replaced by a right-pane tab registered through
`sidebarRightTabs` (`nmg-recall`), rendering the same recall rounds newest
first, plus an activity ledger of recalls, searches, and evidence reads. The
host keeps that ledger in memory and serves it over `/nmg/recall`, falling back
to the session that produced the latest activity when the browser's session id
does not match the host's.

## Alternatives considered

- Keep the CLI fallback on any non-2xx response. It repeats a mutation the
  daemon already refused and hides the reason behind a spawn result.
- Let the model avoid AG-incompatible fields by instruction. The schema is
  shared; instruction-following is not a validation layer.
- Keep the floating pill and add a hide button. The pill still covers the
  conversation, and a second position-memory store is more code than a tab.
- Drive the right-pane tab from durable daemon traces. The tab is a live view of
  this session's adapter work; the daemon already owns the durable record.

## Consequences

Tool failures now name the reason and keep the daemon handle, so one bad call no
longer disables the fast path for the rest of the turn. Session-scoped writes
land in the right session. Recall survives a refused disclosure.

The activity ledger is process-local: it resets with the DSH host, and it is
capped at 60 entries per session. Recall history in the pane stays at the
existing five-round cap. Anything durable still comes from the daemon.
