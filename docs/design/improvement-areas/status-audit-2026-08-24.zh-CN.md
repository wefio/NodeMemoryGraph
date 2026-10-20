# 状态审计 — 2026-08-24

[English](status-audit-2026-08-24.md) | [简体中文](status-audit-2026-08-24.zh-CN.md) · [术语](status-audit-2026-08-24.terms.yaml)

**权威范围：**[父级范围](../improvement-areas.zh-CN.md)。以下是截至 **2026-08-24** 的历史状态快照，不是当前状态台账；当前行为请查看父级范围与源码 owner。

| # | 领域 | 2026-08-24 记录的状态 |
|---|---|---|
| 1 | Store 分解 | **按当时架构已解决。**`store.ts` 是八行 mixin façade；base、graph、retrieval、writes、maintenance、schema、ranking、Active Graph、row parsing、vector concerns 已拆成独立模块并有边界测试。只有实测模块边界成为维护问题时才重审。 |
| 2 | Vector-cache 失效 | **所述机制已解决。**存在 `Float32VectorCache.remove(id)` 与定向失效测试；只有实测重建延迟回退时才重审。 |
| 3 | Router 表达能力 | **机制与因果工程对比完成；拒绝晋升。**自定义 autodiff controller 学习 node、memory、edge、control、budget heads；冻结候选在匹配 Pi run 中执行有界 node reranking、allocation、folding，并记录 typed action telemetry，官方评分 fail-closed。固定 14 问题、七类别开发对比改善答案与官方 evidence recall，但 token 和延迟增加，未通过产品 gate；独立 LoCoMo retrieval gate 也未通过。晋升前仍需自然匹配证据与可接受产品成本。 |
| 4 | 隐私删除 | **产品 surface 部分完成。**CLI／RPC／Pi 支持逻辑撤回与版本化 user-memory export，并清理 FTS／embedding／evidence／leaf／claim／proposal／AG 及不再支持的派生记忆级联。物理历史擦除、不可减去的学习聚合重置、adapter hooks 与擦除回执仍开放。 |
| 5 | 仅 regex 的 recall gate | **开放。**英语／中文确定性覆盖有测试；多语言语义 gate 与实测 false-positive／false-negative 率尚无。 |
| 6 | 测试覆盖 | **当时已大幅改善。**所列中文、graph、split、cache、deletion、QPP mode／recommendation／folding 与 controller actuation 路径有确定性覆盖。真实 Pi schema drift 与自然 topology adaptation 仍是重要缺口。 |
| 7 | ANN recall | **依据证据推迟。**默认仍是本地精确扫描；未证明 recall／latency crossover 前不得晋升当前 ANN 路径。 |
| 8 | 并发模型 | **按当时 daemon 架构已解决。**一个 resident daemon 是应用级权威；同步 SQLite 阶段串行，外部调用可以重叠，但不持有 transaction。 |
| 9 | Session serialization | **部分完成。**Capture 自动且幂等；Pi projection 有 fail-closed `pi.branch.v1` 形状契约与测试，但仍从 `unknown` 手动校验，尚未与上游 schema 协商。 |
| 10 | Topology acceptance | **有意保持 Lab／人工。**Proposal 创建与显式 review 可用；无人值守 mutation 尚无 precision gate。 |

---
