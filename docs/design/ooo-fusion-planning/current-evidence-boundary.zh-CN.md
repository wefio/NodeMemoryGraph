# 当前 ceiling 能说明什么

[English](current-evidence-boundary.md) · [术语](current-evidence-boundary.terms.yaml)

**权威归属：**[父级范围](../ooo-fusion-planning.zh-CN.md)。

针对 fixtures 和 D arm 自己的 spec 运行（`node --experimental-strip-types evals/ooo-execution/fusion-ceiling.ts [--spec <path>]`）：

| Plan | Units | Floor | Cap 1 | Cap 2 | Cap 3 | Cap 4 |
| --- | --- | --- | --- | --- | --- | --- |
| `fixtures/report/fine.spec.json` | 4 | 1 | 4 sessions | 2（3.8 s） | 2（3.8 s） | 1（5.7 s） |
| `fixtures/pipeline/fine.spec.json` | 4 | 1 | 4 sessions | 2（3.8 s） | 2（3.8 s） | 1（5.7 s） |
| D arm 的 `spec-2.json` | 2 | 1 | 2 sessions | 1（**1.9 s**） | | |

第三行只是算术核对，不是独立预测：ceiling 使用 D arm 自身运行得出的每 session 1 900 ms 假设。该 arm 的 1 900 ms 中位差小于 2 228 ms 的 cell 内 spread，因此此行只能表明工具将输入应用到了 arm 的 plan，不能证明该假设是可靠的启动耗时常量。下面的 fine-plan 比较是另一项观测：同一工具预测 cap 2 节省 3 800 ms，而归档中位数相差 8 451 ms。这个差异说明平坦假设无法解释该样本；instrument commit 缺失且第三次重复更换了 prompt，不能据此识别通用的 plan-dependent 模型。表中还显示两个多单元 fixture 的结构下界都是 1，以及在这些形状上 cap 3 不优于 cap 2，因为第四个 unit 必须等待前面三个。这些是特定形状的属性，不证明 plan 普遍可完全 fusion，也不意味着某个 bound 是产品默认值。

### Cap 实验测量结果（2026-09-19）

在 `fixtures/pipeline/fine.spec.json` 上实测四单元计划的 ceiling 预测。该 fixture 有三个独立 unit 与一个汇合 unit，对应 report fixture 的形状；以 live 模式和 `--slots 1` 运行，并移除 spec 自带的 canned answer，让这些 unit 真正执行。Cache accounting 与 tokens 一起记录，因为 token 数本身不等于成本。

| Bound | Sessions | Rep | Wall | Tokens | Cache read / tokens |
| --- | --- | --- | --- | --- | --- |
| 1 | 4 | 1 | 26 186 ms | 45 482 | 0.847 |
| 1 | 4 | 2 | 27 053 ms | 45 887 | 0.806 |
| 1 | 4 | 3 | 25 270 ms | 33 941 | 0.607 |
| 2 | 2 | 1 | 17 735 ms | 41 806 | 0.802 |
| 2 | 2 | 2 | 17 998 ms | 37 693 | 0.798 |
| 2 | 2 | 3 | 17 427 ms | 35 444 | 0.690 |
| 4 | 1 | 1 | 16 480 ms | 54 834 | 0.836 |
| 4 | 1 | 2 | 16 810 ms | 55 738 | 0.834 |

每行一份运行记录，因此任何列都不需要按位置和另一列配对；中位数与节省值会从存储的报告重新计算，并写入归档的 `aggregate-3rep.json`。Bound 1 与 2 增加了第三次重复，因为此前这张表的两次重复曾被引用为策略。第三次重复按相同 spec 的后续观测读取，不当作相同 instrument 版本的第三个数据点：fused cell 的第三次运行使用了当天早些时候修改过的 chain prompt，报告记录了 spec、worker 和 envelope，却没有记录 instrument commit。以下三点取代了本文档更早的读法：

- **记录的 cap 样本在较大 bound 下 wall 更低，但不能校准通用启动项。** 归档中位数显示 cap 1 到 cap 2 相差 8 451 ms，cap 1 到 cap 4 相差 9 541 ms；D arm 的 1 900 ms 假设对应的预测值分别是 3 800 ms 和 5 700 ms。Cap 1 与 cap 2 的 cell 内 spread 分别为 1 783 ms 与 571 ms。前两次运行的取值范围已经不重叠；第三次运行使用较新 prompt，并扩大了两个 cell 的取值范围，但没有反转观测方向。由于 cap 报告缺少 instrument commit，这只是这些样本的有限证据，不是每 session 价格，也不是“startup 随 plan 变化”的普遍主张。Ceiling 的主要输出是_避免的 sessions 数_；毫秒估计必须注明假设。
- **三次重复仍无法确定 token 数方向。** 两次重复时，每个 arm 的 tokens 中 80–84% 都是 **cache reads**，其余部分几乎不变。第三次重复后，一个 cell 的该比例降到 0.607（同一 cell 的另一次运行是 0.847）；每 cell token spread——cap 1 为 11 946——大于将要比较的中位数差。因此这些运行不支持 token 方向主张：先前按未配对中位数得到的 1.3–1.9x 不是被更好的数字取代，而是仍未解决。测量阶段以未解决状态关闭：解决它需要更多重复，或把价格字段分开记录；后者成本更低，所以报告现在按 unit 分别记录 `inputTokens`、`outputTokens`、`cacheRead`、`cacheWrite` 和 provider 自报的 `cost`。A、B、C 是首批包含这些字段的 cell（它们的总数可精确拆分，并包含 provider 价格）。上表的 cap cell 早于该拆分，不能重新定价；没有继续购买 fused run 来补价，因为在三次运行已失败的形状上只增加一次重复仍不足以解决问题。因此 fusion 成本仍**未定价**；本文档只在有测量处写“已测量”，在未测处写“未定价”。旁边的比例列也**不是**价格：`tokens` 将 input 与 output 合并，减去 cache reads 后得到的是未由 cache 提供的 tokens——未缓存的 input 加上全部 output tokens；而报告没有说明 cache 数值是否包含在总数中。
- **在这些已记录中位数里，cap 2 是拐点，不是策略。** 它覆盖了 cap 1 到 cap 4 观察差值中的 8 451 ms，同时记录的 tokens 最少（三次重复中位数 37 693）；cap 4 额外相差 1 090 ms。第三次重复更换了 prompt，且报告没有 instrument commit，因此中位数仍是有限观测。每 cell 三次运行仍不足以确定策略；更少 sessions 不等于 parent task 更短：有多个 slot 时，把 units 融合到更少 sessions 会损失 plan 原可利用的并行度。因此每 session 两个 units 仍只是 A-D 单一 parent task 对比要检验的假设，不是本文档宣布的策略。

**Spread 大于差值，不等于没有差异。** D arm 两个条件的两次重复 spread（各约 2.2 s）都大于 1.9 s 中位差，因此_该样本_无法分辨效应；这不表示 fusion 永远不会节省 wall-clock。Fine-plan cap 样本的前两次取值范围不重叠（26.186–27.053 s 对 17.735–17.998 s）；第三次结果（25.270 s 与 17.427 s）维持该方向。它们也扩大了两个 cell 的取值范围，使用了较新的 prompt，且缺少 instrument commit。故观测到的差异早于第三次运行，但仍只是有限样本结果，而不是一般性的因果估计。
