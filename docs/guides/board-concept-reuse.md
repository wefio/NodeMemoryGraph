# Reusing collaboration concepts on the existing board

[中文](board-concept-reuse.zh-CN.md) · [Terms used](board-concept-reuse.terms.yaml)

Use this reference when a collaboration need resembles a DSH prototype concept.
Start with the existing NMG operation below. A catalog entry is a reference, not
an instruction to add a field, table, tool, state machine or scheduler.
The [event contract](../design/board-event-records.md#concept-adoption) owns adoption criteria.
This guide changes no runtime behavior and does not declare draft task semantics implemented.

## Prototype concept shelf

Reference: [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype),
main-branch documents and types inspected on 2026-11-01; these links are mutable.
The short descriptions below identify concepts, not their full upstream lifecycle rules.

| Input and communication concept | Question it separates |
| --- | --- |
| Source | Where does input originate, and who owns its read position? |
| Trigger | Which individual immutable input arrived? |
| Thread | Which ordered discussion supplies context? |
| Correlation | What related context can be consulted? |
| Channel | Where can an external reply be written? |
| Subscription / Fan-out | Which relationship routes updates to which work? |

The upstream [domain model](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md)
distinguishes these from work identity and calls Source, Thread, Eval, Mandate and
Subscription its core domain. NMG need not reproduce that aggregate layout.

| Admission concept | Question it separates |
| --- | --- |
| Policy / Policy version | Which admission rules apply? |
| Eval / Gate / Assessment | What is the evaluation process, deterministic admission check, and model judgment? |
| Decision | What did the evaluation decide? |
| Mandate / Scope / Strength | What work was authorized, within what scope and on what basis? |

Source: [authorization](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md).
These are not synonyms for NMG's artifact acceptance or ordinary decision messages.

| Work and continuity concept | Question it separates |
| --- | --- |
| Ticket | What work persists independently of its executor? |
| Assignment | Which particular execution binding is responsible? |
| Executor / Session / Execution environment | What runs the assignment, in which conversation and environment? |
| Input | What context is delivered to the work? |
| Disposition | Where did input go, and was it taken up or handed back? |
| Report | What does the executor report? |
| Attention | What explicit question awaits a person? |
| Follow | Which external object's closure matters to the work? |

Source: [model types](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/core/model.ts)
and [execution](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md).
Agent, Main Session and Executor Session describe upstream actors and execution roles;
they are not a required NMG organizational hierarchy.

Effects, Outbox, receipts and DomainEvents are reliability mechanisms behind these
concepts, not additional management positions. The upstream [architecture](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md)
and [ports](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/core/ports.ts)
separate domain transactions from queued external work. Their concrete retry,
resume, human-priority and PR-closing policies are not adopted by this guide.

## Use the existing foundation

| Need | Existing NMG route | Boundary to preserve |
| --- | --- | --- |
| Share findings or request a decision | Board `note`, `result`, `question`, `decision` entries in an addressed channel | Ordinary text records intent; it is not execution authority or an accepted artifact |
| Keep a collaboration's arc | `eventCreate`, revision-checked `eventUpdate`, `eventRead`; associate channels and resources | A coordination event is a continuing process, not one DSH Trigger |
| Relate discussion without waking everyone | Event/channel association; read relevant context | Association is not notification; NMG channels are not DSH's write-only Channel addresses |
| Invite collaborators or follow changes | Existing direct, channel and event notification scopes, invitation and subscriptions | Invitation/subscription does not claim work; ACK does not create another wake |
| Offer work and transfer responsibility | A claimable `handoff` entry and existing claim/release, attempt and lease operations | A board entry is not automatically a durable Ticket; `taskId` is a channel address |
| Submit and evaluate a result | Existing delivery reference/digest and independent judge/verdict | Receipt, self-reported resolution and independent acceptance remain different facts |
| Execute a declared dependency | Existing constrained OoO task/run and artifact bindings where supported | Event `dependencies` does not itself schedule or unlock work; Task IR remains a derived view with draft extensions |
| Show relevant context | Existing InformationView projection and budget | Rendering does not grant authority, commit acceptance or prove final provider delivery |

Operation syntax and subscription behavior remain owned by the
[board workflow](../../skills/nmg-memory/references/board.md),
[event notifications](../design/board-event-records/event-subscription-and-notification.md),
and [task declaration mapping](../design/task-unit-semantics/task-ir-vocabulary.md).
The [view contract](../design/state-spaces.md#unified-context-information-items)
owns presentation. Reuse these owners rather than building aliases for their fields.

For example, an event can associate a design channel and a verification channel.
Publish the findings as a note, send an explicit invitation when input is needed,
and offer a separate handoff if execution is requested. Receiving that invitation
is not accepting the handoff. Delivery and judgment use their existing operations;
closing the discussion event does not complete other participants' work. This flow
needs no new Ticket or Assignment API.

## Revisit only with a concrete missing case

| Candidate extension | Evidence that would justify reopening it |
| --- | --- |
| General Ticket / Assignment objects | A task must survive current entry retention or several execution bindings cannot be distinguished using the current owner |
| Input / Disposition ownership | A reproducible handoff loses, duplicates or ambiguously assigns an input and existing receipts cannot resolve it |
| General Policy / Mandate / Eval | A new intake path needs an authoritative, versioned admission decision not expressible by its current host contract |
| Executable dependency DAG | A concrete task dependency cannot be represented or checked by the supported task/run/artifact contract |
| New Outbox or effect queue | A demonstrated commit/delivery recovery gap cannot be handled by the existing delivery owner |

These are reference candidates, not a committed backlog. Check the owning
implementation and its supported boundary before declaring a gap. If a gap exists,
retain a failing scenario and extend that owner minimally, including version,
concurrency and recovery checks. Do not turn all semantic relations into DAG edges:
context, subscription and conflict relations are not execution prerequisites.
