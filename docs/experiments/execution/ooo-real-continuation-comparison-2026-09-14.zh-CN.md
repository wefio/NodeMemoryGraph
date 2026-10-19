# G7 后续分析：将稳定基线与其他样本对比

[English](ooo-real-continuation-comparison-2026-09-14.md) · [术语](ooo-real-continuation-comparison-2026-09-14.terms.yaml)

**状态：**G7 行所引用研究工具日志的历史分析；不是产品运行时证明。最初的观察是第一阶段“稳定得近乎无聊”，而稳定样本值得与其他情况对比。这不是新实验：它重新读取 continuation check 产生的每条阶段记录，按**责任归属**分类失败，并比较不同条件的成本与过程。

## 数据来源

四个运行目录保存了 `evals/ooo-execution/live-continuation.ts` 写入的 `run.jsonl` 日志，对应 [2026-09-14 continuation 实验](ooo-real-continuation-2026-09-14.zh-CN.md)中描述的运行：五任务完整运行、一个 `merge` 的四次尝试样本、探索运行，以及配对重复集合（`merge`，12 次加 10 次重复）。全程使用 `deepseek/deepseek-v4-flash`。用户曾建议使用 pi 自身的 session records，但这些运行没有此类记录——adapter 使用 `SessionManager.inMemory()` 构建 session（`.pi/extensions/nmg/ooo-execution.ts:585`），以免探针污染 session history。失败调用的成本必须从 adapter 返回值取得，因此 runner 现在也会在失败路径记录 usage。

## 两种条件

任务形状、冻结检查、模型都相同。唯一差异是**要求 session 执行 parent task 的哪个阶段**：

- **Part 1——稳定基线。** 一条指令、边界处检查两个用例、实现一个 stub。35 个样本。
- **Part 2——continuation。** 第二个 session、第二个 channel entry，从 view 取回 part-1 artifact 并验证 digest，再处理剩余边界用例与完整 parent check。38 个样本。

## 数值

| 条件 | 样本 | 通过 | 表面失败数 | 平均 tokens | 范围 | 平均 turns | 平均 wall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Part 1（基线） | 35 | 34 | **1** | 5 653 | 4 164–10 508 | 4.4 | ~6.1 秒 |
| Part 2（continuation），所有任务 | 38 | 19 | 19 | 8 406 | 2 798–22 262 | 4.4 | ~6.0 秒 |
| — 仅 `merge` | 32 | 14 | 18 | 7 286 | 2 798–14 936 | 4.2 | — |
| — 其他四个任务 | 6 | 5 | 1 | 12 213 | 5 177–22 262 | 5.0 | ~12.2 秒 |
| 所有通过的阶段 | 53 | 53 | 0 | 6 963 | 4 164–22 262 | 4.5 | ~7.4 秒 |

基线确实稳定：35 个样本中只有一次失败（2.9%），而且是真实模型错误——模型返回的 `mergeSorted` 丢失了尾部元素（`expected [1,2,3,4], observed [1,2,3]`）；Part 1 在边界处被拒绝，没有开放 continuation。这说明边界检查行为正确。

Continuation 表面上的失败率为 50%，但它不是模型失败率。两种条件中最初共计 20 个未通过事件：19 个 continuation 未通过，另有上文所述一个真实的 part-1 基线失败。按原因分类如下：

| 原因 | 数量 | 解释 |
| --- | ---: | --- |
| 多次重复复用 artifact path，导致记录的 digest 与当前 bytes 不匹配 | 10 | Harness 执行缺陷 |
| 失败阶段未释放 claim，重试被前一个阶段拒绝 | 2 | Harness 执行缺陷 |
| 上游 part 1 未通过，因此没有 continuation 可认领 | 1 | Harness 控制流缺陷 |
| 从保留的 artifact（r14、r19）读取到 `no-change-needed`，却误判为 malformed patch | 2 | 合法结果被误分类为失败 |
| 从保留的 artifact（r22）读取到 `cannot-complete`，属于合法 conclusion kind | 1 | 模型结论，不是 malformed patch |
| `promote-candidate` 但无法解析（最早保留的 artifact） | 1 | 模型提交的 artifact 有缺陷 |
| `invalid patch structure`，artifact 未保留 | 2 | 未知；bytes 未保存 |
| Part 1 返回的 `mergeSorted` 丢失尾部（`expected [1,2,3,4], observed [1,2,3]`） | 1 | 真实模型失败 |

