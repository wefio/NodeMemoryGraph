# 实验

[English](README.md)

测量证据。这里的记录报告观测到了什么；只有决策或设计 owner 接纳结果后，它才成为
规范（见 [doc-maintenance](../../skills/doc-maintenance/SKILL.md)）。

## 主题

一次运行放在**它回答的那条探究线**所对应的主题目录里。报告命名为
`<slug>-<YYYY-MM-DD>.md`，当 slug 的某个前缀与目录名重复时去掉该前缀。滚动汇总或
笔记用 `-results.md` / `-notes.md` 代替日期。

| 目录 | 范围 |
| --- | --- |
| `retrieval-quality/` | 端到端检索质量系列，含其续跑状态 |
| `retrieval/` | 检索机制：HyDE、节点摘要加速、渐进式披露 |
| `context/` | 上下文组装、路由与干预 |
| `topology/` | 图拓扑与同名节点效应 |
| `qpp/` | 查询性能预测 |
| `benchmarks/` | 数据集运行：LongMemEval、LoCoMo、BEAM、HaluMem |
| `store/` | 存储：consolidation、规模、写路径 |
| `runtime/` | 嵌入后端、autodiff 算子、controller shadow |

`benchmark-results.md` 留在顶层，因为它跨主题。
