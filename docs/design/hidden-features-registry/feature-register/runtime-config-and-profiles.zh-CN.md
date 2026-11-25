# 运行时配置与调度策略档位

[English](runtime-config-and-profiles.md) · [使用的术语](runtime-config-and-profiles.terms.yaml)

**Related:** [功能注册表](../feature-register.zh-CN.md)

## 已注册选项

| 功能 | Gate／选项 | 默认值 | 含义 | owner | 状态 |
| --- | --- | --- | --- | --- | --- |
| Shared L1 capability & policy config | `NMG_CONFIG_PATH` 或 `<dataDir>/nmg.config.json` | 可选（回退至 L0 默认） | `L0 -> L1 -> L2` 三级能力契约绑定、递归子图与参数覆盖、`allowedAlgorithms` 策略边界及缓存 `configIdentity` | `src/core/capability-config.ts`、`src/integration/runtime-config.ts`；[统一记忆计算引擎](../../unified-architecture/compute-engine.zh-CN.md) | 已实现 |
| Unified runtime scheduling profile | `NMG_RUNTIME_PROFILE`（或 L1 `runtimePolicy.profile`） | `balanced` | `eco` / `balanced` / `performance` 负载感知后台并发度、CPU 时间片预算与线程池卸载策略；系统供电／温度遥测不可用时退化为事件循环利用率与延迟预算控制 | `src/core/runtime/load-governor.ts`、`src/core/runtime/scheduler.ts`；[统一记忆计算引擎](../../unified-architecture/compute-engine.zh-CN.md) | 已实现 |
