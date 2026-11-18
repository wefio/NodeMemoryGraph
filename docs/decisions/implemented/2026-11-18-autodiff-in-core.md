# Put the shared autodiff module in Core

[简体中文](2026-11-18-autodiff-in-core.zh-CN.md) · [Terms](2026-11-18-autodiff-in-core.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

Hierarchical activation in Core imported the shared numerical module from Lab.
That path made a reusable dependency look like an experiment.

## Decision

Put the implementation in [Core](../../../src/core/autodiff.ts), where both
hierarchical activation and Lab features can import it.

## Alternatives considered

Keeping autodiff in Lab would preserve a Core-to-Lab dependency. A separate
package would add a release boundary for the same callers.

## Consequences

The Core source inclusion rule packages autodiff. Feature admission belongs to
each consumer under the [Lite and Lab design](../../design/design.md).

Core owns the shared matrix-vector kernel. Autodiff uses two Wasm SIMD lanes
to compute independent rows and preserve the scalar accumulation order.
The [operator catalogue](../../design/design/learnable-routing-and-differentiable-query-graphs/uop-catalogue.md)
owns its dispatch conditions and workspace limit.
