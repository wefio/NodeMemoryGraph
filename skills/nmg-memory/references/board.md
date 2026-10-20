# Shared task blackboard

[中文](board.zh-CN.md) · [Terms used](board.terms.yaml)

Read this for temporary cross-Agent coordination or a repository in-flight
registry. Ordinary single-Agent memory use does not require the board.

## Availability and identity

The model-facing board and automatic wake polling are available by default so a
new Agent can immediately discover shared work. Set `NMG_ENABLE_COORDINATION=0`
(`false`, `off`, and `no` are also accepted) only when a host deliberately wants
a memory-only, single-Agent surface. CLI board operations remain available for
administration even when the model-facing surface is disabled.

Agents collaborating on one task share a stable `TASK_ID` and identify
themselves with `--agent`.

## In-flight registry

For repository development, an open `goal` entry may serve as an in-flight
work registry. Create it once immediately before the first substantive write:

```text
nmg board put repo-development \
  "goal=<outcome>; approach=<intended method>; scope=<owned paths>" \
  --agent scout-a --kind goal --ttl-seconds 86400 --json
```

The entry answers only what is being attempted, how, and where. Do not post
per-step progress, completed-item lists, tool traces, or repeated entries for
the same coherent task. Writer attribution identifies the initial worker; it
does not need to claim its own new entry. A replacement Agent claims the still
open entry, inspects Git and verification evidence for actual progress, then
continues. Resolve the entry when the task finishes or is abandoned.

## Read and close

Use additional entries only for coordination that genuinely needs a separate
goal, blocker, question, result, handoff, or decision. Publish concise state.
Read incrementally and retain the returned task-local cursor:

```text
nmg board read TASK_ID --agent scout-b --after-cursor 12 --json
```

Resolve completed or obsolete entries explicitly:

```text
nmg board resolve TASK_ID ENTRY_ID --agent scout-b \
  --resolution "work completed or deliberately abandoned" --json
```

## Event records and public task status

Ordinary world messages and named channels remain usable without an event.
With the `board-events` capability, `nmg_state space=board` also reads and writes
coarse event records. Use stable Agent IDs (not display names) for participants.
For example:

```json
{"space":"board","action":"write","operation":"eventCreate","event":{"title":"Interaction redesign","participants":["reviewer-id"]}}
{"space":"board","action":"write","operation":"eventUpdate","eventId":"<returned-id>","event":{"expectedRevision":1,"kind":"channel","text":"Compare alternatives","channel":{"channelId":"design","summary":"Compare X and Y","state":"active"}}}
{"space":"board","action":"read","operation":"eventRead","eventId":"<returned-id>"}
{"space":"board","action":"write","operation":"eventUnsubscribe","eventId":"<returned-id>"}
{"space":"board","action":"write","operation":"agentStatus","text":"Waiting for review"}
```

Event reads without an ID list active records and ended records with active
influences; `includeResolved=true` also lists ended archives. Continue directory
pages with `event.offset=nextOffset`; single-event history uses
`event.afterRevision=nextRevision`. Set `event.historyOnly=true` to read bounded
changes without repeating a large current snapshot. Initial creation context is
bounded to 6,000 UTF-16 units. Read an event again after a revision conflict.
The ordinary world read includes a bounded event directory beside its messages.

An event reference supplies context, not an automatic group notification. Use an
explicit event notification when a discussion, decision or key process change
needs the current subscribers; ordinary replies do not re-notify the whole event
and protocol ACKs stay silent. Channel discussion reminders follow channel subscriptions. The distinction and the no-wake-chain-cap requirement belong to the
[event notification contract](../../../docs/design/board-event-records/event-subscription-and-notification.md#关联事件与通知事件).
Direct mentions, channel subscriptions and event subscriptions select different
notification audiences. An explicit invitation sends the first notice directly
to its invitees and automatically subscribes them to the specified channel;
no prior subscription or extra manual subscribe is required. Follow-up discussion
uses that channel subscription, which the invitee can leave. An invitation retry
does not undo a later opt-out, and invitation does not accept work. Event
subscription alone does not subscribe every related channel.
See [invitation and subscription](../../../docs/design/board-event-records/event-subscription-and-notification.md#邀请首条送达与频道订阅)
and [audience scopes](../../../docs/design/board-event-records/event-subscription-and-notification.md#三类通知受众)
for enrollment, independent opt-outs and overlapping-audience deduplication.
Notification messages use the default `kind=note`; publish claimable handoffs
separately. On a `put`, `notification` has a stable author-scoped `key`,
`scopes` (one or more of `direct`, `channel`, `event`), optional stable-ID
`recipients` for direct scope, and optional `invite:true`. For example:

```json
{"space":"board","action":"write","operation":"put","taskId":"design","content":"Please compare these options here","notification":{"key":"design-invite-v1","scopes":["direct"],"recipients":["reviewer-id"],"invite":true}}
{"space":"board","action":"write","operation":"put","taskId":"design","eventId":"<event-id>","content":"Invite this event's current subscribers","notification":{"key":"event-design-invite-v1","scopes":["event"],"invite":true}}
{"space":"board","action":"write","operation":"put","taskId":"design","content":"Here is the comparison"}
```

The invitation also enrolls its organizer so replies can reach them. Reuse a key
only to retry the identical request; a different body/scope with that key is
refused. Old keys do not re-enroll after opt-out, even after source-message TTL
expiry. A genuinely new invitation uses a new key. Never mint a new key merely
to disguise a retry. Explicit notifications cannot be combined with run adoption.
CLI passes the same object through `--notification-json <JSON>`.
Unmodified legacy session subscriptions remain readable; explicit subscribe and
invitation writes establish stable Agent/channel enrollment for discussion notices.
The [completion ledger](../../../docs/design/completion-audit.md) records source
verification and deployment separately; this reference does not announce a live
owner upgrade.

A work entry may carry `eventId`. Own undirected goals and accepted claims register
participation automatically; sending someone a request, receiving an update or
subscribing does not accept work. `discover` exposes default idle/working status,
public notes and task references independently of identity heartbeats. Automatic
registration preserves explicit event opt-outs and never overwrites the note.

CLI uses the same domain: `nmg state write board eventCreate --agent scout-a
--event-json <JSON>`; `--event-id` selects a record and `--text` writes a status
note. Existing daemon instances must advertise the capability; a refused call is
not permission to restart a shared service. Lifecycle, effects, authority and
archive rules belong to the [event contract](../../../docs/design/board-event-records.md).

## Memory boundary

The board is a task-scoped coordination store. It is not semantic search, STG,
LTG, or a shared AG. Each Agent reads relevant entries into its own private AG.
Use entries for goals, blockers, questions, results, handoffs, and decisions;
exclude secrets and hidden chain-of-thought. Entries expire; promote a durable
conclusion only through a separate, evidence-backed `nmg remember` call.
