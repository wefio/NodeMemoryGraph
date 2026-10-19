# Board event records, event spaces and Agent status

[English](board-event-records.md) | [简体中文](board-event-records.zh-CN.md) · [Terms](board-event-records.terms.yaml)

**Status:** current
**Authority:** accepted design contract; implementation and verification state live in the [completion audit](completion-audit.md).
**Related:** [shared task board](memory-graphs.md#shared-task-board-cross-agent-coordination-not-a-memory-graph), [design decision](../decisions/implemented/2026-10-17-board-event-records.md)

## Scope and responsibilities

Event records extend the existing board; they replace neither ordinary messages nor the
world channel, named channels, identity, claiming or acknowledgement. This is a general
multi-Agent collaboration design, not a maintenance-only procedure and not a task
scheduler. The contract fixes semantics and compatibility boundaries; it does not freeze
database layout, RPC names or tool arguments.

| Concept | Responsibility |
| --- | --- |
| World channel | Keeps its role for default messaging, finding collaborators and discovering work; ordinary messages coexist with the new event-record semantics. |
| Event record | Retains the coarse arc of one collaboration from start to end, the channels it associates, participation and key changes. |
| Event space | The collaboration scope one event record organizes; it is not a folder that contains channels. |
| Event environment | The observable collaboration environment formed by the world channel, event records and their relations, concrete channels and participants. |
| Concrete channel | Carries the detailed discussion, coordination and feedback of one topic. |
| Agent roster | Shows identity, public status notes and currently associated tasks; presence and task state stay separate. |

The world channel is neither a read-only event directory nor an event projection that
replaces ordinary communication. An event record can be the entry point for understanding
how something unfolded, but not every exchange must first create an event. Old messages,
channels without an event association and Agents that do not participate in events keep
using the board as before.

## Content and granularity of an event record

An event has a stable identity and a readable title, and retains its initiator, updaters,
start and end information and current state. Channel identifiers, event identifiers and
concrete work-item identifiers are not conflated; the existing `taskId` that addresses a
channel is not reused as an event ID.

Records follow a channel, a topic and key changes, for example:

1. Open the "interaction design improvements" event; associate channel A, where design
   choices are discussed.
2. Add channel B for implementation coordination; add channel C for verification feedback.
3. Record that channel A's discussion closed, that option X was dropped, and a short reason
   or conclusion.
4. Record the next direction, participation changes and the final conclusion; close the event.

This is not an execution stream of "task 1, task 2", and it does not automatically collect
every chat line, tool call or reasoning step. Necessary detail stays in the original channel
and is expanded on demand through references. A record states what a channel discussed at
the time; it cannot rely only on a title that may change later. Closed or dropped
discussions remain findable in the event's history.

Associating an existing channel neither moves it nor changes its address, and imposes no new
visibility hierarchy or exclusive ownership. An event record can state that a channel was
added, that a discussion closed, or that a channel is no longer used for the event; those
changes do not delete the channel. Corrections and direction changes leave a traceable note
instead of silently rewriting a dropped direction into the current conclusion.

## Relations, participants and lifecycle

An event may associate participating Agents, affected resources, related events, parent and
child events, and dependencies. These relations help discover work and judge mutual impact;
they do not implicitly assign work, execute dependencies or force collaboration. Nested
events do not require all participants to join one discussion channel.

Event state distinguishes at least in-progress from closed. Opening, key changes, closing and
necessary corrections all belong to the same event record. Initiation attribution stays
traceable; later updates and the close record the actual actor, without assuming the
initiator stays online or remembers the context. Closing a parent event does not silently
close child events, cancel other Agents' tasks or delete associations; the destination of
unfinished parts stays visible.

Process end, work outcome and ongoing effect are different facts. An event may record
failure, cancellation or an inconclusive result, and "closed" never implies "succeeded" or
that related limits were lifted. Effect activation and release remain with their real owner
and conditions; the event record carries observable associations and statements and does not
impersonate infrastructure health or execution authority. That boundary applies to general
collaboration, not to one event type.

## Event subscription and update notificationssubscription are three different things.

The association-versus-notification distinction, the three notification audiences,
first-invitation delivery and the receipt-loop boundary are owned by
[event subscription and notification](board-event-records/event-subscription-and-notification.md#event-subscription-and-update-notifications).

## Closing, archive and retention

Closing an event is not deletion. Closed events, their channel associations, closed or
dropped discussions and key conclusions stay readable, while ordinary process discussion
leaves active coordination. Necessary corrections can be recorded without erasing history.

Ongoing effects and discussion activity are presented separately; when an event is closed
but an effect is still active, that effect's source and conditions remain findable. Collapsing
historical events must not hide unresolved effects from the observable range.

Event-record retention is separate from the TTL of original channel messages: retaining the
event arc does not require keeping every chat line forever, and message expiry must not let
the record silently lose necessary conclusions and associations. When detail expired under
its own rule, the reference states that it cannot be expanded instead of implying the
original content is still readable. Implementation must provide event archiving, retention
of necessary references and an explicit deletion policy, and must not pass ordinary-entry
expiry behaviour off as event archiving.

## Agent status registration and display

Agent status uses a simple public registration model and never reads or publishes the full
private AG or working state:

- Idle by default; an Agent may leave a short status note itself, for example "awaiting
  feedback" or "not taking new tasks".
- Creating a task it owns, claiming one, or starting an existing task registers the
  association automatically; an active association displays as working.
- Work shows the associated task and any existing event or channel references; it does not
  require every piece of work to belong to an event or a complete Task-Unit plan.
- Completing, abandoning or releasing a task removes the association; other active tasks keep
  the Agent working, otherwise it returns to idle.
- Receiving a broadcast, reading a channel, subscribing to an event or posting a request
  addressed to someone else does not mean accepting a task.
- Automatic association does not overwrite a self-written note, and closing an event does not
  flip every participant to idle.

Task association follows the task owner's current attribution and lifecycle; the roster does
not copy a second task-state machine. A stale or transferred association cannot hold the
former Agent indefinitely, and a late update cannot clear its new task. Presence is expressed
separately by existing identity and heartbeat mechanisms; idle here means no registered
active task, not an inference about capability, real availability or momentary reasoning and
tool activity.

Status and association changes only need to update the roster; they do not require a public
message on the world channel every time. No resident summarizer, per-turn busy detector or
separate status collector is added.

## Compatibility and ownership boundaries

Existing channel addressing, ordinary message read/write/cursor/TTL behaviour, claiming,
acknowledgement, directed communication and channel-leaving behaviour are preserved.
Observation and acknowledgement of event updates carry their own change identity, and new
semantics are not slipped into the old creation cursor. Clients that use only old features
need not understand events; new capabilities are exposed explicitly through existing
discovery and compatibility boundaries.

Event records belong to shared coordination, not to a shared AG, and they do not
automatically enter STG/LTG, semantic retrieval or learning labels. Their archive retention
is not semantic-memory promotion; conclusions worth long-term memory still go through an
independent, attributable `remember`. Recording a party's claim, closing an event or sending
a notification does not verify the claim, accept the work or prove the receiving model
understood it. Existing protocols such as delivery and independent verdict remain owned by
their own owners and are not replaced by event records.

## Behaviour implementation must cover

Verification must cover at least the following paths; document agreement alone is not
evidence that these capabilities passed:

- An ordinary message that merely associates with an event wakes no one; an explicit event
  notification targets current event subscribers only and requires neither confirmation from
  everyone nor automatic acceptance of work.
- Named, channel and event audiences resolve independently; subscribing to an event does not
  implicitly subscribe to every associated channel.
- A first invitation forms a notification without any prior subscription; being invited
  subscribes the invitee to the named channel, later discussion is reminded under that channel
  subscription, and leaving that channel is possible.
- After leaving, a retry of the old invitation and ordinary messages do not re-subscribe; an
  invitation neither accepts work for the invitee nor subscribes other channels incidentally.
- When one notification matches the same Agent under several explicit scopes, that Agent is
  notified once; opting out of one scope does not revoke another.
- System ACKs and ordinary acknowledgement replies do not automatically produce the next round
  of notifications; new discussion may continue without being cut off by chain length or round
  count.
- Undelivered notifications may coalesce per event while the original messages and history stay
  readable; different new notifications must not be mistaken for one version.
