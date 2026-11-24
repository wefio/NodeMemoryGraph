# Unified memory compute engine and production graph takeover

[简体中文](2026-11-24-unified-memory-compute-engine.zh-CN.md) · [Terms used](2026-11-24-unified-memory-compute-engine.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [authoritative relational store](2026-11-24-authoritative-relational-memory-store.md)

## Problem

After cutting SQLite over to normalized relational tables, compute graphs only ran inside `piecewise-rerank.ts`, `http-search-graph.ts`, and standalone `retrieval-graph.ts`, leaving three structural gaps:

1. `MemoryEngine` (`src/core/memory/engine.ts`, 1,773 lines) directly mixed orchestration with concrete recall, temporal windowing, neighborhood expansion, evidence hydration, projection, profile filtering, and mutation planning logic.
2. Logical graph semantics were undifferentiated from physical execution details, and unannotated black-box operators could not declare progressive capabilities or backend lowering targets.
3. `ComputeMemoCache` and graph execution needed strict clone isolation on mutable outputs, per-closure identity keys instead of `.toString()` hashes, explicit state-stamp invalidation, dynamic `graphAsOperator` capability propagation, resource-conflict wave serialization, bounded LRU capacity, ref-counted intermediate deallocation, and a zero-hash uncached fast path.

## Decision

NMG adopts a layered compute architecture cleanly separated from authoritative storage:

1. **Contracts and progressive capabilities (`src/core/compute-contracts.ts`):** Defines `MEMORY_COMPUTE_CONTRACTS`, conservative `resolveCapabilities` (defaulting unannotated black-box operators to `"opaque"`), `ComputeStateStamp` helpers, five unified node realization forms, and `adaptExternalAlgorithm`.
2. **Logical-to-physical planner (`src/core/compute-planner.ts`):** Compiles `ComputeGraphSpec` into cached `PhysicalExecutionPlan` instances supporting contract binding, CSE, DCE, `relational_query` lowering (`sqlite_pushdown` vs `portable_scan`), optional synchronous `fused_chain` fusion, resource-conflict wave scheduling, and reference-counted consumer lifetimes.
3. **Hardened runtime (`src/core/compute-graph.ts`):** Isolates cached mutable values via `structuredClone`, tracks closure instances via `COMPUTE_CACHE_TOKEN` / `WeakMap` IDs, enforces `hasRequiredStateStamp` and downstream taint propagation, computes dynamic `SUBGRAPH_OPERATOR_META` signatures/capabilities, bounds `ComputeMemoCache` with LRU eviction, frees intermediate outputs on zero consumer ref-count, and runs a zero-hash fast path when `memo` is absent.
4. **Production compute-graph takeover and retirement:** Extracts narrow read snapshot port `MemorySnapshotPort` (`src/core/memory/hydration.ts`) plus production graphs `DEFAULT_ENGINE_SEARCH_GRAPH`, `DEFAULT_GET_CONTEXT_GRAPH`, `DEFAULT_NEIGHBORHOOD_GRAPH`, `DEFAULT_PROJECT_GRAPH`, `DEFAULT_USER_PROFILE_GRAPH`, `DEFAULT_REMEMBER_PLAN_GRAPH`, `DEFAULT_LIFECYCLE_PLAN_GRAPH`, `DEFAULT_HTTP_WRITE_PREPROCESS_GRAPH`, and `DEFAULT_HTTP_PROFILE_GRAPH`. Reduces `MemoryEngine` to validation, snapshot lifetime control, and optimistic `mutate`/`commit` coordination, and retires unused `rank-fusion.ts`.
5. **Query-time incremental `BM25+QTF` head promotion and prose-numeric trigram tightening:** Registers `incremental_bm25_score` (`src/core/memory/incremental-bm25.ts`) with dynamic query-time `N` / `avgdl` / `df` IDF recomputation, promotes `HEAD_QTF_R3_SUBGRAPH` (`variant: "bm25_qtf", k1: 1.5, b: 0.75, k3: 8.0, weight: 0.1`) as the default head of `DEFAULT_PIECEWISE_RERANK_GRAPH` (`src/core/memory/piecewise-rerank.ts`, keeping `HEAD_BM25F_R3_SUBGRAPH` exported), and tightens `surfaceAnchors` (`src/core/store/search-ranking.ts`) so bare prose numbers, ordinals, decades, and 12-hour clock tokens do not trigger noisy `surface_fts` trigram matches while preserving CJK runs, paths, dotted versions, error codes, and mixed alphanumeric identifiers.

## Alternatives considered

1. **Keeping `MemoryEngine` monolithic and adding only parallel compute-graph wrappers:** Rejected because maintaining dual production code paths violates single-path correctness and keeps algorithm additions coupled to `engine.ts`.
2. **Adopting an external heavy compiler/IR toolchain (MLIR/LLVM) upfront:** Rejected because local SQLite pushdown and V8 JavaScript execution absorb current optimization needs cleanly with zero external binary overhead.

## Consequences

- New retrieval, reranking, preprocessing, and lifecycle planning operators plug into domain registries without editing `MemoryEngine` or SQLite schemas, verified by `tests/core/compute-architecture-guardrails.test.ts`.
- Unannotated third-party black-box adapters execute safely under conservative `"opaque"` guarantees without corrupting memoization or parallel wave execution.

## Deferred

- Cost-based automatic plan selection across multiple equivalent backend realizations using runtime `costHint` telemetry.
- General SQL lowering for multi-join analytical graphs beyond `relational_query` projection pushdown.
