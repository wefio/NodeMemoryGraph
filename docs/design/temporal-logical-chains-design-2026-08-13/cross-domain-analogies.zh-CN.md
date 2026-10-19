# 跨域结构类比：研究与实现边界

[English](cross-domain-analogies.md) | [简体中文](cross-domain-analogies.zh-CN.md) · [术语](cross-domain-analogies.terms.yaml) · 上级：[时间／逻辑链设计历史](../temporal-logical-chains-design-2026-08-13.md)

历史研究记录及经源码核对的实现摘要。本次审计未独立核验 2026-08-13 草稿引用的外部论文和主张。当前实现是结构候选生成，不是通用语义类比系统。

## 目标与非目标

该设计探索结构相似的子图能否提示有用的跨域连接。它不是普通语义搜索，也不是在同一个连通邻域内重复做子图匹配。输出只是供调用方检查的建议；不能据此证明两个主题含义相同。

当前实现会排除与查询 cluster 存在 consolidated relation 直接连接的结点。这并不能证明返回结点在语义上无关；实现并不执行语义独立性测试。

## 当前结构签名

`src/core/store/analogy.ts` 将输入 node ID 集合归纳为五种结构模式的存在性和计数：

- `EVOLUTION`：与某结点关联的 supersession 记录；
- `CONTRADICTION`：由 consolidated `contradicts` relation 连接的唯一结点对；
- `DEPENDENCY`：consolidated `depends_on` 或 `causes` relation；
- `AGGREGATION`：consolidated `is_a` 或 `part_of` relation；
- `FEEDBACK`：在模块配置的有向 relation 类型中发现的有向环。

`abstractSubgraph()` 会有意忽略结点名称和 statement 文本。`findStructuralAnalogies()` 构建查询签名，检查其他结点的 ego subgraph（`hops` 默认 `1`），并按 pattern type 的 Jaccard overlap 对非空签名排序。模式计数不会加权 Jaccard 分数。默认候选数为五。操作返回 node ID、名称、分数、共享 pattern type 和目标签名；它不会写入记录、relation 或 chain，也不会更改检索排序。

测试套件包含构造出来的“budget／tech-stack”fixture 和反向查询检查。Fixture 命中（包括 pattern-type 集合相同时分数为 `1.0`）不能证明普遍的跨域准确率、precision、recall 或用户价值。本文不声称有 benchmark 结果。

## 与其他图路径的关系

Memory-chain expansion、graph-neighborhood retrieval、cycle diagnostics 和结构类比建议是不同操作。Chain 是显式编写的结构；类比是根据 pattern overlap 计算出的建议结果。二者都不授权系统写入新的语义 relation 或 memory。参见上级[链设计历史](../temporal-logical-chains-design-2026-08-13.md)、当前[链源码契约](converged-design.md)和 [supersession 设计](../supersession-design.md)。

## 历史研究背景

旧稿引用了 structure-mapping／SME、MAC/FAC、图迁移与拓扑模式研究、知识图谱嵌入类比（AnKGE）、graph edit distance／SimGNN、面向好奇心的认知架构，以及 G²SN-Transfer，作为未来工作的背景。它还引用 TrustMem 和 MemOps，讨论保守变更与失败归因。这些是历史记录中的文献线索，不是经核验的 NMG 证据；本文不复现其中的量化主张。

## 源码参考

参见 [`src/core/store/analogy.ts`](../../../src/core/store/analogy.ts)、[`tests/core/analogy.test.ts`](../../../tests/core/analogy.test.ts)、[memory-chain 实现](../../../src/core/store/base.ts)和 [chain retrieval 路径](../../../src/core/store/retrieval.ts)。