# 运行时配置与调度策略档位

[English](runtime-config-and-profiles.md) · [使用的术语](runtime-config-and-profiles.terms.yaml)

**Related:** [功能注册表](../feature-register.zh-CN.md)

## 已注册选项

| 功能 | Gate／选项 | 默认值 | 含义 | owner | 状态 |
| --- | --- | --- | --- | --- | --- |
| 共享 L1 能力与策略 | `NMG_CONFIG_PATH`、`<dataDir>/nmg.config.json` 或 Onlion `NMG_CAPABILITY_CONFIG` JSON | 可选（使用 L0 默认） | 图配方及参数绑定、`allowedAlgorithmicVariants` 策略和结果身份 | `src/integration/runtime-config.ts`，[统一记忆计算引擎](../../unified-architecture/compute-engine.zh-CN.md) | 已实现 |
| 统一运行时调度 | `NMG_RUNTIME_PROFILE` 或三级配置中的 `runtime.profile` | `balanced` | 负载档位、放置目标和容量、后台准入和 CPU 额度 | `src/core/runtime/scheduler.ts`，[运行策略](../../unified-architecture/compute-engine.zh-CN.md#运行策略与资源所有权) | 已实现 |
| 后端优化委托策略 | `NMG_OPTIMIZATION_BACKEND` 或三级配置中的 `optimization.*`（`backend`、`enableRegionLowering`、`enableLinearFusion`、`enableSyncKernel`、`costRatioThreshold`） | `auto` / 开启 / `1.0` | 跨 L0/L1/L2 选择 SQLite、portable 或 JS/V8 下推与融合开关及成本阈值，不影响 `resultIdentityHash` | `src/core/compute-lowering.ts`、`src/core/capability-config.ts`，[后端优化委托](../../unified-architecture/compute-engine.zh-CN.md#后端优化委托与降级转换) | 已实现 |
