---
name: omnimemeval-eval
description: Run or continue OmniMemEval user-memory evaluations through NMG's AML HTTP adapter. Use for upstream benchmark setup, Add/Search runs, or result continuation.
---

# OmniMemEval 评测

安装、环境变量和官方 LongMemEval 命令见 [AML HTTP 指南](../../../evals/omnimemeval/README.zh-CN.md)。数据集专用参数和检查点选项以固定版本的上游套件为准。

## 续跑

运行前记录端点、实验命名空间、套件版本和数据集设置。续跑该结果目录时沿用这些值。独立实验使用新的命名空间。

## 边界

答案生成、评分、检查点和报告由 OmniMemEval 负责。NMG 通过 AML HTTP 提供 Add 和 Search。保持清理与流式模式关闭。NMG 证据审计单独读取已完成的评测产物。
