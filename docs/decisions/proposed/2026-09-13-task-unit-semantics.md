# Separate logical task units from Agent execution placement

[中文](2026-09-13-task-unit-semantics.zh-CN.md)

**Status:** proposed
**Relates to:** [OoO bootstrap](2026-09-09-ooo-bootstrap.md), [speculation](2026-09-11-ooo-speculation.md)

## Problem

The fixed A/B/C experiment does not express when a task can be decomposed without losing its obligations. Making every fragment a separate Agent adds handoff and context cost; combining fragments without a contract can hide dependencies and acceptance boundaries. Existing wait measurements establish neither fusion gains nor profitable speculation.

## Proposal

Evaluate the [task-unit semantics](../../design/task-unit-semantics.md): explicit inputs, artifacts, effects and acceptance obligations, separate from execution placement. The first implementation slice is a shared pure-data compiler and finite offline execution model. It does not enable a scheduler or paid speculative calls.

The user-established boundary is shared collaboration semantics and tools, thin harness adapters, and the blackboard as their coordination carrier. Detailed decomposition, fusion and speculation rules remain hypotheses to validate. Reuse current tickets, leases, attempts and independent acceptance instead of creating another task-state authority.

The user identifies CPU out-of-order execution and instruction-level parallelism as the origin of separating semantic units from execution resources while preserving commit boundaries. The design makes that correspondence explicit and identifies where natural-language intent and model-session state break a direct hardware analogy.

Start with session reuse that preserves per-unit acceptance. Study speculation only over an explicit finite control fact, never over permission or missing artifact contents. A discarded branch requires a clean execution context. This proposal does not change the lifecycle or activation of the earlier speculation proposal.

Resolve storage as a daemon-owned, same-database transaction boundary: retain an immutable run manifest and facts absent from the board; derive OoO task state instead of creating an authoritative task-status table. Board claim, attempt, delivery and judgement remain authoritative. Referenced board evidence must survive ordinary TTL cleanup while the run is retained. Runners and adapters submit requests, not direct database writes. Detailed ownership and recovery rules live in the design.

Task IR is a computed view of existing contracts, not another input format. The design maps each concept to PatchTaskSpec, FrozenPatchTask, BoardTicket, cycle requirements and board kinds, marking unsupported semantics explicitly. Existing byte budgets and execution limits retain their units; new semantics extend their owning contracts before entering the view.

Reuse existing autodiff, HA and MGR for optional numerical scoring, context activation and hypothetical exploration, as specified in the design. Their outputs advise selection within legal actions; they do not own dependencies or acceptance. The deterministic baseline remains independent, and this record enables no new runtime capability.

## Alternatives considered

- One Agent per task: simple, but conflates semantic boundaries with resource costs.
- Arbitrary natural-language DAG: easy to author, but omitted reads and parent obligations are not checked.
- Fuse whole transactions: may save checks, but enlarges failure scope and can delay external consumers; defer.
- General next-task or artifact-value prediction: needs a much larger prediction and recovery contract; defer.
- Build a new harness or board: duplicates current ownership; excluded by the user's shared-layer constraint.
- Per-round authoritative databases: preserve the research launcher shape but require cross-store coordination when joining the shared board; reject for product integration.
- Persist a parallel OoO status table: saves recomputation but duplicates board facts and risks divergent acceptance; use disposable derived caches only after measurement.
- Keep only volatile state: loses actual outcomes and frozen inputs on restart; retain irreducible facts, not derivable conclusions.
- Build separate OoO learning/reasoning engines: duplicates existing owners; reuse bounded projections and existing engines instead, with benefit measured against the rule baseline.

## Acceptance criteria

The draft defines checkable unit and refinement obligations, conservative concurrency, per-unit fusion, assumption validation, context invalidation, and a controlled evaluation sequence. Implementation must demonstrate the finite-model counterexamples and cost accounting described there before integration. Document validation checks structure only; it does not prove these semantics or any performance claim.

Integration must also demonstrate cache-free reconstruction, consistent status/dispatch predicates, lease-boundary invalidation, same-database atomic writes, retained verdict evidence, and rejection of unsupported or unit-confused mappings. None of these storage changes is implemented by this documentation change.

## Risks

Declared effects can be incomplete unless tools enforce them. Model context is hidden mutable state; prompt instructions cannot erase a false assumption. Fine units can increase verification cost and reduce answer quality. A sound execution protocol cannot prove that a weak verifier captures the user's intent. High prediction accuracy does not justify deleting a dependency, and zero model tokens does not imply zero contention cost.
