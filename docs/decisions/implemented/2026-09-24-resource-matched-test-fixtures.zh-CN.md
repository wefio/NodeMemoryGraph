# 按断言观察的资源选择测试 fixture

[English](2026-09-24-resource-matched-test-fixtures.md)

**Status:** implemented
**Approved:** auto

## 问题

产品测试的四类资源需求被误作四个固定的运行器分区。固定调度在当前工作树更慢，
但这个结果不能回答每类资源的准备工作是否有可省的成本。

## 决策

按断言能观察到的边界选择 fixture：纯决策使用进程内数据；单连接行为使用各项
独立的内存 SQLite；持久化和路径行为使用唯一文件数据库或工作区；外部行为
使用真实 Git、CLI、HTTP 或进程资源。这一选择与 Safety/Contract/Guardrail
以及 narrow/full 验证归属正交。

不观察 Git 发现、dirty 范围或提交来源的 RCP 编排测试注入固定的
`RepositoryProvider` 观察值，不创建 Git 仓库。断言这些边界的测试仍使用真实
提供者和仓库。真实 Git fixture 保留 `init`、`add` 和 `commit`，但将测试提交
身份通过 `git -c` 传给 `commit`，不再为每个 fixture 分别启动两个配置进程。

## 考虑过的替代方案

- 把四类资源当成固定 Node worker 分区：实测分区和文件排序候选都比现有入口慢。
- 所有 RCP 测试都使用固定观察值：范围、提交、forge 和 Git 故障断言需要
  真实仓库行为，因此拒绝。
- 所有编排测试都初始化 Git：这些测试只消费提供者结果，并不断言 Git 如何
  产生结果，因此拒绝。
- 多项测试共享一个可变数据库或 Git 仓库：运行顺序及并发可能影响结果。

## 后果

- 十个 reconciliation 测试保留真实 Git 观察；八个使用固定观察值。每个真实
  Git fixture 也少启动两个 Git 子进程。文件级改善已经复测，整套测试提速
  仍未得到证明。
- fixture 规则只指导准备工作；route 覆盖与 150 秒出结果时限仍由验证契约负责。
- 若固定观察值测试后来需要断言 Git 范围或来源，应恢复真实 Git。若测试需要
  仓库本地的 Git 身份配置，或受支持的 Git 环境行为不同，应撤销这一提交
  身份捷径。
