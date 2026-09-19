# Separate logical task units from Agent execution placement

[中文](2026-09-13-task-unit-semantics.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [OoO bootstrap](2026-09-09-ooo-bootstrap.md), [speculation](2026-09-11-ooo-speculation.md)

Implementation evidence: the design it evaluates is normative at [task-unit-semantics.md](../../design/task-unit-semantics.md), and its slices landed - the pair predicate (`sharedSessionLegal`), the retention that keeps referenced evidence readable (`retainTaskBoardEntry`), the host, the driver, and the board's claim/attempt/delivery/judgement records.

## Problem

The fixed A/B/C experiment does not express when a task can be decomposed without losing its obligations. Making every fragment a separate Agent adds handoff and context cost; combining fragments without a contract can hide dependencies and acceptance boundaries. Existing wait measurements establish neither fusion gains nor profitable speculation.

## Decision

Evaluate the [task-unit semantics](../../design/task-unit-semantics.md): explicit inputs, artifacts, effects and acceptance obligations, separate from execution placement. The first implementation slice is a shared pure-data compiler and finite offline execution model. It does not enable a scheduler or paid speculative calls.

The user-established boundary is shared collaboration semantics and tools, thin harness adapters, and the blackboard as their coordination carrier. Detailed decomposition, fusion and speculation rules remain hypotheses to validate. Reuse current tickets, leases, attempts and independent acceptance instead of creating another task-state authority.

The user identifies CPU out-of-order execution and instruction-level parallelism as the origin of separating semantic units from execution resources while preserving commit boundaries. The design makes that correspondence explicit and identifies where natural-language intent and model-session state break a direct hardware analogy.

Start with session reuse that preserves per-unit acceptance. Study speculation only over an explicit finite control fact, never over permission or missing artifact contents. A discarded branch requires a clean execution context. This proposal does not change the lifecycle or activation of the earlier speculation proposal.

Resolve storage as a daemon-owned, same-database transaction boundary: retain an immutable run manifest and facts absent from the board; derive OoO task state instead of creating an authoritative task-status table. Board claim, attempt, delivery and judgement remain authoritative. Referenced board evidence must survive ordinary TTL cleanup while the run is retained. Runners and adapters submit requests, not direct database writes. Detailed ownership and recovery rules live in the design.

Task IR is a computed view of existing contracts, not another input format. The design maps each concept to PatchTaskSpec, FrozenPatchTask, BoardTicket, cycle requirements and board kinds, marking unsupported semantics explicitly. Existing byte budgets and execution limits retain their units; new semantics extend their owning contracts before entering the view.

Reuse existing autodiff, HA and MGR for optional numerical scoring, context activation and hypothetical exploration, as specified in the design. Their outputs advise selection within legal actions; they do not own dependencies or acceptance. The deterministic baseline remains independent, and this record enables no new runtime capability.

Store owns synchronous transaction scopes and connection disposal. Round code receives a borrowed operation port, explicitly joins a current scope, and cannot begin, commit, roll back or close the connection itself. Nested operation failures poison the whole transaction even if caught; no savepoint recovery is introduced. Verification runs outside the transaction, with fences rechecked inside the final write. The design owns the full lifecycle and post-commit failure contract.

Status uses an owner-provided query port over the existing daemon connection. Offline hosts may own a separately opened read-only Store; both paths reuse the same query semantics. Missing databases, unsupported schemas and missing runs are errors, not empty runs. The design distinguishes read capability from connection mode and defines their separate checks.

The user fixes the product destination: existing board collaboration, shared task semantics, execution lifecycle and acceptance facilities absorb OoO. Agents use ordinary authorized task handoffs; an independent OoO tool is not the final interface. The design owns the migration and retirement criteria for the existing tool. This proposal's remaining implementation work does not make that destination an open choice.

## Alternatives considered

The user confirms that the primary evaluation concerns granularity, concurrency and fusion: compare a coarse parent task with a fine plan on one slot, the same plan on multiple slots, and legal session fusion. Continuation and redundant-work elimination are supporting investigations; storage and recovery support the exercised path rather than defining the research objective. The design owns the sequence and scope. This corrects the earlier requirement to complete the continuation comparison first; neither paper results nor the small-function continuation runs establish the primary hypothesis.

- Complete a general runtime and every continuation comparison before evaluating concurrency: delays the core question. Reuse existing board and task contracts, extending an owner only for a concrete semantic gap in the selected scenario. Decomposition may expose parallel work even when one executor can already finish the task.

- One Agent per task: simple, but conflates semantic boundaries with resource costs.
- Carry all history on every step, or replace it with a supposedly sufficient fixed state: the former grows context cost, while the latter can lose evidence needed later. Prefer derived task views with authorized evidence retrieval and retained authoritative facts; the design owns the continuation experiment.
- Arbitrary natural-language DAG: easy to author, but omitted reads and parent obligations are not checked.
- Fuse whole transactions: may save checks, but enlarges failure scope and can delay external consumers; defer.
- General next-task or artifact-value prediction: needs a much larger prediction and recovery contract; defer.
- Build a new harness or board: duplicates current ownership; excluded by the user's shared-layer constraint.
- Per-round authoritative databases: preserve the research launcher shape but require cross-store coordination when joining the shared board; reject for product integration.
- Persist a parallel OoO status table: saves recomputation but duplicates board facts and risks divergent acceptance; use disposable derived caches only after measurement.
- Keep only volatile state: loses actual outcomes and frozen inputs on restart; retain irreducible facts, not derivable conclusions.
- Build separate OoO learning/reasoning engines: duplicates existing owners; reuse bounded projections and existing engines instead, with benefit measured against the rule baseline.
- Implicit transaction-depth joining or per-round ownership flags: obscures who may commit and close; choose explicit scoped participation and disposal by the outer resource owner.
- Hold a transaction across a whole round, or recover inner writes with savepoints: prolongs locking or changes the all-or-nothing transition contract; use short synchronous transitions.
- A view mode on the initializing BoardAdmission class, or query_only on the shared connection: couples observation to initialization or disables legitimate writers; use a narrow borrowed query port and a separate owner-only offline opening path.
- Retain a standalone OoO tool or rename it to a board round wrapper: preserves a competing workflow and state model; absorb capabilities into existing owners and retire the compatibility entry after an ordinary board path is verified.

## Consequences

The slices this record named landed: the pair predicate, the retention that keeps referenced evidence readable, the host, the driver, and the board's claim/attempt/delivery/judgement records. What it deliberately did not enable - a scheduler and paid speculative calls - is still not enabled.

The draft defines checkable unit and refinement obligations, conservative concurrency, per-unit fusion, assumption validation, context invalidation, and a controlled evaluation sequence. Implementation must demonstrate the finite-model counterexamples and cost accounting described there before integration. Document validation checks structure only; it does not prove these semantics or any performance claim.

Integration must also demonstrate cache-free reconstruction, consistent status/dispatch predicates, lease-boundary invalidation, same-database atomic writes, retained verdict evidence, and rejection of unsupported or unit-confused mappings. None of these storage changes is implemented by this documentation change.

Transaction tests must cover independent and joined board writes, caught inner failures, stale/foreign transaction ports, forbidden asynchronous use, and notification failure after commit. Lifecycle tests must cover early cancellation, initialization failure, owner-only close, and a shared Store remaining usable after round disposal.

## Risks

Declared effects can be incomplete unless tools enforce them. Model context is hidden mutable state; prompt instructions cannot erase a false assumption. Fine units can increase verification cost and reduce answer quality. A sound execution protocol cannot prove that a weak verifier captures the user's intent. High prediction accuracy does not justify deleting a dependency, and zero model tokens does not imply zero contention cost.
