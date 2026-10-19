# Archive: the OoO continuation samples (2026-09-14)

[中文](README.zh-CN.md) · [Terms used](README.terms.yaml)

**Scope:** archived research-instrument evidence for ledger row G7, not proof of product-runtime integration.

**Why this is here.** The runs behind ledger row G7 were driven from a git worktree under `%TEMP%`
(`C:/Users/LEGION/AppData/Local/Temp/nmg-board-verbs`). Committed content survives a temp cleanup -
the branch is pushed and the objects live in the repository - but the _measurements_ would not: the
run logs, the candidate modules the model wrote and the artifacts it submitted were all untracked
scratch under `.nmg/`. This directory puts every sample a claim depends on inside the repository.

**What was run.** Provider `deepseek`, model `deepseek-v4-flash`, driven by
`evals/ooo-execution/live-continuation.ts`; each stage one process, one model call, with the frozen
envelope `turns 10`, `reads 5`, `timeoutMs 300 000`. `wallMs` measured; wall time and token counts come
from the adapter's own accounting, not from a clock outside it.

## Run logs (`run-logs/`)

| file                   | lines | what it is                                                                    |
| ---------------------- | ----- | ----------------------------------------------------------------------------- |
| `g7-run.jsonl`         | 25    | Clean run: five tasks, each part1 → boundary → part2, in one store            |
| `m-rep6.jsonl`         | 43    | Early repeats repeatedly failed because a predecessor held the claim; retained as defect evidence |
| `m6.jsonl`             | 198   | Paired repeats: multiple merge part1/part2 runs; the main dataset cited here  |
| `merge-repeats6.jsonl` | 44    | Repeats from the first attempt, when failure records were still incomplete    |
| `merge-retry.jsonl`    | 12    | Merge retry in an independent store; includes one success after releasing a dead claim |
| `run-1.jsonl`          | 8     | First full chunk chain, including an older part2 recorded as unchanged        |
| `run-2.jsonl`          | 7     | Chunk part2 failed in `patchCandidate` with `invalid patch structure`         |
| `run-3.jsonl`          | 7     | Chunk sample from the period when failure records were missing               |
| `run-4.jsonl`          | 8     | Chunk sample after failure recording was added                               |
| `run-5.jsonl`          | 9     | Chunk's first complete successful five-task cycle                             |

Each line is one role's record: `role`, `task`, `stage`, `conclusion`, `turns`, `reads`,
`tokens`, `wallMs`, `passed`/`cases`, `failed`, `digest`, `continuedFrom`. A `part2` record's
`continuedFrom` is the digest of the artifact it continued from, which is how a continuation is shown
to start from the delivered bytes rather than from the stub.

## Rejected artifacts (`rejected-artifacts/`)

| file                      | bytes | the model submitted                               | why it was not accepted                                                       |
| ------------------------- | ----- | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `m6--merge-part2-r14.txt` | 1598  | `kind=conclusion`, `conclusion=no-change-needed`  | Valid conclusion misclassified as a malformed patch (the runner then recognized only promoted-file patches) |
| `m6--merge-part2-r19.txt` | 1981  | `kind=conclusion`, `conclusion=no-change-needed`  | Same misclassification; retained from before the fix                          |
| `m6--merge-part2-r22.txt` | 1663  | `kind=conclusion`, `conclusion=cannot-complete`   | Valid conclusion, but `cannot-complete`: the model declared the task incomplete |
| `m6--merge-part2.txt`     | 1482  | `kind=conclusion`, `conclusion=promote-candidate` | An earlier rejected artifact                                                  |

These are the bytes behind a failure claim. They are kept because "invalid patch structure" is a
statement about bytes, and reading them is what showed the string-matching misclassification: a
`no-change-needed` conclusion is a legal answer, not a malformed patch.

## Candidates (`candidates/`)

The modules the model actually produced, `35` of them, named `<run>--<task>--<stage>.ts` (a `-r<N>`
suffix marks the repetition). They are the artifacts the checks passed or rejected, and the evidence for
the cost comparison in the sibling documents.

## Related documents

- `../ooo-real-continuation-2026-09-14.md` - the G7 check itself: five tasks, one boundary each.
- `../ooo-real-continuation-comparison-2026-09-14.md` - the comparison of the stable first stage against
  the continuations, and the failure classification this archive supports.
- `../../../../design/task-unit-semantics-obligations.md` - the ledger; row G7.

## What this archive does not hold

- The `.sqlite` board stores (7 MB, binary, reproducible from the logs and the roles).
- Token counts for calls that failed before the usage record existed; those rows show `null` and the
  documents say so rather than estimating.
