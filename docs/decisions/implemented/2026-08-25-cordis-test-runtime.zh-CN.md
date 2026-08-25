# 将 Cordis 限制在测试运行时包装层

[English](2026-08-25-cordis-test-runtime.md)

**Status:** implemented

## 问题

集成测试会反复组合临时工作区、SQLite store 和 HTTP daemon。各测试自行 setup/teardown 会掩盖依赖顺序，并可能在 Windows 上残留锁定文件或进程。若把应用框架直接引入产品代码，又会为了测试问题扩大运行时架构。

## 决策

精确锁定开发依赖 `@deepseek-ai/cordis@4.0.1`，且仅在 `tests/support/test-runtime.ts` 中使用。窄 `TestRuntime` wrapper 组合 workspace、database 与进程内 daemon 插件，并按逆序释放 Cordis fiber。产品模块、发布包和 adapter 不导入 Cordis。

## 考虑过的替代方案

- 每个测试继续手写 `try/finally`：依赖更少，但清理重复且难以发现组合错误。
- 把 Cordis 作为 NMG 应用容器：NMG 不需要其 loader、HMR 或配置系统，会无证据扩大产品边界。
- 自建通用生命周期框架：会为测试专用需求重复成熟的 effect ownership。

## 后果

生命周期测试获得显式依赖与确定性清理，生产架构不变。wrapper 是替换接缝，将来移除 Cordis 不需要修改 NMG Core。精确版本避免测试基础设施在未评审时跟随候选版本变化。
