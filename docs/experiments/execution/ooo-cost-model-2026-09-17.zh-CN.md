# 付费调用前的粒度与成本 sweep - 2026-09-17

[English](ooo-cost-model-2026-09-17.md) · [术语](ooo-cost-model-2026-09-17.terms.yaml)

**状态：**历史离线测量。本文没有调用模型；任何结果都不代表模型质量。
**相关文档：**[task-unit semantics 设计](../../design/task-unit-semantics.zh-CN.md) ·
[义务台账](../../design/task-unit-semantics-obligations.zh-CN.md) ·
[后续付费 pilot](ooo-arms-pilot-2026-09-18.zh-CN.md)

本文记录付费 pilot 之前的离线模型。它所建模的 round 工具于 2026-09-18 退役；本文不是当前产品 runtime 的说明。

## 工具

`evals/ooo-execution/cost-model.ts`（建议性工具，支持 `--sweep` 与单向量模式）以及
`evals/ooo-execution/cost-model.test.ts`（8 个用例）。

计划形状：`units`（粒度）、`density`（所有可能的正向边中实际存在的比例；0 表示完全独立，1 表示 chain）和 `seed`。图由 seed **派生**，而不是手工编写，因此不能靠挑选有利形状来制造收益。

成本向量及各项含义：

| 项 | 含义 | 状态 |
| --- | --- | --- |
| `workMs` | 一次 Agent 调用的延迟 | 在先前 round 中测得的范围（秒） |
| `rederiveMs` × ¬`hitRate` | 若事实命中就无需重新推导的 artifact 成本 | **假设值**，参与 sweep |
| `verifyMs` | 一次 host candidate check；同一时刻只运行一个 | 测得的顺序（约 1.5 秒） |
| `contextMsPerUnit` | 一个合法 session 边界的成本 | **假设值**，参与 sweep |
| `coarseContextSaving` | 合并 session 后，不再为每个 unit 支付边界成本所节省的部分 | **假设值**，也是争议所在 |
| `slots` | 执行槽数 | arm 操纵的变量 |

调度器先按 `slots` 执行 greedy list scheduling，再进入**单一 host check 队列**：candidate check 之间不会并发。依赖只能由已接受的 artifact 满足，因此后继 unit 等的是前驱检查结果，而不是其模型调用——这正是 out-of-order 研究工具试图利用的差异。

## 模型最初哪里算错了

最初的自检认为：4 个相互独立的 unit 使用 4 个槽时，应在“一个 unit 加一次 check”的时间内完成。实际并非如此，错的是模型而非检查：host 会串行执行 4 次检查，因此下限是一个 unit **加四次**检查。该数字如今就是检查项。若省略队列，同一工具会报告其指定调度器无法实现的并发。

## Sweep

基础向量：work 8 秒、re-derive 6 秒、hit rate 0.5、verify 1.5 秒、每个 unit 的 context 1.2 秒、coarse saving 0.5、4 个槽。表中单位为毫秒。

| density | units | coarse | fine，1 槽 | fine，多槽 | 槽带来的节省 | critical path | 相对 coarse 的收益 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 1 | 11 900 | 13 700 | 13 700 | 0 | 13 700 | **−1 800** |
| 0 | 2 | 23 800 | 25 900 | 15 200 | 10 700 | 13 700 | +8 600 |
| 0 | 4 | 47 600 | 50 300 | 18 200 | 32 100 | 13 700 | +29 400 |
| 0 | 8 | 95 200 | 99 100 | 30 400 | 68 700 | 13 700 | +64 800 |
| 0.25 | 2 | 23 800 | 27 400 | 27 400 | 0 | 27 400 | **−3 600** |
| 0.25 | 4 | 47 600 | 51 800 | 30 400 | 21 400 | 27 400 | +17 200 |
| 0.5 | 4 | 47 600 | 51 800 | 41 100 | 10 700 | 41 100 | +6 500 |
| 1 | 4 | 47 600 | 54 800 | 54 800 | 0 | 54 800 | **−7 200** |
| 1 | 8 | 95 200 | 109 600 | 109 600 | 0 | 109 600 | **−14 400** |

## 模型能说明什么，不能说明什么

1. **一个槽没有收益；单槽细分总是亏成本。**这是设计里的 B arm。模型预测 B 的成本应高于 A：每个 unit 都要支付 session 边界成本，也没有任何重叠。若 pilot 报告 B 比 A 便宜，首先应检查测量工具，而不是将其当作发现。
2. **只有独立性与槽数都真实存在时，拆分才可能有收益。**两个 unit 之间只要有一条依赖边（density 0.25，units=2），收益就转负；chain 在所有粒度下都为负（8 个 unit 时为 −14.4 秒），因为增加了边界成本却没有重叠。
3. **host check 队列限制了细粒度并发。**每个 unit 都增加一次串行检查，因此 fine arm 的下限是一个 unit 加上 **units 次**检查。在此向量下，coarse arm 也支付同样数量的检查，这就是为什么仅提高独立性不会令收益无限增长。
4. **模型无法说明质量，也没有假装可以。**若 `cost-model.test.ts` 的结果对象新增匹配 `/quality|pass|accept|correct|success/i` 的 key，测试就会失败，因此模拟通过率不会悄悄变成报告结果。设计中的这一限制由结构本身保证。

## 给后续付费 pilot 的建议

以下是离线模型的预测与建议，不是测量结果。后续付费 pilot 的实际设置与结果由上方链接的记录拥有。

- 优先选择合法细分能得到**多个** unit（≥ 4）、**density 明显低于 0.5**、且每个 unit 的检查成本不会主导其工作成本的 parent task。模型预测两单元细分或 chain 会亏。
- 模型预测 A 的成本低于 B、质量相近；若有收益，应只出现在 C。若 pilot 测得 B-arm 成本节省，则与本 sweep 矛盾，应先检查 pilot 的工具。
- 本 sweep 没有确定付费模型、预算或重复次数，也没有进行付费调用。

## 命令

```text
node --experimental-strip-types evals/ooo-execution/cost-model.ts --sweep --out .temp/cost-sweep.json
node --experimental-strip-types --test evals/ooo-execution/cost-model.test.ts   # 8 pass / 0 fail
```
