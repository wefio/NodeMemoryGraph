# Splittable, fusable Agent task semantics

[中文](task-unit-semantics.zh-CN.md) · [Terms used](task-unit-semantics.terms.yaml)

**Status:** draft
**Related:** [Constrained out-of-order execution](ooo-execution-bootstrap.md), [the task-unit decision](../decisions/implemented/2026-09-13-task-unit-semantics.md)

## Problem and goal

The protocol described here is the **Task-Unit Protocol**, a sub-protocol of **Protocol-Governed Collaboration**; see the [naming decision](../decisions/implemented/2026-09-20-name-the-collaboration-protocol.md).

A task unit is work that can be handed off, verified and independently voided. An Agent is an execution resource; the two need not map one-to-one. State the conditions under which work is valid first, then let the runtime decide who performs it and whether units run in sequence. That is how fine-grained concurrency and context reuse can coexist.

This design proposes an internal compiled view of existing task contracts (Task IR). It adds neither a user-facing input language nor a separate persisted schema. Its first test case is proposal work on a frozen repository. Natural language still states intent; structured fields state inputs, artifacts, permissions and checkable obligations. Intent that cannot be formalized remains subject to human or independent review; it is not a fact a compiler can prove.

The user-set architecture constraints are: collaboration capabilities and tool semantics belong in the shared layer; harnesses integrate through thin adapters; and the board carries collaboration. The decomposition rules, fusion mechanism and speculation design below remain to be tested. This document does not enable a feature, relax current constrained out-of-order execution, or claim a general multi-actor runtime exists.

### Main validation question and scope

The main question is whether dividing one parent task into legal units smaller than an Agent can expose concurrency hidden by coarse tasks, and whether fusion can offset the added handoff, context and verification costs. Evaluate bounded speculation only after there is evidence for concurrency and fusion. Splitting is not triggered only by a worker's inability to finish: a task one Agent can complete may still merit decomposition when its parts can run concurrently.

Prefer the board's handoff, claim, delivery, judgment, lease and attempt mechanisms, plus inputs, access scope and validation settings already present in task contracts. For fixed workflows whose host already declares dependencies, isolation and composition checks, these semantics may suffice. Extend an owner only when a concrete case cannot reliably decide dependency, effect or parent-obligation coverage. This concept list does not require a general task language or scheduler platform first.

Cross-session continuation tests handoff boundaries; identifying already-satisfied obligations may remove redundant work; transactions and recovery support practical integration. These efforts retain their own value, but do not replace the main granularity, concurrency and fusion comparison. Nor must every supporting experiment or full migration finish first. Any execution path must still satisfy permission, isolation, acceptance and lifecycle constraints.

## CPU out-of-order execution and ILP as a starting point

The user explicitly connected these constraints to CPU out-of-order execution and instruction-level parallelism (ILP): define legal instruction semantics before scheduling execution resources. Execution placement may change; the commit boundary remains. Tasks finer than Agent granularity and runtime fusion extend that idea to collaboration systems.

| CPU role | Question here |
| --- | --- |
| Observable instruction semantics | Task IR inputs, effects and acceptance obligations |
| Instructions/micro-ops separate from execution units | Logical tasks separate from Agent sessions; not a one-to-one hardware analogy |
| Data dependencies and readiness selection | Versioned artifacts, factual dependencies and constrained resource effects |
| Execution completion separate from retirement | Generation, verification and publication are separate |
| Branch recovery | Candidate invalidation, attempt fences and branch-context reconstruction |

