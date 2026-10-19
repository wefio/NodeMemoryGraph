# G7：在合法边界完成一次真实 handoff，五个结构相同的任务

[English](ooo-real-continuation-2026-09-14.md) · [术语](ooo-real-continuation-2026-09-14.terms.yaml)

**状态：**G7 的历史研究工具证据；不是产品运行时证明。2026-09-14 的目标（用户提出）是先完成 G5 再完成 G7；G7 设计为**五个结构相似但内容不同的任务**，以观察不同任务之间的稳定性，以及在相似形状任务上的处理过程。本文记录该检查。

**G7 的要求**（[task-unit 设计](../../design/task-unit-semantics.zh-CN.md)与台账的 [G7 行](../../design/task-unit-semantics-obligations.zh-CN.md)）：_在合法边界完成一次真实 handoff，由另一个 Agent session 从 view 与可检索证据继续同一 parent task，并由固定 parent check 判定。_ 历史设计把它排在 G1 之后，并要求明确模型、预算和重复次数；本文均有记录。实验使用研究脚本和独立 Store，而不是 daemon `taskRun`，因此不证明产品接入。

**模型、预算与重复次数：**

- provider `deepseek`、model `deepseek-v4-flash`，通过 `PI_PROVIDER` / `PI_MODEL` 配置。
- 对五个任务各做一次完整运行，并额外重复一个任务以取得多次样本。
- 完整运行中 9 次模型调用共记录 **80 081 tokens**；每阶段 wall time 见表格。这里只有模型调用消耗 tokens：边界检查、parent check 与每个 verdict 均是确定性的，不产生模型成本。
- 每个任务都冻结执行 envelope，并绑定到 digest：`turns 10`、`reads 5`、`timeoutMs 300 000`（高于适用于单行探针的默认 `3/2/45 s`）。
- **失败尝试的 token 数没有记录。** 阶段抛错时会在写记录前退出，因此下方数字只覆盖产生结果的调用。这是 runner 的缺陷，不是任务属性；特别列出以免把成本表误读为完整统计。

## 五个任务

形状相同、内容不同。每个任务都是冻结模块，带 stub 与声明的契约；第一部分在边界处检查，continuation 才会处理边缘情形：

| 任务 | 模块函数 | Part 1（边界检查） | Part 2（continuation） |
| --- | --- | --- | --- |
| `chunk` | `chunk(items, size)` | 普通拆分、末尾短块 | 空输入、精确倍数、size 1、拒绝情况 |
| `duration` | `parseDuration(text)` | 单位 `ms` 与 `s` | `m`/`h`、组合、零值、`null` 情况 |
| `merge` | `mergeSorted(a, b)` | 两个等长非空数组 | 空数组、重复值、长度不同、不修改输入 |
| `average` | `movingAverage(values, window)` | 输入长于窗口 | window 1、短输入、空输入、拒绝情况 |
| `paths` | `normalizePath(path)` | 普通路径段 | `//`、`.`、`..`、越出根目录、尾斜杠、空值 |

每个任务的 parent check 都是一次模型调用前定义、运行时绝不修改的冻结用例列表：`chunk` 6 项、`duration` 8 项、`merge` 7 项、`average` 6 项、`paths` 7 项。Part 1 只根据两项用例判定；parent 则检查完整列表。两份列表都在 `evals/ooo-execution/live-continuation.ts` 中。

## 方法：边界为何真实

每个角色都是**独立进程**，因此没有通过内存传递状态：

1. `--role plan` 为每个任务创建一个 parent channel（`ooo-continuation:<task>`）与它的 part-1 handoff。Parent 就是 channel；continuation 是其中的第二次 handoff。
2. `--role part1` 认领 handoff，在冻结源码上调用模型、运行 part-1 用例，再通过 board 提交 candidate（`deliverTaskBoardEntry`；digest 根据刚写入的 bytes 计算）。
3. `--role judge --stage part1` 从已记录的 ref 重新读取 artifact，**重新计算 digest 并在不匹配时拒绝**，运行 part-1 用例并记录 verdict。只有 part 1 被接受后才会**开放 continuation**——这就是合法边界。
4. `--role part2` 认领 continuation，再**从 view** 获取 part-1 的交付：读取已交付 artifact 的 bytes，并与 Store 记录的 digest 核对，通过后才可继续。它将这些 bytes 作为待编辑文件，在 part-2 指令下调用模型，然后运行**固定 parent check**并提交。
5. `--role judge --stage parent` 再次验证 digest，并运行同一个冻结 parent check。如果被请求的阶段没有交付，judge 会**拒绝**，不回退到其他 artifact。
6. `--role report` 通过重读运行自己的 JSONL 输出汇总表。

Continuation 可以合法地判定已交付 bytes 就是答案。这个结果（`no-change-needed`）合法，且 artifact 会明确说明；相同 bytes 会继续交给 parent check 判定。`paths` 曾出现一次。

## 完整运行：五个任务、一次运行、一个 Store

