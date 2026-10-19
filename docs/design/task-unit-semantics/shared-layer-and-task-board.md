# Shared layer and board

[中文](shared-layer-and-task-board.zh-CN.md) · [Terms used](shared-layer-and-task-board.terms.yaml)

**Status:** draft
**Authority:** [Parent scope](../task-unit-semantics.md).

## Shared layer and board

| Owner | Responsibility |
| --- | --- |
| Shared task-semantics module | Parse/normalize Task IR; check dependencies and effects, decomposition obligations and legal fusion candidates |
| Shared runtime | Freeze plans; select/dispatch; manage tickets, verification, publication, cancellation, cost and event records |
| Board and coordination storage | Cross-process discovery, handoff, claim and result references; update authoritative state through owner operations |
| Shared Agent Surface | One tool catalogue, parameter/result semantics and discoverable entry points |
| Thin harness adapter | Encode native tool schemas; start/recover/terminate sessions; call models; report capabilities and usage |

Event association and explicit subscriber-group notification are distinct; the [notification and
autonomous-collaboration boundaries](../board-event-records/event-subscription-and-notification.md#event-subscription-and-update-notifications)
are owned by the topic contract.

The board is a tool and carrier. It does not infer dependencies from natural-language entries or act as judge. The shared runtime uses board lease, attempt, `deliver` and `judge` operations for state transitions; the next section fixes persistence and write ownership.

A shared protocol does not mean every harness has equal execution capability. Adapters report capability. Without session reuse or isolation, fall back to independent execution; do not let adapters reinterpret correctness rules.

### Product entry: absorb OoO into existing collaboration facilities

The user-set product direction is to absorb OoO as an execution capability within collaboration: the board, shared task semantics, execution lifecycle and acceptance facilities own it. Agents use ordinary task handoffs; they do not select or call a separate OoO tool. The board carries handoffs, dependency/artifact references, claims and delivery. Shared semantics derive legal actions; execution facilities allocate, wait, reuse sessions and cancel; task-designated checks accept artifacts; the coordinator commits under the protocol. The board itself is not responsible for the whole executor or verifier.

Ordinary board text does not become executable automatically. Only a handoff entered through an existing operation, with an explicit task contract and execution authorization, participates in derivation and scheduling; extend existing owners for missing metadata. Do not preserve a separate plan, state and lifecycle through an `ooo` tool, dedicated channel, second task body or `board.runRound` wrapper. A research round is an experiment unit, not a prerequisite for ordinary collaboration.

The existing Pi `ooo_round` is only a migration-compatibility entry and ultimately leaves the product tool catalogue. During compatibility, reuse the same shared operations and authoritative facts; add no feature or dual-write path. The research CLI may remain for controlled sequential/OoO comparisons, but is not a required product entry. This defines the target; it does not claim that compatibility wiring or tool removal is complete. Remove the entry only while updating the tool catalogue, adapter, operating instructions and hidden-feature registry together.

Before exit, prove one ordinary collaboration path end to end: an Agent hands off a contract-defined parent task through the existing board; task semantics identify independent work; execution facilities reorder/execute it under resource constraints; the artifact returns through existing delivery and independent acceptance. Do not call `ooo_round` or the research CLI or create parallel task state. Verify an actually accepted artifact and dependency unlock; cover failure, cancellation and sequential fallback when there is no independent work. Confirm necessary query/cancel capabilities from the old entry are available through existing facilities before deletion. Do not speculate without authorization; without multi-slot or fusion capability, use a legal fallback path.
