# Store cluster split: historical implementation record

[English](store-cluster-split.md) | [简体中文](store-cluster-split.zh-CN.md) · [Terms](store-cluster-split.terms.yaml)

Historical implementation record for the 2026-08 store decomposition. Its line counts, method inventories, compiler/test totals, and commit references describe that dated report, not the current repository state.

## Design decision

The recorded change decomposed the large `NmgStore` implementation into typed TypeScript mixins and a base class. The rationale was to keep class-member `this` typing without introducing a `StoreDeps` structural contract and forwarding wrappers. The decomposition also aimed to keep inter-module imports acyclic and to assign each method to one owner cluster.

The earlier attempt and compiler failure are preserved as historical engineering evidence; they are not a claim that every alternative implementation would fail or that the original cluster boundaries remain unchanged.

## Current source boundary

As source-checked on 2026-10-16, [`src/core/store.ts`](https://github.com/wefio/NodeMemoryGraph/blob/3cf3bec2147925f49545775f2ff8aa25e00404f0/src/core/store.ts) composes `withGraph`, `withAnalogy`, `withCommunity`, `withRetrieval`, `withWrites`, and `withMaintenance` over `NmgStoreBase`. This differs from the four-cluster composition and inventories recorded in the 2026-08 note.

[`tests/core/store/cluster-dag.test.ts`](https://github.com/wefio/NodeMemoryGraph/blob/3cf3bec2147925f49545775f2ff8aa25e00404f0/tests/core/store/cluster-dag.test.ts) retains a structural guard for cluster ownership, the mixin assembly, and import boundaries. This is a source/test inspection only; no test was run during this documentation pass.

## Evidence boundary

The original report recorded 480/480 tests, a clean typecheck and lint/format/build checks at that time. Do not present those historical results as a current verification receipt. The current method inventory and behavior live in source and tests; see [implementation lineage](implementation-lineage.md) for the curated history-to-owner map.

## Current source references

- [Store assembly](https://github.com/wefio/NodeMemoryGraph/blob/3cf3bec2147925f49545775f2ff8aa25e00404f0/src/core/store.ts)
- [Base class and shared helpers](https://github.com/wefio/NodeMemoryGraph/blob/3cf3bec2147925f49545775f2ff8aa25e00404f0/src/core/store/base.ts)
- [Graph cluster](https://github.com/wefio/NodeMemoryGraph/blob/3cf3bec2147925f49545775f2ff8aa25e00404f0/src/core/store/graph.ts)
- [Retrieval cluster](https://github.com/wefio/NodeMemoryGraph/blob/3cf3bec2147925f49545775f2ff8aa25e00404f0/src/core/store/retrieval.ts)
- [Write cluster](https://github.com/wefio/NodeMemoryGraph/blob/3cf3bec2147925f49545775f2ff8aa25e00404f0/src/core/store/writes.ts)
- [Maintenance cluster](https://github.com/wefio/NodeMemoryGraph/blob/3cf3bec2147925f49545775f2ff8aa25e00404f0/src/core/store/maintenance.ts)
- [Cluster boundary guard](https://github.com/wefio/NodeMemoryGraph/blob/3cf3bec2147925f49545775f2ff8aa25e00404f0/tests/core/store/cluster-dag.test.ts)