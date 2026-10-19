# 渐进检索

[English](progressive-retrieval.md) · [使用的术语](progressive-retrieval.terms.yaml)

**Authority:** [父级范围](../design.zh-CN.md)。

## 渐进检索

渐进检索构建并扩展 Active Graph；它与存储层级以及 STG/LTG 生命周期都是分开的：

1. **常驻层：** 一个极小的、与查询无关的种子，由关键约束与稳定画像信息组成，被放入每个相关 AG。
2. **自动召回层：** 基于当前查询、任务、作用域、时间与可用预算，从 STG 与 LTG 做有界动态选择。宿主侧的记忆门首先选择 `retrieve`、`cue` 或 `none`；`none` 必须不检索也不注入动态长期记忆。因此普通代码检查、测试、计算、格式化以及其他自足 turn 保持无记忆。显式中文时间召回线索同时包含 `之前` 与 `先前`；等价的过去状态问题使用同一次检索决策。该门可以保留有界的任务锚点，使简短的续接能够召回紧邻的前一个任务，而不会把每个实质性 prompt 都当作历史查询。
3. **Agent 主导召回层：** 紧凑的 header／线索，使模型可以调用 `nmg_search`、查看成本，并通过 `nmg_get` 用精确细节扩展 AG。

自动召回与 Agent 主导召回共享同一批已索引记录。显式召回触发可以改善任一层中的候选提名，但它们不绕过记忆门、Active Graph 预算、QPP 折叠、作用域或真值过滤，也不绕过「在依赖某个细节之前必须加载精确证据」这一要求。

第三层还作为一个工具过程被额外设界，而不仅仅是对返回信息设界。重复的候选集合计入无进展，一次精确 `get` 只有加载了此前未见证据时才解锁进一步 search，而每 turn 的硬性 search／工具上限即使 QPP 持续建议扩展也会终止循环。因此渐进披露同时统治内容量与披露动作的数量。

候选生成应当组合彼此独立的信号：

```text
Inbox/Delta + surface anchors + fine-grained record semantics
  -> word-level FTS only as a zero-configuration/degraded fallback
  -> optional node/leaf semantic routing at measured large scale
  -> optional graph expansion
  -> scope/time/truth filtering
  -> type-aware reranking and diversity
  -> bounded Active Graph projection
  -> compact headers and selected exact evidence
```

实现让这些阶段保持可检视，而不是把 `searchContext` 当作一个排序公式：AG 硬预算选择、主候选排序、活动图投影选择与重复标记都是纯函数。存储读取与可选图／语义扩展仍是编排步骤。自动微分仍是受支持的控制器机制，因为它是一层小的、已实现的 DAG 原生长计算层；它不是普通检索的强制运行时依赖。

检索信号按用途分离：

- 语义／向量检索用于含义；
- 无内容的 trigram surface-anchor 检索用于显式引号短语、路径、版本、ID、错误码、类代码标识符与已配置的召回触发；NFKC 归一化保留等价表面形式，同时标点仍可被检索；
- 结构化过滤用于日期与作用域；
- 词级 FTS5 作为零配置或降级兜底，而不是语义检索的替代，也不是英文 benchmark 策略；
- 正则表达式仅作为在有界候选集合或原始会话子集之上的高级／调试兜底。

在仅 FTS5 路径上，`combinedScore` 完全相等的相邻候选，在直接结果上限与 Active Graph 预算选择证据之前，按其陈述与前 500 个证据字符中查询词项的 IDF 加权覆盖率排序。非并列顺序与分数不变；所选前缀与 QPP 观察可能改变，因为预算看到的是已解决顺序。Open 附件保留其预留位置。语义检索与强制的 surface-anchor 补充不使用该规则。其范围、评测与被否决的神经排序臂记录在
[词法并列排序](../../decisions/implemented/2026-09-30-lexical-tie-ranking.md)。

任意模型生成的正则不是相关性排序器，默认不得扫描整个 store。Surface anchor 在共享 AG 预算与投影之前、与语义候选一起被准入。纯散文不会仅因词重叠而产生 surface anchor，从而防止一个英文 benchmark 重新定义产品排序。任意字面扫描仍被禁止，因为 trigram 索引提供了有界精确路径，且没有正则转义或灾难性回溯风险。

离线学习相关性使用 [relevance-training.md](../relevance-training.md) 中的来源与评测边界。其产物仍是候选；跨语料测量不授予运行时准入。

### 查询构造与路由融合边界

NMG 接受一个主查询加上可选的调用方生成的 `queries[]`。调用方可以通过查询分解、替换措辞、领域知识或假设答案（HyDE）产生这些子句。因此 HyDE 不是 NMG 的子系统：由 Agent 或另一种面向 LLM 的宿主方法来生成假设文本，NMG 只检索所提供的子句。

检索边界拥有稳定 ID 去重、主查询优先与共享记录／token 预算。已验证的 Lite 路径当前把去重后的次查询结果追加在主排序之后。加权倒数排名融合作为一个确定性 Lab 原语可用，反向检索仍是离线候选生成探针。在一次共享的有界实现与匹配的产品测试显示其收益超出单一 benchmark 分布之前，二者都不改变 Lite 默认值。

Benchmark 自有的答案与 judge prompt 仍是上游协议。它们可以原样使用以保持可比性，但它们不定义 NMG 的查询生成、排序或产品 prompt 策略。

### QPP 执行与渐进披露

QPP 是同一 Active Graph 检索路径之上的可选控制平面，而不是独立存储或检索引擎。它的三个动作可以独立配置，因为它们的成本与失败模式不同：

1. **QPP1** 预测首个候选池应有多宽。它可以只观察不动作，或分配一个有界的初始 Fibonacci 层级。
2. **QPP2** 只在候选池内部运作。它可以继续渐进检视，并决定哪些 header 单独可见、哪些被折叠。
3. **检索建议**把不充分的自动召回转换为给模型的建议信号。它自身从不调用工具。

NMG 的责任止于产生可审计分数并测量各模块的质量与成本。是否激活某个模块、组合哪些模块，属于运营者策略而非 NMG 的学习决策。项目不需要优化或背书某种组合式配置。

QPP2 执行的是渐进披露而不是删除。让控制器产生 listwise 必要性分数 `s_i`；把它们转换为相对几率与归一化局部质量：

```text
o_i = clamp(s_i) / (1 - clamp(s_i))
p_i = o_i / sum_j(o_j)
```

可见目录是按分数排序的、其累计局部质量达到配置保留目标（当前由 `NMG_QPP2_RETAINED_MASS` 配置，默认值为 `0.98`；见 [Pi QPP 控制](../../../README.zh-CN.md#无头-pi-控制)）的最小集合。Retrieval Top-1 是唯一固定的安全锚点。因此平坦分布保持宽，而陡峭分布折叠更多候选。被折叠的候选仍留在 Active Graph 与检索 trace 中，并且必须保持可显式展开。

该质量是查询局部的相对分配，不是「某条记录必要」的校准绝对概率。因此 QPP2 仍为可选启用，直到匹配测试显示模型能在不丢失答案证据的情况下使用被折叠目录。具体的 Pi 设置、默认值、兼容变量与运营者说明属于 README，而不属于这份架构契约。
