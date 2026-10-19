# The contract's obligations, one node per line

[中文](task-unit-semantics-obligations.zh-CN.md) · [Terms used](task-unit-semantics-obligations.terms.yaml)

**Authority:** evidence ledger for `docs/design/task-unit-semantics.md` and its owned responsibility documents — each row is one obligation from those contracts; progress is counted in rows moved to `proven`, not in edits made.

Rows are in the linked responsibility sections below; the original “below” references
include those sections. [Historical verification readings](../experiments/verification/task-unit-semantics-ledger-readings-2026-10-14.md)
retain their original instruments and dates, not a claim that this relocation re-ran them.

Counts at this revision, computed from the rows below: **A** 6 proven; **B** 8 proven and B7 not applicable; **C** 4 proven; **D** 12 proven and D7/D10 not applicable because their round subject was retired; **E** 9 offline seam proofs, with no HA/MGR caller wired; **G** 2 proven, 3 partly covered, 1 owed and 1 measured on the research path. The F-arm status and its sample limits are summarized in the [experiment-arm record](task-unit-semantics-obligations/experiment-arms.md); the paid D arm is measured, while the E arm showed no realized gain. Numerical results and caveats belong to the linked [pilot](../experiments/execution/ooo-arms-pilot-2026-09-18.md) and [archive](../experiments/execution/archive/ooo-arms-2026-09-19/README.md), not to a claim that this ledger re-ran them.

## How to read this ledger

Rows follow the design order. `proven` means a named test asserts the rule and fails for its violation; `partly` means only part of the intended behavior or path is implemented or covered; `owed` marks a current gap; `measured` records a bounded experiment, not a product proof. Every claim is limited to the path exercised. See [the evidence boundary](task-unit-semantics-obligations/proof-evidence-boundaries.md) before transferring proof between research and product paths. A mutation tooth resolves a named rule, operator and syntax selector against current source; its definition and retirement criteria belong to the [mutant-anchor decision](../decisions/implemented/2026-09-24-mutants-are-derived-not-anchored.md). `npm run mutation:teeth -- --anchors-only` checks whether selectors still apply, not behavior.

## Where a proof lives: two evidence bases, and neither stands for the other

Read the complete responsibility: [Where a proof lives: two evidence bases, and neither stands for the other](task-unit-semantics-obligations/proof-evidence-boundaries.md).

## Product call-path audit (2026-09-20)

Read the complete responsibility: [Product call-path audit (2026-09-20)](task-unit-semantics-obligations/product-call-path-audit-2026-09-20.md).

## A. Offline semantics

Read the complete responsibility: [A. Offline semantics](task-unit-semantics-obligations/offline-semantics.md).

## B. Persistence

Read the complete responsibility: [B. Persistence](task-unit-semantics-obligations/persistence.md).

## C. Recomputation

| node | obligation | state | evidence |
| --- | --- | --- | --- |
| C1 | Deleting every derived cache yields the same view | proven | `tests/integration/ooo-task-tables.test.ts`; mutant `derived-rebuild-is-a-no-op` |
| C2 | A lease crossing its boundary invalidates the old view | proven | `evals/ooo-execution/recovery.test.ts`; mutant `stale-claim-may-deliver-again` |
| C3 | Concurrent readers of one ready task: one legal claim | proven | `tests/integration/ooo-managed-fence.test.ts`. The test now reaches the board directly as well, because the round's own `live()` check refuses first and a mutant that broke only the store would have survived: a second reader on its own connection calls `claimTaskBoardEntry` and is refused, which is what makes "one legal claim" a property of the Store rather than of one caller's discipline. This is research-instrument evidence, not proof of the daemon's product `taskRun` path. The tooth `a-live-claim-can-be-taken-by-another-agent` (caught) was retired on 2026-09-24: `one reader of the same ready task is given the claim, the second is refused` asserts the refusal and then reads the owner back as a raw row |
| C4 | An unknown external result in a crash window is not guessed | proven | `tests/integration/ooo-external-window.test.ts`. `externalReady` refuses to make an event ready while a check for that task is outstanding ("managed check requires bound terminal evidence"), so the window cannot be closed by announcing it; after a restart the stored fact is still `external_ready = 0` with no artifact, and an invented event name is refused |

## D. Lifecycle and integration pre-conditions

Read the complete responsibility: [D. Lifecycle and integration pre-conditions](task-unit-semantics-obligations/lifecycle-and-integration-prerequisites.md).

## E. Optional HA/MGR integration

Read the complete responsibility: [E. Optional HA/MGR integration](task-unit-semantics-obligations/optional-ha-mgr-integration.md).

## F. Later phase: the experiment arms

Read the complete responsibility: [F. Later phase: the experiment arms](task-unit-semantics-obligations/experiment-arms.md).

## Historical D7 conversion findings

Read the complete responsibility: [Historical D7 conversion findings](task-unit-semantics-obligations/d7-findings.md).

## B6 finding: managed writes and the runner integration gap

Read the complete responsibility: [B6 finding: managed writes and the runner integration gap](task-unit-semantics-obligations/b6-findings.md).

## G. Product entry: collaboration and the OoO evidence boundary

Read the complete responsibility: [G. Product entry: collaboration and the OoO evidence boundary](task-unit-semantics-obligations/collaboration-product-entry.md).

## Not applicable

- B7 has no failure to test: the branch has no board/`taskRun` JSONL export.
- D7 and D10 concern the retired round instrument; see the [retirement decision](../decisions/implemented/2026-09-18-retire-the-round-instrument.md).
- The failed D7 conversion attempt is preserved in [D7 findings](task-unit-semantics-obligations/d7-findings.md); it is not current runtime validation.

## What is left, and what it needs decided

Read the complete responsibility: [What is left, and what it needs decided](task-unit-semantics-obligations/remaining-obligations.md).
