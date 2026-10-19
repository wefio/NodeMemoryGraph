# 召回手册

[English](recall.md) · [术语](recall.terms.yaml)

## 渐进召回与调用次数限制

把自动注入的召回和 search 结果视为候选标题。使用 `nmg get` 加载选定的精确记录和证据。判断问题需要一条还是多条记录；候选数量不证明证据完整。将最新请求作为召回目标，较早上下文用于消歧。没有有用记忆也是有效结果。先浅层检索；如果仍可能缺少信息，先试一次更窄或互补查询，再提高 `--max-tier`、`--limit` 或 `--graph-hops`。依赖易变化事实前，先对照当前来源核实。若词法结果仍不足且已配置 embedding，则切换到 `--retrieval-mode hybrid`（见 [embedding](embedding.md)）。不要把全部候选证据加载到模型上下文。

Pi 对每个用户回合应用调用预算：最多三次 search，search/get 总计最多五次。连续两次 search 未推动精确证据读取时，必须调用 `get`；连续两次 search 都没有返回新候选 ID 时，停止召回。不要用改写同一查询的方式绕过这些保护。根据已加载证据作答，说明尚存的不确定性，或等待新的用户回合。

## 结果字段与缩小范围

`nmg search --compact-json` 返回 `candidates[].id` 和顶层 `activeGraphId`；`--json` 返回 `results[].memory.id` 和 `activeGraph.id`。把 graph ID 传给 `nmg get --active-graph-id`，以归因精确证据的实际使用，而不是归因搜索成功。

需要时用 `--node`、`--scope` 或 `--source-actor user` 缩小范围。只有确实需要旧／已被替代状态时才用 `--include-historical`。从 `--max-tier 1` 和 `--limit 8` 开始，不要一次倾倒所有证据。

## 升级顺序

1. 围绕缺失实体、时间或关系改写查询。
2. 将 `--limit` 从 8 提高到 20 左右。
3. 将 `--max-tier` 提高一级。
4. 对相关概念添加 `--graph-hops 1` 或 `2`。
5. 只有旧状态或已被替代的状态相关时，才用 `--include-historical`。
6. 如果词法结果不足，而且已配置 embedding、索引已就绪，则切换到 `--retrieval-mode hybrid`（见 [embedding](embedding.md)）。

证据足够时停止。只对可能影响答案的 ID 调用 `nmg get`，并传入 `--active-graph-id <ID_FROM_SEARCH>`，以便 NMG 区分实际使用证据与仅显示候选项。

## Warm memory 续取

CLI 与 Pi 适配器会对完整 warm 候选池排序一次。候选池最多四条时全部暴露；达到五条或更多时，首轮只暴露其中较热的一半。若搜索结果报告了折叠记录，先检查可见标题。仍不够时，根据返回的延迟 memory ID 调用一次 `nmg_get`。不要再次调用 `nmg_search`：延迟 ID 是同一稳定排序中受预算控制的第二窗口；精确查询不会重复 embedding 或 ANN 工作。每个响应仍受调用者的证据与 token 预算限制。只有在诊断时确实要立即暴露整个 L1 排序池，才使用 `--full-warm`。

## 渐进式第二遍

若要让物理存储范围逐步可检索，添加 `--tiered-disclosure`。只有确定性 QPP 仍判定证据不足时，NMG 才会打开内部层级。它可以与 `--second-pass` 组合，但二者不同：前者扩大物理搜索范围；后者扩大已打开候选池中的证据前缀。物理层级名称是 NMG 诊断信息，不是回答模型的证据。

如果第一次召回的质量可疑但查询正确，应在同一候选池中重新选择，不要改写查询：

```text
nmg search "<query>" --project-dir . --second-pass --limit 8 --compact-json
```

`--second-pass` 按累计 Fibonacci 证据层级（1、2、3、5、……）前进，并在每层后基于同一过采样候选池重新计算 QPP 置信度。它不会重新搜索，只会扩大被选择的证据范围。

## QPP 调优

NMG 有三项彼此独立的检索置信度控制（环境变量在启动时读取）：

| 变量 | 值 | 默认值 | 效果 |
| --- | --- | --- | --- |
| `NMG_QPP1_MODE` | `off`、`shadow`、`active` | `shadow` | 第一遍候选池分配 |
| `NMG_QPP2_MODE` | `off`、`shadow`、`active` | `off` | Fibonacci 渐进检测与折叠 |
| `NMG_QPP2_RETAINED_MASS` | `0..1` | `0.98` | 每次折叠保留的概率质量 |
| `NMG_SEARCH_RECOMMENDATION` | `off`、`advisory`、`guardrail` | `off` | 召回较弱时向模型建议显式搜索 |

Shadow 模式会计算并记录决策，但不执行决策；先用它观察行为，稳定后再切换到 `active`。用于 shadow 评估的 Lab 反馈命令：

`active` 在获得监督前仍会 fail-safe：未训练的控制器不能改变 QPP1 分配或 QPP2 列表可见性。调用者指定的搜索 `limit` 优先于学习型分配／折叠；显式 `--second-pass` 仍会请求确定性的 Fibonacci 扩展。

```text
/nmg-shadow-feedback last success|failure|corrected|uncorrected|unknown
```

## 冲突

不要静默选择排序第一的结果。比较时间、作用域、状态、truth status 和证据。通常，同一 state key 与 scope 下的当前活动状态优先于旧状态；旧事件仍是历史证据。

## 多部分问题

对彼此独立且都必需的事实，使用互补子查询。宽泛查询可能只检索到其中一个方面。应从已加载的精确记录中列出或计数，不要从 search 预览中推断。

## 无结果

如实说明没有找到匹配记忆。不要编造记忆事实。NMG 不可用时，继续不使用记忆；如果会影响答案，应披露这一限制。
