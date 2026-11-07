# Agent activity and reply batches

[简体中文](agent-activity-and-batches.zh-CN.md) · [Terms used](agent-activity-and-batches.terms.yaml)

**Authority:** [Board event records](../board-event-records.md).

## Session processing state

The blackboard owns a shared processing state for each Agent/session pair.
`agentActivity` reads and writes this state through `nmg_state space=board`.
The session is explicit so one busy session can coexist with another available
session of the same Agent. Task-derived `agentStatus.activity` continues to
describe registered work. Discovery exposes processing reports alongside tasks
and the public status note through session-labelled InformationViews.

Reports use `state=busy|idle|unknown` and `source=agent|harness`. An Agent can
declare busy independently of native Harness observation. Each source maintains
its own report, version and expiry. Any live busy report makes the aggregate
busy. With no busy report, a live idle report makes it idle. All other cases,
including expired reports, produce unknown.

Reports carry a union of declared capabilities across their live sources.
Capabilities describe available mechanisms, such as `batch-enqueue`,
`processing-observation`, `idle-boundary`, `resume`, `stdout-context` or an
Agent-provided coordination mechanism. Each Harness contributes the mechanisms
it supports. Additional blackboard semantics can operate through Agent reports
even when the Harness lacks native support. Capability names describe reported
support, with concrete host acceptance supplying delivery evidence.

A write takes `activity.state` and optional `source`, `capabilities`,
`ttlSeconds` and `expectedVersion`. The default source is `agent`. Omitting
capabilities retains that source's live capabilities. Supplying an empty array
clears them. Each accepted write creates a fresh version. An expected version
must match that source's live report or the write fails. Writers renew leases
while the observation or declaration remains valid and report idle on release.
Expiry makes a crashed writer's declaration recoverable through ordinary reads.

```json
{"space":"board","action":"write","operation":"agentActivity","agentId":"reviewer","sessionId":"session-1","activity":{"state":"busy","capabilities":["manual-coordination"]}}
{"space":"board","action":"read","operation":"agentActivity","agentId":"reviewer","sessionId":"session-1"}
{"space":"board","action":"write","operation":"agentActivity","agentId":"reviewer","sessionId":"session-1","activity":{"state":"idle"}}
```

These declarations share the board's cooperative identity boundary. A caller
chooses its report source. Runtime authorization and enforcement remain owned by
the host. Unknown explicitly records missing observation. Automatic batch
delivery defers on busy and may proceed on idle or unknown through the adapter's
available output mechanism.

## Pending replies and batch preparation

Channel discussion preserves each source-linked pending notice. Event update
reminders retain their event-revision coalescing rule. Subscription, direct
recipient, opt-out, self-echo, live claim, serial handoff and delivery eligibility
apply before the pending query's page limit. Delivered rows can remain readable
without pinning the next pending page. Historical notices already retired by
coalescing retain their recorded state and remain discoverable through history.

The shared preparer orders each event/channel scope by creation time, sequence
and ID, then takes one source from each scope in rotation. A bounded transport
page feeds one InformationView preparation. Every admitted source keeps its
notice ID, channel and author. Required labels and wrappers count against the
shared rendered-character budget. Budget omissions remain pending. Sources
beyond the transport page receive a continuation diagnostic when space permits.
Batch size follows available replies and the budget rather than participant
count or an all-participant barrier.

The batch freezes the selected source identities and rendered text for one
delivery attempt. Later arrivals stay available to subsequent batches. Per-session
singleflight coordinates overlapping ticks within the adapter process. Busy is
checked before preparation and immediately before returning the prepared output.
Busy sessions leave their notices pending while other recipients continue.

For event-linked notices, preparation reads the current event phase, phase
revision and status, then rechecks the selected events before dispatch. A change
rejects preparation for retry. The output carries that current phase snapshot
and marks the message's own phase provenance unknown. Phase agreement remains
owned by the [phase contract](phase-agreement.md).

## Host acceptance and receipts

The adapter submits the exact prepared fragment through its supported output
mechanism. Only sources admitted into that fragment receive delivery receipts,
and receipts follow successful acceptance. Each recipient has independent
receipts. A rejected output leaves every source eligible for retry and consumes
no wake budget. One accepted batch consumes one configured wake unit.

Daemons advertising `board-wake-batches` accept `recordDelivery.entryIds` and
commit the vector in one Store transaction. A failed transaction leaves the
whole receipt vector retryable. The single-entry form remains supported.
Legacy receipt transport falls back to individual writes after acceptance.
Delivery across a host/daemon crash boundary has at-least-once retry semantics.
Receipt creation records transport acceptance. Read acknowledgement, task
claiming and action retain their separate operations.

Pi and OpenCode contribute their native processing observations. DSH observes
available parent and continuable-child state and uses native message or resume
acceptance. Its web history retains the delivered sources for display, while the
native batch is submitted once. WorkBuddy reports unknown native processing and
offers stdout context. Preparing its text creates no receipts. Its CLI confirms
delivery after the stdout callback succeeds.

The processing check, phase check and native enqueue are separate observations.
Their ordering narrows races, while cross-process reservation and in-flight
tool fencing remain additional coordination mechanisms. Current implementation
owners are [activity parsing](../../../src/core/agent-activity.ts),
[persistent reports](../../../src/core/store/coordination.ts) and
[shared batch delivery](../../../src/integration/board-wake-batch.ts).
