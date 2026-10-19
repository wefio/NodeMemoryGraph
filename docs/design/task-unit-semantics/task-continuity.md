# Long-task continuity and task view

[中文](task-continuity.zh-CN.md) · [Terms used](task-continuity.terms.yaml)

**Status:** draft
**Authority:** [Parent scope](../task-unit-semantics.md).

## Long-task continuity and task view

[SKILL.state v3](https://arxiv.org/html/2608.26263v3) builds each step's input from a fixed skill description, structured execution state and the latest observation. The runtime validates model-proposed state updates; intermediate reasoning is not carried across steps. Its limits include dropping information whose value emerges later and not yet validating concurrent multi-Agent updates. This design adopts explicit state for task continuity; a single-Agent result is not evidence of shared collaboration or OoO gains.

[The Horizon Gap v1](https://arxiv.org/html/2608.06663v1) distinguishes task horizon, context capacity and cross-task memory, and places planning, memory, execution recovery and evaluation in one lifecycle. Accordingly, this design tests parent-task completion and recovery. Local step success and process scores are diagnostic only; adding decomposition, memory or scheduling facilities does not itself improve long-task capability.

The continuity goal is that, at an explicit handoff boundary, another Agent with the required capability and permission can continue from the task contract, current facts and accessible evidence, without relying on conversation or internal reasoning the original Agent did not deliver. This is an end-to-end test of closed inputs and handoff-ready artifacts. It does not require arbitrary reasoning steps to be interruptible or every unit to switch Agents.

| Information | Owner and how it reaches the next step |
| --- | --- |
| Goal, permitted actions and completion conditions | The Skill and existing task contract provide instructions and constraints; do not add a skill-state language |
| Execution facts such as claims, delivery, judgment and cancellation | The board and shared execution facilities provide authoritative observations; derive current state under the run-record rules here |
| Relevant knowledge, evidence and assumptions to confirm | Each Agent's private [session AG](../session-active-graph-runtime-design.md) organizes context it is allowed to see; AG is not shared task state |
| Reusable cross-task experience and knowledge | NMG long-term memory retrieves by source and validity; it does not automatically become an accepted fact for the current task |
| The model's next input | The shared layer composes the contract, execution-fact view, relevant evidence and latest observation; a thin adapter passes it to the model |

A task view is an on-demand projection of these existing inputs, not another editable source of task truth and not the dependency-analysis view of Task IR. A model may propose an artifact, observation or assumption, but cannot confirm `accepted`, change a lease or override cancellation by submitting a state patch. Structural validation and protocol validation constrain shape and state transitions respectively; domain acceptance still checks the artifact. Development tasks use their existing RCP/check facilities; this design adds no independent OoO verifier.

Not carrying the full history does not mean deleting evidence needed for recovery or audit. The run-record rules below own durable facts and retention. AG projections can be rebuilt, and authorized retrieval can obtain relevant raw observations. If retrieval or reconstruction lacks necessary support, report the gap; absence from search does not prove an event never happened. A fixed number of fields also does not bound their contents, so this design promises neither constant context size for arbitrary tasks nor lossless compression.

This goal gives handoff, retry, fusion and scheduling a common basis: session reuse may reduce cost, but correctness cannot depend on information that exists only because a session was reused. It serves the existing board-collaboration path, adds no independent tool or enablement gate, and still requires the experiments below to verify actual continuation ability.
