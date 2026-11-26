# Backend optimization delegation and compute graph lowering

[简体中文](2026-11-26-backend-optimization-delegation-and-lowering.zh-CN.md) · [Terms used](2026-11-26-backend-optimization-delegation-and-lowering.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [unified runtime scheduler, layered capability config, and semantic convergence](2026-11-25-unified-runtime-and-semantic-convergence.md)

## Problem

Although compute graphs routed retrieval, view projection, and write planning through common contracts, execution backends still received fragmented work:

1. **Multi-hop JavaScript assembly over relational data:** `projectGraph`, `userProfile`, lexical `search`, ordered `get` with profile evidence, and HTTP profile candidate loading split relational filtering, node/edge loading, marker parsing, and offset-timestamp visibility checks across sequential JavaScript passes and redundant SQLite queries.
2. **Backend logic lacking declarative separation:** Adding or extending backend pushdowns risked leaking SQLite-specific rules into core planner modules or duplicating relational fallback filters differently across portable and LanceDB backends.
3. **Synchronous per-call Map and timestamp overhead:** Synchronous scoring and fusion graphs (`DEFAULT_PIECEWISE_RERANK_GRAPH`, `DEFAULT_HTTP_SEARCH_GRAPH`) rebuilt `Map` lookups and parsed timestamps repeatedly across chained operators and executed topological loops with per-node object allocations.

## Decision

NMG introduces Calcite-inspired declarative backend delegation and lowering while preserving recursive `ComputeGraphSpec`, unified scheduling, and semantic equivalence:

1. **Declarative backend registry and convex lowering (`src/core/compute-lowering.ts`):** `ComputeBackendRegistry` registers backend adapters (`SQLITE_BACKEND_ADAPTER`, `PORTABLE_BACKEND_ADAPTER`, `JS_V8_BACKEND_ADAPTER`, plus extensible third-party numeric or host adapters) with declared `supportedExprKinds`, `supportedOperations`, `boundaryConversionCostMs`, and deterministic match rules. `isLegalConvexRegion` enforces single-exit dominance, cycle-free convexity, and effect/lock safety before collapsing nodes, and `shouldApplyLowering` gates delegation against `optimization.costRatioThreshold`. Adapter version signatures and lowered region targets participate in `PLAN_CACHE` and `ComputeMemoCache` keys.
2. **Whole-region SQLite pushdowns with strict UTC and fallback parity (`src/core/memory/sqlite-relational.ts`, `src/core/memory/view-compute-graphs.ts`, `src/core/memory/search-compute-graph.ts`, `src/core/memory/engine.ts`):**
   - `projectRelationalMemoriesWithTopology` collapses filtered projection (`sort_time DESC, id ASC`), node hydration, and bounded per-node explicit edge windows (`ROW_NUMBER()`) into one snapshot SQL path, with pagination-consistent fallback in `selectProjectionMemories`.
   - `readRelationalUserProfile`, `readRelationalProfileEvidenceLinks`, `readRelationalLexicalSearchPage`, `readRelationalOrderedGetPage`, and single-query `readProfileCandidates` push profile matching, FTS5/trigram search, caller-order preservation, and evidence semi-joins into SQLite while preserving exact parity with `portable_scan` and `LanceMemoryBackend`.
   - `canonicalUtcInstant` and `utcTimestampColumnSql` normalize offset timestamps such as `+08:00` consistently between SQLite and JavaScript.
3. **JS/V8 synchronous kernels and shared candidate indexing (`src/core/compute-lowering.ts`, `src/core/memory/rerank-types.ts`):** `compileSyncPlanKernel` compiles lock-free synchronous DAGs into fixed-slot closures (`slots[]`) with last-use reference clearing, `compileFusedChainSyncRunner` pre-binds linear `fused_chain` operators without runtime `Map` lookups, and `RerankCandidateIndex` caches per-batch timestamps and ID tables behind a `WeakMap`.
4. **`L0 -> L1 -> L2` `optimization` policy configuration (`src/core/capability-config.ts`, `src/integration/runtime-config.ts`):** Exposes `optimization.backend`, `optimization.enableRegionLowering`, `optimization.enableLinearFusion`, `optimization.enableSyncKernel`, and `optimization.costRatioThreshold` (plus `NMG_OPTIMIZATION_BACKEND`) as physical execution policies excluded from `resultIdentityHash`.

## Alternatives considered

1. **Dynamic `new Function` JIT string generation for sync graphs:** Rejected because sandboxed edge/Worker hosts restrict runtime `eval`/`Function` code generation and empirical microbenchmarks showed slot-indexed pre-bound closures deliver comparable or lower compilation overhead without CSP failures.
2. **Embedding external optimizer engines (Apache Calcite JVM, DuckDB, or LLVM/MLIR):** Rejected because NMG runs inside single-process Node and Cloudflare/EdgeOne WASM Worker boundaries where deterministic pattern rules over existing relational SQLite and V8 closures avoid JVM/native toolchain footprint and IPC latency.
3. **Splitting compute graphs into separate SQLite vs portable graph specifications:** Rejected because logical graphs (`ComputeGraphSpec`) stay single-source while lowering rewrites eligible regions transparently with verified portable fallbacks.

## Consequences

- `projectGraph` at `N = 2500` executes in `4.223 ms` p50 (`scannedEntities: 0`) via SQLite pushdown versus `49.932 ms` (`scannedEntities: 2640`) via portable scan while keeping byte-identical canonical SHA-256 outputs ([experiment report](../../experiments/runtime/backend-optimization-delegation-2026-11-26.md)).
- Small single-filter scans (such as selective user profile subsets or 5-ID `get` lookups) remain cheap in both paths (`userProfile` at `N = 2500`: `4.002 ms` SQLite vs `1.979 ms` portable scan), validating cost-ratio gating for selective pushdowns.
- WASM SQLite builds and tests in `onlion` (`test:backend`, `test:add-log`, `test:edgeone-package`, `test:append-log`, `test:page-delta`) compile and execute cleanly without dynamic codegen or Node-only SQL syntax.
