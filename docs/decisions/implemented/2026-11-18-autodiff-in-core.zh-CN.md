# 将共用的 autodiff 模块放入 Core

[English](2026-11-18-autodiff-in-core.md) · [术语](2026-11-18-autodiff-in-core.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

Core 的层级激活曾从 Lab 导入共用数值模块。这个路径把数值底座放在了实验功能一侧。

## Decision

将实现放入 [Core](../../../src/core/autodiff.ts)，供层级激活和 Lab 功能调用。

## Alternatives considered

放在 Lab 会保留 Core 对 Lab 的依赖。拆成独立包会给同一批调用方增加发布边界。

## Consequences

发布包通过 Core 的目录规则包含 autodiff。各项功能按 [Lite 与 Lab 设计](../../design/design.zh-CN.md)决定启用条件。

Core 提供共用的矩阵向量乘内核。Autodiff 使用两个 Wasm SIMD lane 分别计算两行，各行按标量路径的顺序累加。启用条件和工作区上限见[算子目录](../../design/design/learnable-routing-and-differentiable-query-graphs/uop-catalogue.zh-CN.md)。
