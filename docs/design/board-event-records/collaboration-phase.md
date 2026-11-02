# Event semantics and collaboration phases

[简体中文](collaboration-phase.zh-CN.md) · [Terms used](collaboration-phase.terms.yaml)

**Status:** draft
**Related:** [event records](../board-event-records.md), [prototype concept reference](../../guides/board-concept-reuse.md)

## Purpose and reading boundary

This draft gathers the proposed extension of the event domain: help collaborating
Agents understand which activity is underway, what work may proceed, and which
ideas await a decision. It is a discussion basis, not an accepted runtime contract
or a fixed schema. Names, operations and policy choices below remain adjustable.
The existing event contract continues to govern supported behavior.

The motivating scenario is a shared design discussion where one Agent is still
proposing changes, another starts editing, and a third builds on an unconfirmed
proposal. The reverse also matters: during execution, a redesign suggestion leaves
participants unsure whether to continue. Shared phase semantics make that boundary
visible without requiring a permanent supervising Agent.

## Selective concept adoption

The [concept reference](../../guides/board-concept-reuse.md#prototype-concept-shelf)
keeps the broader DSH vocabulary and its source links. Ticket, Assignment and
Session distinguish persistent work, a particular allocation and an executing
session; they are examples, not the complete model or required new entities.
Other useful distinctions include input versus responsibility, context association
versus delivery, authorization versus advice, and report versus accepted outcome.

The direction is to absorb concepts that fill a concrete event-domain gap, reusing
existing messages, participation, resources, history and subscriptions. Remaining
concepts stay available for later needs. Phase is the collaboration proposal here;
this document does not attribute it to the DSH prototype.

## Scopes, relations and views

An event space is a possible owner for a collaboration scope. A child scope can
discuss a local design conflict while unrelated work continues. Whether a scope
always corresponds to one event, and how shared resources couple scopes, remain
open choices. Parentage alone is insufficient to define permission inheritance or
pause propagation.

Relations should retain their meaning: context association, participation,
subscription, parentage and execution prerequisite are different relations.
Only a selected execution-prerequisite subgraph needs DAG constraints; the whole
semantic graph need not be acyclic. A context link does not authorize work or
schedule a dependency. Existing OoO task/run semantics are a possible execution
foundation; they are not a predecessor of InformationView.

InformationView remains the presentation and disclosure surface. It can project
scope, phase, pending requests and source/version information under the shared
budget mechanism. Rendering does not decide authorization or commit a transition.

## Phase and participant activity

Start with two main phases:

| Phase | Typical activities |
| --- | --- |
| Discussion | Analysis, planning, negotiation, review and forming decisions |
| Execution | Implementation, modification, testing, verification and delivery |

Phase constrains activity, not every sentence. Implementation discussion can
continue during execution; replacing the agreed design may require a transition.
Planning and retrospective review can be discussion purposes rather than more
top-level phases. Repeated transitions are expected, with a visible boundary each
time. Phase stays separate from event open/closed state and work outcome.

The shared phase belongs to the scope. Participant activity is an observation
such as proposing, waiting, implementing or verifying. An Agent may participate
in several scopes with different phases. A discovery roster can show those
associations instead of assigning one global phase to each Agent. A participant's
self-report does not change the shared phase.

## Information outside the current phase

Recording an idea is not permission to act on it. Prefer reusing board messages
with purpose, scope and a visible disposition before introducing a separate queue.

| Current phase and incoming activity | Possible treatment |
| --- | --- |
| Discussion; request to start coding | Retain an execution request or propose a transition |
| Discussion; small experiment needed | Request limited permission for that experiment |
| Execution; new optimization direction | Retain a discussion candidate |
| Execution; serious plan error | Report the blocker and propose pause/transition |
| Execution; ordinary implementation exchange | Continue within the existing scope |

Pending items should remain discoverable until addressed, deferred or withdrawn.
The exact purposes and disposition vocabulary are open. A participant stopping
its own unsafe action differs from pausing other participants or changing phase.

## Propose, agree and switch

Three conceptual operations describe a transition; they are not fixed API names.

1. **Propose:** name the scope, target phase, reason, affected work and the phase
   version on which the proposal is based.
2. **Agree:** affected participants confirm under the scope's collaboration
   agreement. Confirmation refers to a specific proposal; material changes may
   require renewed confirmation.
3. **Switch:** the Harness validates the applicable conditions, commits the shared
   transition and notifies the relevant participants.

There is no default requirement for unanimous voting. A sole authorized participant
may switch independently; shared modifications need coordination among affected
participants. How to identify those participants, handle absence or disagreement,
and accept direct user authorization needs concrete scenarios. Silence should not
be interpreted as agreement by accident.

## Version consistency and execution boundaries

A scope needs a recognizable current phase version. A dedicated `phaseRevision`
is one candidate, allowing ordinary notes to change without invalidating execution
permits. This is an illustrative state shape, not a persistence or wire format:

```text
scope: interface-change
phase: discussion
phaseRevision: <current version>
pending: [execution request, discussion candidate]
pendingTransition: <proposal, if any>
```

Execution phase alone does not grant unrestricted resource access. Any execution
permit would still respect assignment and resource authority. A discussion-time
experiment could be limited by participant, operation, resources, phase version
and expiry without switching the whole scope.

Checking a version only when a tool starts is insufficient: an operation admitted
in execution may write after a switch to discussion. Strong enforcement therefore
needs a policy for in-flight work. Candidates include stopping new admissions,
waiting for a safe checkpoint, cancellation where supported, and rechecking a
permit before controlled commits. External irreversible effects require their
own boundary; a revision number cannot undo them.

`pendingTransition` could expose coordination and draining without adding another
business phase. Whether a switch waits for all relevant operations, or fences
their later commits, remains an integration choice. A displayed phase supports
coordination; enforcement claims require actual execution-entry and in-flight
operation support. Notifications alone do not establish that support.

## Suggested increment and questions to test

A first design increment can concentrate on scoped phase, transition proposals,
confirmations, version checks, retained requests and InformationView disclosure.
It need not introduce a general scheduler, a new management role, or every DSH
entity. Execution enforcement can be integrated by host capability with its limits
visible; this draft does not select a default enforcement level or migration policy.

Use concrete collaboration scenarios to settle the remaining choices:

- While A and B discuss, B's coding request stays pending until permission exists.
- During execution, C's optimization idea remains visible without redirecting A.
- A child scope enters discussion while unrelated execution continues.
- A stale proposal or permit is detected; ordinary notes do not unnecessarily
  invalidate otherwise valid work.
- An approved experiment stays within its scope, and an in-flight operation has
  an explicit destination when the phase changes.
- Participants leaving, restarting, or proposing competing switches do not turn
  missing confirmation into permission.

These are design probes, not a frozen acceptance suite. Open questions include
scope identity, authority inheritance, agreement rules, proposal replacement,
permit lifetime, restart recovery, and behavior for hosts without enforcement.
Refine the smallest useful semantics from those cases before fixing APIs or storage.
