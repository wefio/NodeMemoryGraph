# 文档维护指令

[English](AGENTS.md) · [术语](AGENTS.terms.yaml)

在此目录中处理文档时，使用 [`doc-maintenance` Skill](../skills/doc-maintenance/SKILL.zh-CN.md)，并阅读[文档索引](README.zh-CN.md)中的归属规则。

将设计意图、决策理由、测量证据、实现状态、事件叙述和未解决工作分别保存在各自的 owner 文档中。不要仅为了保留编辑历史而重复创建 owner；Git 已保存这些历史。

对于已逃逸的故障，应用[事后复盘分流规则](postmortem/README.zh-CN.md#何时编写复盘)。符合条件时，在 `postmortem/` 下创建带编号的记录，并添加到索引。

NMG 的仓库协作入口以 Agent 为先：根目录 `AGENTS.md` 是稳定的启动路由；本文件负责引导文档工作；`docs/README.md` 是文档 authority 的 owner。只有当新增根目录入口能阻止当前这些路由无法涵盖的明确协作失败时，才添加它；创建前须指定 owner 和验证合同。
