# 节点身份与可逆规范化

[English](node-identity-and-reversible-canonicalization.md) · [使用的术语](node-identity-and-reversible-canonicalization.terms.yaml)

**Authority:** [父级范围](../active-graph-activation-and-consolidation.md)。

### 节点身份与可逆规范化

节点相似性只是提出待比较节点对的阻塞信号。它不授权合并。NMG 区分：

```text
SAME_ENTITY    same real-world object
EXACT_MATCH    concepts broadly interchangeable for retrieval
CLOSE_MATCH    concepts interchangeable only in some contexts
BROADER        source concept contains the target
NARROWER       source concept is contained by the target
RELATED        associated but independently meaningful
DIFFERENT      explicit non-identity evidence
```

这遵循 [OWL identity](https://www.w3.org/TR/owl2-rdf-based-semantics/) 与
[SKOS](https://www.w3.org/TR/skos-reference) 中严格身份与较弱的
`exactMatch`、`closeMatch`、`broader/narrower`、`related` 关系之间的区分。特别地，`CLOSE_MATCH` 不传递，且不得产生等价闭包。

身份解析使用三种判定而不是强制的二元合并，遵循 [Fellegi–Sunter record linkage](https://doi.org/10.1080/01621459.1969.10501049)：

```text
log_odds_same =
  prior_log_odds
  + sum(feature_log_likelihood_ratio)

high confidence -> SAME_ENTITY candidate
middle interval -> possible link / human or Agent review
strong mismatch -> DIFFERENT
```

名称、embedding、共享证据、别名、时间、作用域、稳定外部 ID 与定义性属性都是比较特征。节点类别不兼容、稳定 ID 不同、作用域不相交、事件时间不同、有效期区间不兼容，或显式非同一性，都是硬否决。相关特征必须被分组或校准，而不是被当作独立证据计票。

对概念而言，合并也是一项模型选择决策。只有当一份共享描述加例外比两份分开的描述更短时，[MDL](https://arxiv.org/abs/math/0406077) 增益才为正：

```text
delta_MDL =
  [L(separate_model) + L(data | separate)]
  - [L(merged_model) + L(data | merged)]
```

如果合并后的描述需要大量作用域限定、冲突或例外，NMG 保持节点分离，或创建一个共同的更宽父级。这与 [COBWEB incremental concept formation](https://axon.cs.byu.edu/~martinez/classes/678/Papers/Fisher_Cobweb.pdf) 相呼应，后者会比较增加、创建、合并与拆分类别，而不是假定合并是唯一操作。

安全生命周期是：

```text
candidate pair
  -> classify identity/match/hierarchy relation
  -> shadow canonical view
  -> compare retrieval utility, conflicts, and MDL
  -> accept or reject
  -> reversible canonical view
```

验收从不物理删除来源节点或证据。当前的显式（或被有意启用、受强门控的自动）`mergeNodes` 执行器确实会把记忆所有权迁移到目标节点并重写其局部关系邻域，因此每次新合并还会写入一份精确回滚日志：来源／目标节点快照、原始记忆指派，以及完整的前／后关系集合。只有当每一条被迁移记忆、涉及的节点状态与关系仍与记录的后合并状态一致时，`node rollback` 才在一个即时事务中恢复该状态。它拒绝覆盖之后的编辑。新建的合并目标在回滚之后作为不活动墓碑保留，使稳定 ID 与审计历史不被复用；既有目标则被精确恢复。日志机制之前产生的合并变换无法自动回滚。之后的拆分只重新指派具有已知 provenance 的证据；歧义成员留在旧的／共同父级之下，而不是被猜测进某个子节点。

节点类别需要不同的默认值：

- 实体在强身份证据下可以成为 `SAME_ENTITY`；
- 概念通常使用 exact/close/层级关系；
- 时间或作用域不同的状态使用 `SUPERSEDES` 或共存，而不是合并；
- 重复事件仍是不同事件，可以共享一个事件／问题簇。

由于错误合并比漏掉合并更具破坏性，自动身份使用高不对称损失阈值。对不确定节点对的默认动作是带类型的链接，而不是合并。

BPID 硬负例审计（`topology-bpid-evaluation-2026-08-09.md`）说明了为什么该阈值不能由原始字段相似性提供：即便一个 `0.98` 的多字段阻塞分数，也在 241 个候选中选出了 19 个错配，同时只召回了 4,333 个真匹配中的 222 个。因此候选生成与身份验收是两个独立阶段。廉价的阻塞器可以界定语义审阅范围，但它的分数不被当作经过校准的合并置信度。

可选的 Namesakes 适配器（`topology-namesakes-evaluation.md`）把这种分离对歧义名称显式化。它使用带标签的 `Same`/`Other` 提及，在完整阈值曲线上报告类别名正例召回与精确名称负例拒绝。它是流式的只读 Lab 评测；它不提交提议，也不向 Core 导出 benchmark 阈值。官方 Entities 划分被完整运行（4,148 行；23,996 条被评分提及）。本地 hashing 基线无法把别名与同名异人区分开：在阈值 0.5 处它给出 0.942 召回、0.716 精确率，且对精确名称负例只拒绝 0.026；在 0.7 处拒绝率升到 0.684，而召回崩到 0.304。因此它只能作为宽泛的候选生成器接受，绝不能当作合并置信度或自动拓扑执行器。

一个固定的十实体配对 Agent 探针还比较了干净的 `Same` 证据与同一证据加一条来自另行解析的外来实体页面的高分记录。跨五次随机重复与 50 个配对观测，DeepSeek V4 Flash 的精确归因在干净条件下为 84%、在污染条件下为 88%；五对变错、七对变对，精确 McNemar p 值为 0.774，且没有外来记录被接受。因此该修正探针在这个小样本上没有发现稳定的下游归因效应。自然纠正／恢复成本、更大配对行为，以及端到端答案损害仍未测量。自动身份变更保持关闭。

已实现的 `remember` 边界强制执行这一区分。保存一条记忆之后，Agent 可以把一个有界候选归类为 `same_entity`、`related`、`refines`、`conflict` 或 `distinct`。NMG 验证两条证据记忆属于同一物理 LTG 或会话所属 STG store，保守拒绝作用域不兼容的身份／细化／冲突主张，并拒绝显式有效期区间不重叠的冲突。随后它存储一条携带 provenance 的**待处理拓扑提议**。`same_entity` 创建规制性的 `same_as` 提议；它不调用 `mergeNodes`、不重定向 ID，也不改变任一节点的状态。提议审阅与物理身份合并仍是彼此独立的维护操作。Daemon 暴露一个带类型的拓扑提议管理 RPC，CLI 提供 `topology proposals`、`assess`、`review` 与 `actuate`。评估是只读的；审阅记录显式决策；而执行仍只接受合格的已验收自动合并提议。这些操作保持在 Pi 面向模型的工具面之外。