因此，20 个计入的事件中有 13 个由 harness 执行/控制流缺陷导致。另有两个 continuation 结果是合法的 `no-change-needed`，却被 harness 误分类；其余模型与未知结果见表。仍有两次失败没有保留 bytes，因此不推测其原因。Continuation 表面上的不稳定主要来自工具本身。这是本次对比最有用的结果：检查必须能发现工具把自身缺陷报告为任务差异。

`invalid patch structure` 案例需要单独说明：四个此类结果中有两个保留了 bytes，且内容相同——`merge` 的 r14 与 r19：

```text
{"kind":"conclusion","conclusion":"no-change-needed","summary":"The delivered merge.ts already
 satisfies all remaining cases of the contract. ..."}
```

这是合法答案：模型认为已交付 bytes 已经是答案。runner 只理解能 promote 文件的 patch，因此错误地拒绝它。现在检查会按 artifact 自带的 `kind`/`conclusion` 读取，而不再匹配错误字符串；之后的重复运行表明分类已修正：`cannot-complete` 会报告为 `conclusion=cannot-complete`，而不是 broken patch。

## 成本：工作的形状，而非大小

- 两种条件的阶段平均耗时都是 **4.4 turns**——第一阶段和 continuation 的工作形状相同。差异在结果类别，不在 turns 数量。
- 对 `merge`，continuation 成本是第一阶段的 **1.3 倍**（7 286 对 5 480 tokens）；其他四个任务则是 **2.2 倍**（12 213 对约 5 650）。Continuation 的成本由它要处理的边界情形决定，不是由“continuation”这个身份决定。仅 `duration` continuation 就花费 22 262 tokens，是 `average` 的四倍。
- 每个阶段读取次数为 1–2：模型没有反复读取同一文件。
- 通过阶段的 wall time 约 6 秒，最重阶段最高 27 秒；失败和 verdict 不增加成本，因为检查是确定性的。

## 任务相似时，过程呈现什么

两个条件的 turns 与 reads 接近，分歧在于**模型停止时给出的结论**：

| 停止结论 | Part 1 | Part 2 |
| --- | --- | --- |
| `promote-candidate`（编辑） | 全部 34 | 17 |
| `no-change-needed` | 0 | 2 |
| `cannot-complete` | 0 | 1 |

第一阶段总是提交编辑；continuation 有时会判断工作已完成，也有一次判定无法完成。这正是边界的作用：continuation 会针对同一 parent task 重新判断，而且合法结果可能是“无需再做”。本次分析前，harness 甚至无法表达这种答案，因此两项“失败”实际上并非失败。

## 诚实的限制

- 只有一个模型、一个 provider，且 n 较小。基线 1/35 只是样本，不是失败率；continuation 修正后的模型侧失败估计基于六个事件，其中五个没有保留 artifact。
- `merge` 占了大多数样本（Part 1 为 26 个，Part 2 为 32 个），因此它之外的逐任务对比只基于六个 continuation 样本。
- 收集数据期间 harness 仍在修复，所以早期记录不如后期完整。上方列出的各类 harness 缺陷后来都已修复，最后十次重复使用的是修复后的行为。
- 失败路径的 timer 曾默认记为 0；平均 wall time 排除了这些记录。该失败记录缺陷已在本次修正。

## 结论

稳定基线是正确的比较对象，但比较结果与预期相反：基线无需辩护，continuation 看起来糟糕的数字大多来自工具。**按原因而非 verdict 统计失败**——否则 harness 会把自己的缺陷归咎于模型，使任何结构看起来都不稳定。
