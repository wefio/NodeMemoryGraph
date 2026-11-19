# 节点与叶块用于结构检索

[English](2026-11-19-structural-leaves-record-vectors.md) · [术语](2026-11-19-structural-leaves-record-vectors.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

SQLite 同时保存记录、节点和叶向量。本地 LoCoMo 消融中，记录级 hybrid 的证据 Recall@20 为 59.75%，加入两层向量后为 59.24%，一些查询仍从层级评分中获益。已有叶成员关系也能直接定位相关证据。

## Decision

通过节点名称和已有关系进行结构定位，语义评分集中在记录级。以排序靠前的记录为起点，通过已有叶成员关系或共同原始证据补充上下文。补充数量有上限，始终限定在起点所属作用域内。

本地兼容值 `hierarchy` 和 `union` 都请求有界叶块上下文。所选的词法或记录级检索负责找起点。叶块只填补空余名额，并在检索结果中标明来源。

## Alternatives considered

保留一套语义层级会持续承担独立的评分和存储开销。按固定时间窗划分新组可能把长会话中无关事实放在一起。已有成员关系和共同原始证据可以提供来源明确的直接相邻关系。为叶块预留排序名额会使 LoCoMo 证据 Recall@20 从 59.75% 降到 57.71%。

## Consequences

SQLite 升级保留成员关系和记录向量，释放派生节点和叶向量表的空间，页由后续写入复用。结构扩展的评测与原层级评分分开计量。