| 任务 | Part 1 | Turns | Tokens | Wall | 边界 | Part 2 | Turns | Tokens | Wall | Parent check |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chunk` | 2/2 | 4 | 4 268 | 4 650ms | accepted | 6/6 | 6 | 14 230 | 12 571ms | accepted 6/6 |
| `duration` | 2/2 | 4 | 4 425 | 4 585ms | accepted | 8/8 | 5 | 22 262 | 26 900ms | accepted 8/8 |
| `merge` | 2/2 | 4 | 5 018 | 6 749ms | accepted | **失败：`invalid patch structure`** | - | - | - | **无 verdict——拒绝并记录为失败** |
| `average` | 2/2 | 4 | 4 342 | 4 772ms | accepted | 6/6 | 4 | 5 177 | 5 367ms | accepted 6/6 |
| `paths` | 2/2 | 5 | 7 216 | 8 781ms | accepted | 7/7 | 6 | 13 143 | 10 020ms | accepted 7/7（`no-change-needed`） |

两阶段合计 9 次模型调用、80 081 tokens、记录到的工作耗时 84 395 ms。每次 continuation 都记录了继续所用 artifact 的 digest，因此可证明第二阶段从第一阶段交付的内容开始，而不是原始 stub。

原始记录：`archive/ooo-continuation-2026-09-14/run-logs/g7-run.jsonl`（完整运行，25 行）。

## 任务形状相近时，过程呈现什么样

- **Part 1 稳定得近乎无聊：**本文记录的每次尝试以及更早的探索运行，都在首次提交时通过两项用例；耗时 4 turns，4.3–7.2k tokens。差异在**内容**，不在工作形状。
- **Part 2 才有明显差异：**四个完成的 continuation 使用 4–6 turns、5.2–22.3k tokens，wall time 为 5.4–26.9 秒。`duration` continuation 花费 22 262 tokens，是 `average` 的 5 177 tokens 的四倍，但只多检查两个情形；这是任务措辞的性质，不是边界造成的。
- **边界本身即时且无模型成本。** 它是对 bytes 的确定性检查，不调用模型；边界宽窄不增加成本，只改变第二个 session 要处理的内容。
- **`merge` 在边界处失败，四次尝试中有两次失败**（见下表）。失败发生在模型提交的 **envelope**，不是它写的逻辑：artifact 无法解析为 patch。发生这种情况时阶段没有交付，因此 parent 阶段的 judge 找不到交付并**拒绝**，不评判 part-1 artifact。失败保持为失败，不会被 verdict 掩盖。
- **多数 session（包括成功 session）出现 `pi turn error: This operation was aborted`。** 它本身不是失败信号：`chunk` 的 part 1 打印了该错误，随后仍通过 2/2。
- **同一个任务不代表同一次运行。** `merge` 的 part 2 在五任务探索运行中通过 7/7，在下方样本中两次失败，释放 stale claim 后又通过 7/7。指令、冻结源码和检查都相同。

### 同一任务的额外样本

| 运行 | Part 1 | Part 2 | Parent check |
| --- | --- | --- | --- |
| 五任务探索运行（独立 Store） | 2/2，4 560 | 7/7，5 turns，9 048 tokens | accepted 7/7 |
| 完整运行（上表） | 2/2 | **失败：`invalid patch structure`** | refused |
| 在新 Store 中重试 | 2/2，4 758 | **失败：`invalid patch structure`** | refused |
| 释放 stale claim 后重试 | — | 7/7，4 turns，6 964 tokens | accepted 7/7 |

原始记录：`archive/ooo-continuation-2026-09-14/run-logs/merge-retry.jsonl`（12 行）。

## 本次运行发现的 runner 缺陷及其说明

检查暴露了 harness 中三项故障；每项都可能产生看似可信但错误的答案：

1. **Judge 不区分 stage。** 它曾评判“最新交付”，因此 `merge` continuation 未提交时，静默地用 parent check 评判了 **part-1 artifact**。该 artifact 通过 6/6（详尽的 part 1 恰好实现了整个契约），会造成完整成功的假象。已修复：judge 只选择请求 stage 的交付；没有交付就拒绝。这正是上方 `merge` 行的结果。
2. **Continuation 不区分 stage。** Part 2 最初也把“最新交付”作为输入；重试时它可能读取错误 stage 的 bytes。已用同样方式修复，并保留前置 digest 核对。
3. **失败 stage 没释放 claim。** 认领在取得它的进程退出后仍存在，导致重试被前一次 lease 拒绝，board 看起来像有人仍在工作。已修复：失败 stage 会释放 claim；`--role release` 使用 Store 记录的 holder identity 释放 claim。

其中两项是同一个错误：查询没有说明它在询问**哪个 stage**。两种情况下，正确行为都是 fail closed，而不是挑一个看似合理的 artifact。这符合产品设计中的规则，但证据来自研究脚本，不是产品运行时调用方。

## 诚实的边界

- 任务是 hermetic stubs，不是编辑本仓库。真实的是外围机制：board 作为传输、冻结 envelope 与检查、digest 验证后的取回、独立进程，以及执行工作的模型。若任务要编辑仓库，还需增加 code host；但这不会改变所测量的边界。
- 只有一个 provider 与一个 model，不能说明其他模型会如何表现。
- 五个任务只是样本，不是分布。`merge` 的 2/4 失败率是单个任务的样本，只能如此报告。
- 失败尝试的 token 成本缺失（见预算说明）。

## 重现

```text
RUN=.nmg/ooo-continuation/<name>
PI_PROVIDER=deepseek PI_MODEL=deepseek-v4-flash \
  node --experimental-strip-types evals/ooo-execution/live-continuation.ts --role plan --run $RUN
# 对 chunk、duration、merge、average、paths 分别执行：
#   --role part1  --task <t> --run $RUN --live
#   --role judge  --task <t> --stage part1 --run $RUN
#   --role part2  --task <t> --run $RUN --live
#   --role judge  --task <t> --stage parent --run $RUN
node --experimental-strip-types evals/ooo-execution/live-continuation.ts --role report --run $RUN
```

Store、候选项与 JSONL 日志都保存在 `$RUN` 下；若进程持有 claim 时退出，使用 `--role release --task <t> --run $RUN` 清理该 claim。
