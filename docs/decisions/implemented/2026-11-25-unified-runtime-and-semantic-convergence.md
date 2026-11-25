# Unified runtime scheduler, layered capability config, and semantic convergence

[简体中文](2026-11-25-unified-runtime-and-semantic-convergence.zh-CN.md) · [Terms used](2026-11-25-unified-runtime-and-semantic-convergence.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [unified memory compute engine](2026-11-24-unified-memory-compute-engine.md)

## Problem

While core retrieval and write pipelines ran inside compute graphs, architectural fragmentation persisted across four boundaries:

1. **Planner and cache correctness defects:** `PLAN_CACHE` collided across distinct `ComputeRegistry` instances sharing the same generation counter; `runDcePass` unconditionally skipped unreachable `node.subgraph` nodes regardless of side effects; `fused_chain` dropped per-step parameters from node/plan signatures and left dangling source edges after chain fusion; and `isDeeplyFrozen` / canonical hashing treated frozen built-in containers (`Map`, `Set`, `Date`, `RegExp`, `ArrayBuffer`, typed arrays) as shallow immutable empty objects.
2. **Duplicated business semantics:** Tail-score capping (`capSupplementalTailScores`), chronological ordering, dual-channel fusion, HTTP single-clause/profile shortcuts, and adapter workspace/recall/coordination defaults were re-implemented across `retrieval-graph.ts`, `http-search-graph.ts`, `search-compute-graph.ts`, `portable-memory.ts`, `local-memory-http.ts`, `workbuddy-plugin/nmg-hook.ts`, and DSH adapters.
3. **Scattered configuration without contract enforcement:** Runtime tuning thresholds, graph overrides, and backend selections existed as ad-hoc constants or adapter-local option readers without provenance inspection, cache identity participation, or policy checks against unapproved semantics-changing algorithmic switches.
4. **Barrier-coupled async execution and polling:** `runAsyncPlan` stalled parallel DAG branches behind synchronous full-wave `Promise.all` barriers, background sweeps (`LocalMemoryEmbeddings.sweep`, `HttpMemoryService.backfillVectors`) ran outside priority budgets, and `NmgService.drain` polled instead of waiting on readiness events.

## Decision

NMG converges public semantics, three-tier capability binding, and event-driven scheduling on top of the existing recursive compute graph abstraction:

1. **Correctness & canonical safety (`src/core/canonical-value.ts`, `src/core/compute-planner.ts`, `src/core/compute-graph.ts`):** Keys `PLAN_CACHE` on WeakMap-tracked `ComputeRegistry` instance tokens plus `configIdentity`, makes `runDcePass` inspect nested subgraphs recursively for non-eliminable nodes, includes per-step parameters and edge rewrites in `fused_chain`, rejects shallow freeze fast paths on built-in stateful/binary containers and accessors, and hashes containers structurally.
2. **Single public semantic library (`src/core/memory/page-stitch-operators.ts`, adapters):** Centralizes dual-channel fusion, chronological ordering, supplemental tail capping, and page stitching (`fuseDualChannelCandidates`, `capSupplementalTailScores`, `stitchSupplementalPage`) and routes `MemoryEngine`, `PortableMemoryService`, `HttpMemoryService`, `local-memory-http.ts`, `workbuddy-plugin/nmg-hook.ts`, and DSH plugins through shared integration helpers.
3. **Three-tier `L0 -> L1 -> L2` capability config (`src/core/capability-config.ts`, `src/integration/runtime-config.ts`):** Establishes validated parameter schemas and default bindings (`L0`), shared file/env configuration (`L1`, `NMG_CONFIG_PATH` or `<dataDir>/nmg.config.json`), and minimal adapter overrides (`L2`) with provenance reporting, `configIdentity` cache keying, and strict `PolicyViolationError` rejection of unapproved algorithmic switches.
4. **Unified event-driven runtime:** Both production and experiment asynchronous graphs enter `UnifiedRuntimeScheduler`. The planner supplies effect and data dependencies. The scheduler coordinates named resources across graphs, drains failed branches, shares eligible memoized work and executes the cost model's selected Worker leaf. The synchronous path retains the low-overhead inline loop. [Compute engine contract](../../design/unified-architecture/compute-engine.md)
5. **Host binding and vector backfill:** Node HTTP, daemon and portable engines bind the same L1 capability catalog at their data-directory boundary. Both vector backfill paths share validation and publication of one embedding batch. The daemon owns cursor progress and the HTTP service owns the bounded batch and deferred-embedding retry contract. Onlion supplies a request-local scheduler for its snapshot. [Runtime policy](../../design/unified-architecture/compute-engine.md#runtime-policy-and-resource-ownership)

## Alternatives considered

1. **Building a separate workflow orchestration engine or wrapping business functions as coarse opaque nodes:** Rejected because the existing recursive `ComputeGraphSpec` and planner already compose business graphs cleanly once duplicate inline logic is extracted into public operators.
2. **Adopting heavyweight distributed frameworks or native C++ addons for single-host scheduling:** Rejected because Node `worker_threads`, cost-aware EFT gating, and event-driven DAG dispatch cover single-host NMG concurrency cleanly with zero external binary dependencies or license complications.

## Consequences

- Planner caching, nested subgraph DCE, `fused_chain` invalidation, and frozen container caching are deterministic and covered by `tests/core/compute-architecture-guardrails.test.ts`.
- All adapters share one parameter schema, provenance API, and `PolicyViolationError` boundary without duplicating tail-capping or HTTP shortcut logic (`tests/integration/unified-semantics-parity.test.ts`).
- Synchronous microsecond compute chains retain their inline zero-hash fast path while asymmetric async DAGs execute ready branches immediately and multi-worker CPU batches scale through shared scheduler budgets (`tests/core/unified-runtime-scheduler.test.ts` and [convergence benchmark](../../experiments/runtime/unified-runtime-convergence-2026-11-25.md)).

## Deferred

- Multi-host distributed task queues, cross-node work stealing, and remote failure recovery beyond single-host `SchedulingDomain` recursion.
- Direct Windows EcoQoS Win32 FFI calls and Linux cgroup controllers until measured workstation/server contention motivates native bindings beyond event-loop and worker-budget control.
- Worker-resident intermediate data, general preemption and global DAG makespan optimization. Current placement uses runnable work and measured input/IPC costs. The matched trials compare the gain from event readiness and thread scale separately from application search. [Experiment](../../experiments/runtime/unified-runtime-convergence-2026-11-25.md)
