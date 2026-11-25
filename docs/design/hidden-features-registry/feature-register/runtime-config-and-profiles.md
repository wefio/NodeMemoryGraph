# Runtime configuration and scheduling profiles

[简体中文](runtime-config-and-profiles.zh-CN.md) · [Terms](runtime-config-and-profiles.terms.yaml)

**Related:** [Feature register](../feature-register.md)

## Registered options

| Feature | Gate / option | Default | Meaning | Owner | Status |
| --- | --- | --- | --- | --- | --- |
| Shared L1 capability & policy config | `NMG_CONFIG_PATH` or `<dataDir>/nmg.config.json` | optional (L0 defaults) | Three-tier `L0 -> L1 -> L2` capability contract bindings, recursive subgraph/parameter overrides, `allowedAlgorithms` policy boundary, and cache `configIdentity` | `src/core/capability-config.ts`, `src/integration/runtime-config.ts`; [compute engine](../../unified-architecture/compute-engine.md) | implemented |
| Unified runtime scheduling profile | `NMG_RUNTIME_PROFILE` (or L1 `runtimePolicy.profile`) | `balanced` | `eco` / `balanced` / `performance` load-governed background concurrency, CPU slice budgets, and worker-pool offload policy; falls back to event-loop utilization and delay budgets when OS power/thermal telemetry is unavailable | `src/core/runtime/load-governor.ts`, `src/core/runtime/scheduler.ts`; [compute engine](../../unified-architecture/compute-engine.md) | implemented |
