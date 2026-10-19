# 信息与通信视角

[English](information-and-communication-interpretation.md) · [使用的术语](information-and-communication-interpretation.terms.yaml)

**Authority:** [父级范围](../design.zh-CN.md)。

信息论模型是设计和评估框架，不要求实现字面意义上的 codec：

```text
Historical stream       information source
Memory extraction       source encoder into STG
LTG nodes/relations     consolidated semantic codebook
Node/leaf headers       progressive access codes
SQLite/index            storage channel
Query/current context   decoder side information
Active Graph builder    query-conditioned decoder
Raw evidence            lossless fallback and error check
```

STG 在结构编码稳定之前保留近期或临时符号。LTG 存储持久的原子记忆和已巩固关系。Active Graph 只解码当前任务所需的有界投影。Node header 是有损短码；leaf header 增加区分信息；typed relation 提供 side information；原始历史避免不可逆丢失。

这种解释提供术语和可测量目标；它不声称实现是字面意义的通信信道，也不声称语义错误是相互独立的 bit flip。已实现数学与结构类比之间的区别见[`math-physics-foundations.md`](../math-physics-foundations.md)。

可用最小描述长度/率失真目标评估拓扑：

```text
J = structure_cost
  + lambda * semantic_distortion
  + mu     * retrieval_cost
  + nu     * maintenance_cost
```

语义失真不是 bit error rate。相关的可观察错误包括：

- node 或 block 路由错误；
- 缺少支持证据；
- scope 错误；
- 选择了过时状态；
- summary 与 evidence 不一致；
- 错误扩展 relation。

混合信号充当纠错冗余：FTS/exact terms、embeddings、time/scope fields、graph paths 和 raw evidence 可以相互纠正。只有当结构变化带来的预期 retrieval distortion 降低足以抵消额外复杂度与维护成本时，才有理由采用该变化。