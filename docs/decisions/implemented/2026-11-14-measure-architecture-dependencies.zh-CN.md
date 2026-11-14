# 复用引用提取器测量架构依赖

[English](2026-11-14-measure-architecture-dependencies.md) · [术语](2026-11-14-measure-architecture-dependencies.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [架构方向](2026-11-05-unified-architecture-direction.zh-CN.md)

## Problem

依赖矩阵需要可复现的源码引用定义。既有验证影响探针已提取 TypeScript import 声明和字面量调用，但没有向独立测量开放该提取器。

## Decision

导出已有 `moduleSpecifiers`，供有日期的[架构测量](../../experiments/architecture-dependency-and-memory-2026-11-14.zh-CN.md)使用。调用方补充类型查询并按跨模块路径归组。测量记录范围与限制；提取器原有的影响规划行为和验证门槛不变。

## Alternatives considered

- 在新脚本复制提取器：会产生两个可能漂移的定义。
- 从本次快照直接建立长期依赖禁令：在运行时路径和例外尚未厘清时，把源码计数当成已接受的架构契约。

## Consequences

两个探针共享引用提取行为，该函数的改动可能影响以后的测量。保留的夹具检查声明、字面量动态 import、类型查询，以及源码未提交时的拒绝行为。测量是证据，不是新的边界规则。
