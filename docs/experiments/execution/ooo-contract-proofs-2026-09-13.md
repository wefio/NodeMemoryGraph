# The persistence contract's proof list, item by item (2026-09-13)

**Status:** in progress — four proofs added on `feat/ooo-run-namespace`; three items still owed.

`docs/design/task-unit-semantics.md` closes with the properties a persistence integration "另须证明".
This record maps that list to evidence, so "we believe it holds" can be told apart from "a test
fails when the property is broken". A row without mutation evidence is a test, not yet a tooth.

| Property the design asks for | Where it is proven | Mutation evidence |
| --- | --- | --- |
| Two rounds with the same taskId do not collide | `tests/integration/ooo-run-namespace.test.ts` | — |
| A retry does not deliver twice | `tests/core/task-board-deliverable.test.ts` | — |
| A transaction failure cannot write a verdict without its association | `tests/integration/ooo-transition-atomicity.test.ts`, `tests/core/store-transaction-port.test.ts` | `the store runs its transaction boundary in exactly one place` |
| A retained entry is not cleared by TTL | `tests/core/task-board-retention.test.ts` | — |
| Deleting every derived cache yields the same view | `tests/integration/ooo-task-tables.test.ts` | — |
| The status query and dependency release call one predicate | `tests/integration/ooo-acceptance-one-predicate.test.ts` | 2 mutants, both caught |
| A lapsed lease is a new generation, not a silent success | `evals/ooo-execution/recovery.test.ts:138` (already covered before this work) | — |
| Concurrent readers of one ready task: one legal claim | `tests/integration/ooo-managed-fence.test.ts` | — |
| A generic board operation cannot bypass a managed task's fence | `tests/integration/ooo-managed-fence.test.ts` | — |
| A read-only open is protected by the handle, not by `query_only` | `tests/core/store-readonly-open.test.ts` | `the-read-only-factory-opens-a-writable-handle` (caught) |
| JSONL export failure does not change the terminal state | not applicable yet: no JSONL export exists in this branch | — |
| An unknown external result in a crash window is not guessed | owed: the plan's wait-event semantics must be read first | — |

The one-acceptance-predicate row is the design's sentence "接受查询与依赖解锁必须调用同一谓词".
Both callers already did call `acceptedFact` — nothing had to move — so the work was the proof, and
the first version of it was not one. That version sliced a function body to look for the call; when
the slice's end boundary was not found the slice silently ran to the end of the file, so renaming
the call site still passed. Counting occurrences cannot degrade that way, and both mutants are now
caught.

## What these proofs do not cover

- Both fence tests use two objects in one process. They exercise the fence, not the multi-process
  case; the multiprocess evidence lives in `evals/ooo-execution/multiprocess.test.ts`.
- The generic-claim test accepts either outcome of the generic call, because the property is that
  the round's own state does not move, not that the generic path throws.
- Dispatch order after a claim is not asserted anywhere here: the design puts ordering in the
  coordinator, not in the fence, so pinning it in a fence test would pin the wrong owner.
- `next()`'s selection rule was read only far enough to know it is not this record's subject.

## Two things learned about the mutation config

- `expect` is the name of the test that must fail. Prose there turns a real catch into the tool's
  "NOT caught", which is how two working mutants first read as broken.
- The `ast` locator is indentation-sensitive: an anchor whose leading spaces no longer match the
  file is a stale anchor rather than a cosmetic difference. Two teeth that had gone stale this way
  refused to claim a check, which is the behaviour the tool exists for.
