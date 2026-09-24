# 只断言路由结果的验证器测试省去无关共享检查

[English](2026-09-23-route-only-verifier-fixtures.md)

**Status:** implemented
**Approved:** auto
**Relates to:** [整轮有界的 Agent 验证](2026-09-23-verification-whole-run-deadline.zh-CN.md)

## 问题

四项 narrow 验证器测试只断言路由测试失败及其 TAP 证据，fixture 却在断言之前执行七个成功的共享 npm 检查，为无关性质启动了多个子进程。

## 决策

这些 fixture 使用已有的 `verify.sharedChecks: none` 声明，保留真实 verifier CLI、Git 变更发现、Node 路由测试、receipt 与输出断言。另一个默认 narrow 测试继续断言七项共享检查均已运行，full-mode 测试继续断言完整的声明阻塞集。

该资源选择只作用于测试 fixture，不改变仓库路由或产品验证器的默认行为。

## 考虑过的替代方案

- 每项路由失败测试都运行共享检查：重复启动七个子进程，却没有增加共享检查的独立断言。
- 用进程内 mock 替换 CLI：会失去路由测试执行和证据链边界。
- 所有 narrow 测试都省去共享检查：会失去对默认共享检查下限的直接覆盖。

## 后果

修改前后 28 项验证器测试均通过。一次本机对照中，目标文件由 32.672 秒降到 22.244 秒；四项受影响测试合计由约 17.55 秒降到 5.53 秒。整文件时间仍受机器负载影响。方法见[资源实验](../../experiments/verification/product-file-partitions-2026-09-23.md#resource-boundary-trial)。

若某个路由测试开始断言共享检查执行，就撤销它的 opt-out。若完整阻塞验证失败，或默认 narrow 代表测试不再证明共享检查，则撤销这项 fixture 改动。
