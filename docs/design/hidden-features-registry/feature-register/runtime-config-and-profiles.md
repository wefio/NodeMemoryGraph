# Runtime configuration and scheduling profiles

[简体中文](runtime-config-and-profiles.zh-CN.md) · [Terms](runtime-config-and-profiles.terms.yaml)

**Related:** [Feature register](../feature-register.md)

## Registered options

| Feature | Gate / option | Default | Meaning | Owner | Status |
| --- | --- | --- | --- | --- | --- |
| Shared L1 capability & policy config | `NMG_CONFIG_PATH`, `<dataDir>/nmg.config.json`, or Onlion `NMG_CAPABILITY_CONFIG` JSON | optional (L0 defaults) | Graph recipe and parameter bindings, `allowedAlgorithmicVariants` policy and result identity | `src/integration/runtime-config.ts`; [compute engine](../../unified-architecture/compute-engine.md) | implemented |
| Unified runtime scheduling | `NMG_RUNTIME_PROFILE` or `runtime.profile` in layered configuration | `balanced` | Profile, placement objective and capacity, background admission and CPU allowance | `src/core/runtime/scheduler.ts`; [runtime policy](../../unified-architecture/compute-engine.md#runtime-policy-and-resource-ownership) | implemented |
