# Runtime configuration and scheduling profiles

[简体中文](runtime-config-and-profiles.zh-CN.md) · [Terms](runtime-config-and-profiles.terms.yaml)

**Related:** [Feature register](../feature-register.md)

## Registered options

| Feature | Gate / option | Default | Meaning | Owner | Status |
| --- | --- | --- | --- | --- | --- |
| Shared L1 capability & policy config | `NMG_CONFIG_PATH`, `<dataDir>/nmg.config.json`, or Onlion `NMG_CAPABILITY_CONFIG` JSON | optional (L0 defaults) | Graph recipe and parameter bindings, `allowedAlgorithmicVariants` policy and result identity | `src/integration/runtime-config.ts`; [compute engine](../../unified-architecture/compute-engine.md) | implemented |
| Unified runtime scheduling | `NMG_RUNTIME_PROFILE` or `runtime.profile` in layered configuration | `balanced` | Profile, placement objective and capacity, background admission and CPU allowance | `src/core/runtime/scheduler.ts`; [runtime policy](../../unified-architecture/compute-engine.md#runtime-policy-and-resource-ownership) | implemented |
| Backend optimization delegation | `NMG_OPTIMIZATION_BACKEND` or `optimization.*` (`backend`, `enableRegionLowering`, `enableLinearFusion`, `enableSyncKernel`, `costRatioThreshold`) | `auto` / enabled / `1.0` | Selects SQLite, portable, or JS/V8 lowering policies and cost-ratio threshold across L0/L1/L2 without altering `resultIdentityHash` | `src/core/compute-lowering.ts`; `src/core/capability-config.ts`; [backend delegation](../../unified-architecture/compute-engine.md#backend-optimization-delegation-and-lowering) | implemented |