The [BOOM reorder-buffer documentation](https://docs.boom-core.org/en/latest/sections/reorder-buffer.html) shows work completing before ordered commit, and recovery of committed rename state after an exception. The analogy here is the boundary that preserves observable state. The board is not a reorder buffer, and session reuse is not an implementation of CPU instruction fusion.

The analogy also exposes two research gaps: natural-language tasks lack an ISA's explicit semantics and resource accesses; model-session state cannot be assumed to roll back exactly. The design therefore adds constrained task semantics and recovery contracts, not more Agents as a substitute for ILP.

## Evidence boundary and analogies

The [wait-value experiment](../experiments/execution/wait-value-2026-09-12.md) covered only a fixed A/B/C plan. It separates waits covered by task work from overlap with host checks; it did not measure the payoff of splitting, fusion or speculation. It cannot support a claim that speculation is this project's largest performance lever.

Three mechanisms inform the design but are not evidence of Agent gains:

- [Legion privileges and dependencies](https://legion.stanford.edu/tutorial/privileges.html) computes dependencies from resource regions and access privileges, separating legal execution from processor mapping. The analogy is “semantics before resource placement,” not its deterministic-computation assumption.
- [Dask graph optimization](https://docs.dask.org/en/latest/optimize.html) fuses tasks to reduce communication. Here fusion is a cost optimization and each Agent task keeps its acceptance boundary.
- [Optimistic concurrency](https://learn.microsoft.com/en-us/dotnet/framework/data/adonet/optimistic-concurrency) checks the original state at update time. Here validation at commit is analogous: a matching version proves only that input did not drift, not that a model conclusion is correct.

<a id="声明存储与恢复"></a>

## Declaration storage and recovery

[Default declarations, frozen inputs and recovery refusals](task-unit-semantics/declaration-storage-and-recovery.md) owns the complete contract; run-record ownership still governs connections and transactions.

## Long-task continuity and task view

Read the complete responsibility: [Long-task continuity and task view](task-unit-semantics/task-continuity.md).

## Minimum legal task unit

Legal granularity is set by boundaries, not token count, file count or instruction length. A unit must meet at least these obligations:

| Obligation | Checkable expression | If unmet |
| --- | --- | --- |
| Closed inputs | Bind every required datum to a versioned reference; identify which task produced each prerequisite artifact | Wait or push back for missing input; do not fill it from shared conversation |
| Handoff-ready artifact | A bounded, typed, locatable proposal or evidence reference | “I have already thought it through” cannot unlock a successor |
| Closed permissions | Host-constrained readable resources, proposal write set and tool effects | Treat unknown effects as conflicts; do not trust a worker's self-report |
| Explicit acceptance | Host-selected validator and obligations; distinguish accept, reject and undecidable | Keep undecidable work unaccepted; do not call it success |
| Stoppable and voidable | Explicit attempt, lease, budget and cancellation boundaries | A late result may be recorded but cannot take effect |
| Composition fidelity | Explicit composition still covers every parent obligation | Passing child tasks does not mean the parent is complete |

A unit may be as small as “extract one interface fact from frozen source and cite its lines and digest,” if a successor needs that checkable fact. “Think about error handling” has no handoff-ready result and should remain inside a unit.

Legality and value are separate judgments. A very small unit may be legal but not worth dispatching by itself because of prompt, handoff or verification cost. Fusion addresses the latter; it cannot conceal the former.

## Task IR and existing vocabulary

Read the complete responsibility: [Task IR and existing vocabulary](task-unit-semantics/task-ir-vocabulary.md).

## Task refinement: split a parent contract

Read the complete responsibility: [Task refinement: split a parent contract](task-unit-semantics/refinement-and-concurrency.md#task-refinement-split-a-parent-contract).

## Deterministic concurrency and commit conflicts

Read the complete responsibility: [Deterministic concurrency and commit conflicts](task-unit-semantics/refinement-and-concurrency.md#deterministic-concurrency-and-commit-conflicts).

## Fusion: reuse resources, preserve logical tasks

Start with execution fusion: one Agent session runs several logical units in sequence, while each unit keeps its own ticket, artifact and host boundary. Do not start with transaction fusion or turn several units into one indivisible acceptance.

A fusion candidate must satisfy all five conditions:

1. Execution capability, authority and data visibility are compatible; session reuse does not widen read permission.
2. The successor starts only after its dependency is accepted; an unverified answer just produced by the same Agent does not satisfy it.
3. Each unit retains separate identity, deadline, cancellation check, verification result and cost. Record shared startup and context cost separately, without counting it once per unit.
4. Put a host-yield boundary between units. On failure, keep the accepted prefix and reschedule the remaining units; do not claim the whole batch at once and hold it indefinitely.
5. Do not reuse uncleared conversation history across an unresolved speculation branch.

The fifth condition is Agent-specific: rejecting a proposal does not make the model forget it. Even after tool permissions are revoked, the old session may keep answering from a false assumption. When a branch is invalidated, destroy its session or restore a supported trusted checkpoint; otherwise start a new session. Ordinary session fusion also requires compatible visible inputs, and its context bias must still be measured for quality impact.

The runtime may rank legal fusion candidates by “saved startup/context cost − added wait, verification and context burden.” The initial policy considers only ready short chains, not greedy absorption of a whole DAG. Include delay when work has other consumers or urgent independent tasks. Derive thresholds from experiments, not guesses.

## Strict semantics and bounded speculation

Narrow “guess what the Agent will do next” to “prepare a candidate ahead of one declared, finite-valued fact.” Keep three gates distinct:

| Gate | May it be crossed early? | Requirement at commit |
| --- | --- | --- |
| Data input | Not by default; missing content cannot be replaced by `true` | Bind the exact input and artifact version |
| Branch fact | Research only preparation of a discardable candidate with no external write | Authoritative evidence for the assumption, with a still-valid version |
| Permission/safety precondition | Never a guessable branch | Satisfied before the action executes |

For example, a test proposal T may use a frozen interface, while publishing T must wait for check event g. If T does not depend on g, moving pure preparation before g is dependency refinement, not speculation. If g decides whether T is needed, preparing T early is control speculation that may be wasted. If T must read a failure log not yet produced, guessing “failure” does not supply the missing input and cannot start the work.

The candidate ticket records `assumptions=[{predicateId, version, expected}]`. Inside the publish transaction the host checks each assumption against authoritative evidence, input versions, attempt, cancellation state and verification receipt. If evidence is uncertain, wait or return `undecidable`; if it contradicts the assumption, void the candidate. A summary only binds the assumption; it does not discover that it is false. The checks and invalidation propagation must be implemented. A long-running check executes outside the transaction; re-check its bound version inside to close the drift window after the check completes.

The first speculation experiment allows one pending fact, one candidate, no speculative successor and no irreversible external operation. A false assumption discards the candidate and closes its branch session; the real path reruns under a new ticket. Cap resources, cost and waits; necessary work always has priority. Consider propagating speculative chains only after this boundary is proven.

These semantics reduce the complexity of what must be predicted, but provide no predictor and guarantee neither hit rate nor net gain.

## Cost and relation to the earlier proposal

The [speculation decision](../decisions/implemented/2026-09-11-ooo-speculation.md) retains its lifecycle; this research does not enable it automatically. Two of its implications are not universal rules: zero tokens still consumes CPU, I/O and verification capacity, so benefit need not be non-negative; and repeated passing checks do not prove a dependency can be removed. Dependency removal needs a contract-level proof of non-dependence.

Report latency, extra cost and quality separately, not as one “benefit.” If one gate is necessary, declare the cost-conversion coefficient in advance and use this expression as an estimate, not a guarantee:

```text
estimatedUtility = p * savedCriticalPath
                 - (1-p) * recoveryDelay
                 - contentionDelay
                 - lambda * extraCost
```

`extraCost` includes additional calls, checks and session costs on both hits and misses. Derive `p` from calibrated data for comparable tasks, not the Agent's confidence. A covered wait is not necessarily a shorter critical path. Without a trustworthy estimate, keep scheduling deterministic work.

## Reuse autodiff, HA and MGR

Read the complete responsibility: [Reuse autodiff, HA and MGR](task-unit-semantics/autodiff-ha-mgr-integration.md).

## Shared layer and board

Read the complete responsibility: [Shared layer and board](task-unit-semantics/shared-layer-and-task-board.md).

## Physical ownership of run records and the sole writer

Read the complete responsibility: [Physical ownership of run records and the sole writer](task-unit-semantics/run-record-ownership.md).

## Next executable slices and stop conditions

Read the complete responsibility: [Next executable slices and stop conditions](task-unit-semantics/next-slice-and-stop-conditions.md).
