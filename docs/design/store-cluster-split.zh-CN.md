# Store cluster 拆分：历史实现记录

[English](store-cluster-split.md) | [简体中文](store-cluster-split.zh-CN.md) · [术语](store-cluster-split.terms.yaml)

2026-08 Store 拆分的历史实现记录。本文中的行数、方法清单、编译／测试总数和 commit 引用描述当时的报告，不代表当前仓库状态。

## 设计决策

记录中的变更将大型 `NmgStore` 实现拆分为有类型的 TypeScript mixins 和基类。其理由是保留 class member 的 `this` 类型，同时避免引入 `StoreDeps` 结构契约和转发包装器。拆分也旨在保持模块间 import 无环，并让每个方法只有一个 owner cluster。

早期尝试及编译失败作为历史工程证据保留；这不表示所有其他实现方式都会失败，也不表示最初的 cluster 边界至今未变。

## 当前源码边界

截至 2026-10-16 的源码检查，[`src/core/store.ts`](../../src/core/store.ts) 在 `NmgStoreBase` 上组合 `withGraph`、`withAnalogy`、`withCommunity`、`withRetrieval`、`withWrites` 和 `withMaintenance`。这与 2026-08 记录中的四 cluster 组合和清单不同。

[`tests/core/store/cluster-dag.test.ts`](../../tests/core/store/cluster-dag.test.ts) 仍保留结构性 guard，用于检查 cluster ownership、mixin 组装和 import 边界。这只是对源码／测试的检查；本次文档审计没有运行该测试。

## 证据边界

原报告记录当时 480/480 测试通过，以及 typecheck、lint／format 和 build 检查通过。不得将这些历史结果作为当前验证回执。当前方法清单与行为以源码和测试为准；参见[实现沿革](implementation-lineage.md)中的精选历史到 owner 映射。

## 当前源码参考

- [Store 组装](../../src/core/store.ts)
- [基类与共享 helpers](../../src/core/store/base.ts)
- [Graph cluster](../../src/core/store/graph.ts)
- [Retrieval cluster](../../src/core/store/retrieval.ts)
- [Write cluster](../../src/core/store/writes.ts)
- [Maintenance cluster](../../src/core/store/maintenance.ts)
- [Cluster 边界 guard](../../tests/core/store/cluster-dag.test.ts)