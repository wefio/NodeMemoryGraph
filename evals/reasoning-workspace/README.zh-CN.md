# 推理工作区 benchmark

[English](README.md) | [简体中文](README.zh-CN.md) · [术语](README.terms.yaml)

这个开发期 benchmark 测量仅限 Lab 的 `nmg_reason` 工作区是否帮助 agent 维持显式
的任务状态。它与 LongMemEval、LoCoMo、PersonaMem 与 BEAM 分开，因为那些套件不
调用推理工作区。

只有当 `NMG_ENABLE_LAB_TOOLS=1` 时，产品适配器才暴露 `nmg_reason`。草稿节点按 Pi
会话存储在 `NMG_DATA_DIR/reasoning/` 下。普通轮次不会收到自动的工作区注入；Pi 的
压缩会创建一个持久标记，下一轮会收到一个有界的检查点，即使扩展进程重启过。该工具
从不把草稿状态写入 STG 或 LTG。

benchmark 在四种条件下比较同一个模型与同一批用户提示词：

1. 完整上下文，无工作区；
2. 完整上下文，工作区可用；
3. Pi 压缩，无工作区；
4. Pi 压缩，工作区可用。

任务要求 agent 保留观察、被否决的假设、决策、约束、版本与下一步行动。压缩试验会
加入相同的无关历史，并在最后的问题之前调用 Pi 的常规压缩器。

运行：

```powershell
npm run eval:reasoning-workspace
```

有用的控制项：

```text
NMG_PI_MODEL
NMG_REASONING_CASE=debugging|planning|incident
NMG_REASONING_REPEATS=3
NMG_REASONING_CONCURRENCY=8
```

报告写在被忽略的 `results/` 目录下。这是一个小的开发信号，不是公开 benchmark 或
leaderboard 结果。要逐个检查输出与工作区文件：精确回忆可能改善，同时延迟或不受支持
的草稿主张出现回归。

## 初始开发信号

2026-07-26，DeepSeek V4 Flash 每个条件跑三个任务、三次重复：

| Context   | Arm       | Exact success | Expected-detail recall | Mean latency |
| --------- | --------- | ------------: | ---------------------: | -----------: |
| Full      | Baseline  |          100% |                   100% |       5.79 s |
| Full      | Workspace |          100% |                   100% |      15.15 s |
| Compacted | Baseline  |         88.9% |                  88.9% |       9.83 s |
| Compacted | Workspace |          100% |                   100% |      23.41 s |

九次压缩工作区试验中有一次持久化了一条不受支持的假设标记。样本太小，不足以做能力
主张，但它确立了两条产品要求：

- 只有当任务复杂度或上下文压力足以证明其成本时才激活工作区；
- 区分模型提出的假设与观察到的证据，并阻止不受支持的草稿状态被自动 consolidation
  进 LTG。
