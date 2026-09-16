# Archive: the OoO continuation samples (2026-09-14)

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

| file                   | lines | what it is                                                            |
| ---------------------- | ----- | --------------------------------------------------------------------- |
| `g7-run.jsonl`         | 25    | 干净的一遍：五个任务，每个 part1 → 边界 → part2，同一 store           |
| `m-rep6.jsonl`         | 43    | 早期那批因认领被前任占住而连续失败的重复（保留为缺陷证据）            |
| `m6.jsonl`             | 198   | 配对的重复测量：merge 的 part1/part2 各多次；本文档引用的主要数据集   |
| `merge-repeats6.jsonl` | 44    | 第一次尝试的重复测量（当时失败记录还不完整）                          |
| `merge-retry.jsonl`    | 12    | merge 在独立 store 里的重试（含释放死认领后的一次成功）               |
| `run-1.jsonl`          | 8     | chunk 的首次全链路（含一条 part2 判为 unchanged 的旧记录）            |
| `run-2.jsonl`          | 7     | chunk 的 part2 崩在 patchCandidate（invalid patch structure）的那一轮 |
| `run-3.jsonl`          | 7     | chunk 在失败记录缺失期的样本                                          |
| `run-4.jsonl`          | 8     | chunk 改为记录失败后的样本                                            |
| `run-5.jsonl`          | 9     | chunk 第一个完整成功的五任务循环样本                                  |

Each line is one role's record: `role`, `task`, `stage`, `conclusion`, `turns`, `reads`,
`tokens`, `wallMs`, `passed`/`cases`, `failed`, `digest`, `continuedFrom`. A `part2` record's
`continuedFrom` is the digest of the artifact it continued from, which is how a continuation is shown
to start from the delivered bytes rather than from the stub.

## Rejected artifacts (`rejected-artifacts/`)

| file                      | bytes | the model submitted                               | why it was not accepted                                  |
| ------------------------- | ----- | ------------------------------------------------- | -------------------------------------------------------- |
| `m6--merge-part2-r14.txt` | 1598  | `kind=conclusion`, `conclusion=no-change-needed`  | 合法结论被误判为畸形补丁（当时运行器只认提升文件的补丁） |
| `m6--merge-part2-r19.txt` | 1981  | `kind=conclusion`, `conclusion=no-change-needed`  | 同上（修复前留存）                                       |
| `m6--merge-part2-r22.txt` | 1663  | `kind=conclusion`, `conclusion=cannot-complete`   | 合法结论，但为 cannot-complete：模型宣告未完成           |
| `m6--merge-part2.txt`     | 1482  | `kind=conclusion`, `conclusion=promote-candidate` | 早期一条被拒产物                                         |

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
