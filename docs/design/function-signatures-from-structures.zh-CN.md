# 从结构类比到函数签名

[English](function-signatures-from-structures.md) | [简体中文](function-signatures-from-structures.zh-CN.md) · [术语](function-signatures-from-structures.terms.yaml)

创建于 2026-07-20 的历史设计脑暴。下方类比列表用于生成问题和候选接口，不是产品需求、当前 API 清单，也不能证明 NMG 具有其他领域的保证。

原始记录的前提是：识别出熟悉的结构后，可以借助已有词汇讨论输入、输出和边界条件。下面的例子是提案，不是代码契约。当前实现和行为必须查阅各自的源码与设计 owner。

## 类比目录

| NMG 考虑的领域 | 结构类比 | 类比提出的问题 | 边界 |
|---|---|---|---|
| Index deltas 与 rebuilds | LSM tree | 是否需要可观测的积压或 backpressure 信号？ | 不能据此认定必须采用完整 LSM compaction 模型 |
| Node redirects 与 merge/split | Union-Find | Path compression 是否有益？split 歧义应如何表达？ | Union-Find 本身不适合可逆 split 操作 |
| State supersession | MVCC | 哪些历史读取或 diff 有用？ | 与版本管理相似，不代表完整 MVCC 语义 |
| Co-retrieval signals | 关联规则挖掘 | Support、confidence 或 lift 能否区分真实关联与 popularity？ | 候选度量不是经过验证的 relevance signal |
| Multi-channel retrieval | Ensemble 方法 | 是否应学习 channel weights 或暴露 reliability？ | 类比不能证明 learned fusion policy 有效 |
| Node identity 与 partition 变化 | 等价类／聚类 | 什么证据应触发 split、merge 或 refinement？ | 聚类指标不是自动 merge/split 的授权 |
| Vector caching | CPU cache 层级 | 哪些操作需要 load、eviction、invalidation 或命中率指标？ | Scale 和 cache policy 需要 workload evidence |
| Write policy | IDS／规则引擎 | 规则是否需要可配置、可解释？ | 不能据此授权另一个隐式写入裁判 |
| Graph expansion | Diffusion process | 概率传播或衰减能否改善有界遍历？ | 这是提案，不是当前检索行为 |

## 当前 owner

当前、单独审阅过的类比文档包括[结构类比](structural-analogies.zh-CN.md)、[State supersession 与 MVCC](structural-analogies/state-supersession-and-mvcc.zh-CN.md)、[Co-retrieval 与 Hebbian learning](structural-analogies/co-retrieval-and-hebbian-learning.zh-CN.md)和[多通道检索与 Ensemble stacking](structural-analogies/multi-channel-retrieval-and-ensemble-stacking.zh-CN.md)。这些文档明确区分解释性比较、产品要求与实现证据。

当前代码请查阅 [`src/core/store/`](../../src/core/store/) 下的相关模块，以及[实现沿革索引](implementation-lineage.md)。本文不声称旧稿中的“已有”或“缺少”清单仍然准确。