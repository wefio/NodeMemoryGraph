# Compatible event records and Agent task status

[中文](2026-10-17-board-event-records.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Board governance](2026-09-06-board-governance-addressing.md), [Coordination event contract](../../design/board-event-records.md)

## Problem

Messages, channel discovery and work-item ownership do not by themselves carry a
coarse, end-to-end account of a collaboration that moves across channels. A reader
needs to distinguish an active discussion from one that ended or was abandoned,
without reconstructing every task or depending on another Agent remembering to
announce a later change. Participants also need a simple way to display their
current work without publishing their private working context.

A maintenance episode motivated the investigation, but the requirement concerns
general collaboration. Replacing the world channel with a directory would remove
its ordinary messaging/find-Agent role rather than compatibly enhance it.

## Decision

This record accepts the design semantics in the
[coordination event and Agent-status contract](../../design/board-event-records.md).
Runtime evidence, deployment boundaries and remaining work belong in the
[completion ledger](../../design/completion-audit.md).

World communication remains available. Event records add a coarse process account
and channel associations, with event-scoped updates and opt-out subscriptions.
Their organization does not impose an execution scheduler or a maintenance workflow.
Association and notification are separate: an event reference supplies context,
while explicit discussion/decision requests and key process changes address the
current subscriber group. Ordinary replies do not automatically re-notify the
event group; protocol acknowledgements are silent. Channel discussions continue
through their channel subscriptions. Agents organize the collaboration;
there is no automatic wake-chain length, round or event-count cap, and no forced
manual-resume threshold. The topic contract owns the complete routing and loop-risk
boundaries. Named recipients, channel subscribers and event subscribers are
separate audiences. An explicit discussion invitation delivers its first notice
to the invitees without requiring a prior channel subscription and automatically
enrolls them in the specified channel, with opt-out. Follow-up discussion uses
that channel subscription, not an event-wide rebroadcast. Event subscription alone
does not subscribe every related channel. Invitation retries do not undo a later
opt-out; invitation does not accept work. Overlapping audiences do not duplicate
one notification.
Agent status uses default idle, an optional self-authored note and automatic task
associations rather than inferred model/tool activity.

The topic contract is the single semantic owner. Existing board, identity,
subscription, delivery, claim and verdict owners remain responsible for their
boundaries; the design does not replace them with a second shared memory graph.

## Alternatives considered

- Directory-only world: loses ordinary communication and cannot represent the
  process history the user requested.
- Channel folders alone: group locations but omit event identity, evolution,
  participants and lifecycle observation.
- Fine-grained task logs or a new scheduler: make collaboration mandatory and
  introduce detail the event record does not need.
- Maintenance-specific orchestration: confuses the motivating example with the
  general event-space requirement.
- Inferred busy/idle summaries or public private-state copies: add model cost,
  privacy exposure and ambiguity where explicit task association suffices.
- A fresh broadcast and confirmation chain for every change: duplicates state,
  depends on sender follow-up and reintroduces notification storms.
- Wake on every linked or directed message: confuses addressing with attention
  and allows new acknowledgement entries to keep calling peers back.
- Treat event membership as subscription to every linked channel: leaks discussion
  traffic across scopes and overrides independent subscription choices.
- Require channel subscription before the invitation can arrive, or leave an
  invitee unenrolled: loses the initial invitation or follow-up discussion.
- Hard wake-chain limits or mandatory human rearming: interrupt the autonomous
  self-organization the user wants instead of separating notifications from replies.

## Consequences

The design is additive: old messages/channels remain usable, and event history
provides optional organization and subscription. Process closure, outcome and
ongoing effects remain separate. Default idle describes the task registry, not
proof of availability; manual status notes remain independent.

The shared Store uses additive schema migration and revision-checked event
transactions. Versioned directed notices reuse delivery receipts instead of
turning every update into a task or a world broadcast. Shared host delivery
awaits successful enqueue before recording a receipt; asynchronous enqueue failure
leaves the notice retryable without consuming its budget. Task-owner associations,
historical participation and notification opt-outs are separate facts. Public
status is derived rather than maintained as another task state machine.

Discussion notifications use original message identities rather than a process
revision for every chat reply. Invitation enrollment and outbox publication commit
with the message. Minimal author/key/hash/source tombstones survive message TTL
so retry cannot rejoin a departed invitee; withdrawing a route retires its queued
alerts without withdrawing another still-valid route. Pending reminders coalesce
without deleting source discussions. Explicit notices use note messages, keeping
claimable work separate. Bounded, source-labelled wake previews do not impose a
conversation-round limit.

Participant mutation checks and recorded effect ownership are cooperation rules,
not facility authorization or truth verification. Event archives outlive ordinary
message TTL and require explicit, reference-safe deletion. Existing host enqueue
and receipt boundaries do not promise exactly-once behavior across arbitrary
crashes or prove model comprehension.

Documentation checks establish structure and links only; source tests and host
integration establish their own narrower contracts. Deployment, live idle-Agent
wakeup, natural collaboration outcomes and coordination benefits are separate
from source validation. No shared service restart follows from this decision.

## Selective concept adoption

The DSH prototype offers useful distinctions beyond Ticket, Assignment and
Session. Recording its vocabulary avoids losing those options; implementing the
whole catalog would duplicate existing owners and introduce unsupported lifecycle
promises. The user chose to reuse the available foundation first and revisit
other concepts only when needed.

The [event contract](../../design/board-event-records.md#concept-adoption) owns
this extension rule. The [reuse guide](../../guides/board-concept-reuse.md) and
board workflow make current operations discoverable. The catalog records vocabulary;
it does not establish general Assignment, input ownership or DAG scheduling.
Wholesale adoption and a mandatory implementation backlog are rejected; leaving
concepts only in private conversation would make future reuse hard to recover.

## Phase agreement within an event

Agents can otherwise start implementation from an unconfirmed discussion or
interpret a redesign suggestion as an instruction to stop. Optional scoped phase
declarations make the shared activity boundary observable. Existing event revisions,
transactions, history, subscriptions and InformationView remain their owners;
a separate scheduler or supervising role would duplicate these responsibilities.

The [phase contract](../../design/board-event-records.md#scoped-collaboration-phase)
separates phase version from event version and binds agreement to a unique proposal.
Defaulting confirmation to participants is a conservative starting point; explicit
affected-participant sets allow local coordination under the collaboration agreement.
Those sets are declarations rather than verified organizational authority. Phase
state remains absent on events that do not opt in, avoiding a global mode change.

Execution permits, automatic roster activity and in-flight operation fencing remain
outside this increment. The [draft](../../design/board-event-records/collaboration-phase.md)
keeps those policy choices open. Domain/state tests exercise version checks,
confirmation, withdrawal, persistence, local scope and disclosure; they do not prove
live multi-Agent alignment or host enforcement.

## Scoped input-batch design extension

The collaboration draft includes source-bounded input batches and per-scope wake
coordination. Agents can respond to an incomplete set of available replies when
an adapter chooses only the first fresh entry. Coalescing a reminder while carrying
only its latest source also leaves earlier replies dependent on a separate read.
Both behaviors motivate retaining a pending source range and preparing several
eligible replies at a shared processing boundary.

The collaboration draft owns the candidate semantics. This addition records the agreed design direction.
Runtime batch delivery, concurrent wake coordination and failure recovery require
their own implementation and tests. Batch delivery is distinct from phase agreement.
[Input-batch draft](../../design/board-event-records/collaboration-phase.md#scoped-input-batches-and-wake-coordination)
