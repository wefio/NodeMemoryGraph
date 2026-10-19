# Task refinement and deterministic concurrency

[中文](refinement-and-concurrency.zh-CN.md) · [Terms used](refinement-and-concurrency.terms.yaml)

**Status:** draft
**Authority:** [Parent task semantics](../task-unit-semantics.md)

## Task refinement: split a parent contract

Splitting T into G=(T1,…,Tn,join) requires an explicit refinement record: a parent-contract summary, a mapping from obligations to child artifacts, retained joint obligations, and a join validator. Splitting cannot remove a parent obligation, expand a child's permissions or bypass authorization.

A candidate correctness condition is that every external result the join accepts, over all permitted child artifacts and interleavings, satisfies the parent contract; existing failure, cancellation and undecidable handling also remains valid. For nondeterministic Agents this does not require byte-identical answers under different schedules, nor prove equal success probabilities. Quality and completion rate need separate measurement.

Example: split “fix cancellation behavior” into extracting the frozen interface I, implementation proposal P, regression-test proposal T and composition check J. P and T may be independent only after I is accepted and the contract is sufficient. J depends on both accepted proposals and checks the composed behavior. If T actually needs P to invent an interface, P→T is a real dependency; different files do not remove it.

Stop splitting when another cut would lose a handoff-ready artifact, closed input or independent validation, or leave only an internal step not worth scheduling. The runtime may report unmet obligations, but does not invent intent missing from the parent task.

## Deterministic concurrency and commit conflicts

Separate reads of a frozen snapshot, generation of candidate proposals and changes to shared resources. Two workers may concurrently propose changes to the same file from the same frozen input. That shows generation can be isolated; it does not show the proposals can both be accepted or promoted.

For two actions that truly read and write the same versioned resource domain, a conservative sufficient condition is no data or control dependency and:

```text
W(A) ∩ (R(B) ∪ W(B)) = ∅
W(B) ∩ (R(A) ∪ W(A)) = ∅
```

Resources include more than paths: interface contracts, configuration, environment and external effects. Widen the conflict set for directory aliases, renames or unclear semantic scope. Commutative operations on the same resource are exceptions only when a composition rule is registered. Disjoint file write sets do not rule out interface-semantic conflicts; joint acceptance remains necessary.

Initially, publish in the frozen plan's stable topological order; generation and verification may run out of order. Acceptance of a private candidate and promotion to the shared repository are separate boundaries: promotion also needs a target-version check and joint acceptance. `accepted` on the board does not mean files have been merged. A more permissive serializable-promotion policy is separate research.

“Finding deterministic concurrency” means finding non-interfering work within host-constrained declarations, not automatically proving that every natural-language task is independent.
