# 将 Agent 验证限制为一整轮预算

[English](2026-09-23-verification-whole-run-deadline.md)

**Status:** implemented
**Approved:** explicit

## 问题

过去 `agent:verify --timeout-ms` 给串行的每项检查重新计时。设为 150 秒时，
整轮仍可能花费数倍于 150 秒，无法满足出结果的时限。

## 决策

官方 `npm run agent:verify` 入口默认使用 150 秒整轮预算，`--timeout-ms` 调整
的是这个总预算。外层看门进程在同步准备等阶段越界时返回 `incomplete` 失败并写入
失败证据。普通、RCP full 和 RCP narrow 检查都只获得剩余时间。预算耗尽后，不再
启动待运行的检查，而是逐项记为失败；整轮结论也失败。局部通过不能冒充整轮通过。

Agent 验证器的 `ci-and-tests` route 列出 `verify:static` package contract 的原子检查和
`test:product`。完整计划按同名检查跨 route 去重，每项原子检查只执行一次，同时保留独立
结果及 route 归因。测试约束该 route 与静态 package contract 保持一致。CI 继续以
`verify:static` 作为可复现的命名入口。

非 RCP 的 Agent full 计划对相邻且独立的静态检查以最多三个并发执行，遵守构建、打包和
产品测试的串行屏障。批次包含测试源码类型检查、anchor 解析与 policy-word 检查；
它们均不改写根源码或 `dist`，子包构建和复杂度探针使用独立路径。
结果仍按声明顺序排列，保留逐项失败归因，并共用同一整轮预算。
RCP 与 narrow 验证保持原有串行执行。

`test:product` 最多使用八个 Node 测试文件 worker。文件 glob、测试正文、失败判定和
清理契约不变；coverage 仍使用两个 worker，文件清单不变。
沿用 Node 自身调度器，不采用固定分区、依赖图测试子集，也不与生成文件写入者重叠。
[余量观察](../../experiments/verification/full-gate-margin-2026-10-09.md)记录具体负载及重复计时。

## 考虑过的替代方案

- 保留逐命令超时：串行检查会使总时长远超用户要求，因此拒绝。
- 停止运行但不记录待检查项：缺失的检查容易被误认为不适用，因此拒绝。
- 同时运行 `verify:static` 和它包含的独立 route 检查：重复工作消耗同一整轮预算，
  却不增加独立覆盖；直接跳过独立结果又会失去逐项归因，因此拒绝。
- 将所有阻塞检查同时启动：构建与打包会改写其他检查读取的生成文件；无限制的进程并发
  还会与产品测试争用资源，因此拒绝。

## 后果

- 超时属于未完成验证，需要整改并重新运行。
- 外层进程限制官方 CLI 的出结果时间，超时时终止直接的验证器进程；但不能保证
  npm 的后代进程均已退出。重新运行前仍须检查活动的 mutation lock。
- Agent 计划保留更多逐项归因的结果，但不重复执行其他 route 共享的静态检查。
  CI contract 不变。
- 有界并发缩短实测关键路径，但 CPU 密集检查可能因资源争用而变慢。
  计时证据只覆盖实测负载与机器，并非通用最坏耗时保证。
  未能按时完成时，不变的 150 秒整轮预算仍失败关闭。
