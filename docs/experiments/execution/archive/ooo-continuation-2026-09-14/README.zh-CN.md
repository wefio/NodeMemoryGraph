# 归档：OoO continuation 样本（2026-09-14）

[English](README.md) · [术语](README.terms.yaml)

**范围：**义务台账 G7 行所依据的研究 instrument 证据；不能证明已接入产品运行时。

**归档原因。** G7 行所依据的运行由 `%TEMP%` 下的 Git worktree（`C:/Users/LEGION/AppData/Local/Temp/nmg-board-verbs`）驱动。提交内容不会因 TEMP 清理而消失——分支已推送，对象保存在 repository 中——但测量数据会丢失：run logs、模型写出的 candidate modules 和它提交的 artifacts 都只是 `.nmg/` 下未跟踪的 scratch 文件。本目录将每项主张依赖的样本保存在 repository 中。

**运行内容。** Provider 为 `deepseek`，model 为 `deepseek-v4-flash`，由 `evals/ooo-execution/live-continuation.ts` 驱动；每个 stage 一个 process、一次 model call，冻结 envelope 为 `turns 10`、`reads 5`、`timeoutMs 300 000`。测量 `wallMs`；wall time 与 token 数来自 adapter 自身的 accounting，不是外部时钟。

## Run logs（`run-logs/`）

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `g7-run.jsonl` | 25 | 干净运行：五个任务，每个均为 part1 → boundary → part2，使用同一 store |
| `m-rep6.jsonl` | 43 | 早期重复运行：因前序任务占用 claim 而连续失败；作为缺陷证据保留 |
| `m6.jsonl` | 198 | 配对重复测量：merge 的 part1/part2 各有多次运行；本文引用的主要数据集 |
| `merge-repeats6.jsonl` | 44 | 首次尝试中的重复运行，当时 failure records 尚不完整 |
| `merge-retry.jsonl` | 12 | merge 在独立 store 中重试；包括释放死 claim 后的一次成功 |
| `run-1.jsonl` | 8 | chunk 首次完整 chain；含一条旧记录，其 part2 被记为 unchanged |
| `run-2.jsonl` | 7 | chunk 的 part2 在 `patchCandidate` 处以 `invalid patch structure` 失败 |
| `run-3.jsonl` | 7 | chunk failure records 缺失期间的样本 |
| `run-4.jsonl` | 8 | 开始记录失败后的 chunk 样本 |
| `run-5.jsonl` | 9 | chunk 第一个完整成功的五任务 cycle |

每一行是一种 role 的记录：`role`、`task`、`stage`、`conclusion`、`turns`、`reads`、`tokens`、`wallMs`、`passed`/`cases`、`failed`、`digest`、`continuedFrom`。`part2` 记录中的 `continuedFrom` 是其继续处理的 artifact digest；由此可证明 continuation 从已交付的 bytes 开始，而不是从 stub 开始。

## 被拒绝的 artifacts（`rejected-artifacts/`）

| 文件 | Bytes | 模型提交内容 | 未被接受的原因 |
| --- | --- | --- | --- |
| `m6--merge-part2-r14.txt` | 1598 | `kind=conclusion`，`conclusion=no-change-needed` | 合法 conclusion 被误判为 malformed patch（当时 runner 只接受提升文件的 patch） |
| `m6--merge-part2-r19.txt` | 1981 | `kind=conclusion`，`conclusion=no-change-needed` | 同样的误分类；保留自修复之前 |
| `m6--merge-part2-r22.txt` | 1663 | `kind=conclusion`，`conclusion=cannot-complete` | 合法 conclusion，但 `cannot-complete`：模型声明任务未完成 |
| `m6--merge-part2.txt` | 1482 | `kind=conclusion`，`conclusion=promote-candidate` | 较早的一条被拒 artifact |

这些是失败主张背后的原始 bytes。保留它们是因为 `invalid patch structure` 是对 bytes 的判断；直接读取后发现了 string-matching 误分类：`no-change-needed` conclusion 是合法回答，不是 malformed patch。

## Candidates（`candidates/`）

模型实际生成的 35 个 module，文件名为 `<run>--<task>--<stage>.ts`（`-r<N>` 后缀表示重复运行）。这些是检查通过或拒绝的 artifacts，也是相关文档进行成本比较的证据。

## 相关文档

- `../ooo-real-continuation-2026-09-14.zh-CN.md`：G7 检查本身——五个任务，各有一个 boundary。
- `../ooo-real-continuation-comparison-2026-09-14.zh-CN.md`：稳定的第一阶段与 continuation 的对比，以及本归档支持的失败分类。
- `../../../../design/task-unit-semantics-obligations.zh-CN.md`：义务台账，G7 行。

## 此归档不包含什么

- `.sqlite` board store（7 MB 二进制文件，可从 logs 与 roles 重建）。
- 用量记录生成前就失败的调用的 token 数；这些行显示 `null`，文档也按未知处理，而不估算。
