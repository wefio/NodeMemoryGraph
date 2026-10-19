# UOp op catalogue

[English](uop-catalogue.md) | [简体中文](uop-catalogue.zh-CN.md) · [Terms](uop-catalogue.terms.yaml)

**Authority:** [Parent scope](../learnable-routing-and-differentiable-query-graphs.md).

## Source and scope

This reference describes the internal `Op` keys and evaluator in
[`src/lab/autodiff.ts`](../../../../src/lab/autodiff.ts). A `UOp` node carries an
operation, a two-dimensional `Shape`, source nodes and an optional array or
numeric argument. Scalars use `[1,1]`; buffers are `Float32Array` values.

The catalogue is not a public tool protocol, benchmark result or authorization
to activate a learned controller. The parent owns architecture and admission
policy; the source owns numerical implementation. This document does not make
STG, LTG or the session Active Graph differentiable.

## Operations

The names below are the source keys, including `SoftmaxGradient`,
`L2NormalizeGradient` and `Sqrt`; abbreviated gradient labels are not API names.
The kernels assume a valid constructed graph. This table does not add a general
shape or index validation guarantee.

| Op key | Kernel meaning | Shape |
| --- | --- | --- |
| `Add` | `a[i] + b[i]` | same shape |
| `SumN` | `Σⱼ srcⱼ[i]`, accumulating inputs in one pass | same shape |
| `Multiply` | `a[i] * b[i]` | same shape |
| `Negate` | `-src[i]` | same shape |
| `Broadcast` | fill the target buffer with `src[0]` | target 2-D shape |
| `Matmul` | `left @ right`, using an `ikj` loop order | `[leftRows, rightColumns]` |
| `Transpose` | `result[col*rows+row] = src[row*cols+col]` | `[columns, rows]` |
| `Sum` | sum the complete source buffer | `[rows, columns] → [1,1]` |
| `Exp` | `exp(src[i])` | same shape |
| `Log` | `log(max(src[i], 1e-7))` for finite inputs | same shape |
| `Reciprocal` | `1 / max(src[i], 1e-7)` for finite inputs | same shape |
| `Sqrt` | `sqrt(max(0, src[i]))` | same shape |
| `Sigmoid` | `1 / (1 + exp(-src[i]))` | same shape |
| `Softmax` | `exp(x[i]-max(x)) / Σⱼ exp(x[j]-max(x))` over the whole buffer | same shape |
| `SoftmaxGradient` | `p[i] * (g[i] - Σⱼ p[j]*g[j])` | same shape |
| `L2Normalize` | `src[i] * invNorm`; zero norm uses `invNorm = 0` | same shape |
| `L2NormalizeGradient` | `(g[i] - y[i]*Σⱼ y[j]*g[j]) * invNorm` | same shape |
| `Index` | `src[index]` using a flat buffer offset | `[rows, columns] → [1,1]` |
| `Scatter` | put `src[0]` at a flat offset in an otherwise zero buffer | `[1,1] → [rows, columns]` |
| `Constant` | stored `Float32Array`, constant leaf | declared 2-D shape |
| `Parameter` | stored `Float32Array`, parameter leaf | declared 2-D shape |

## Numerical boundaries

- `Softmax` and `L2Normalize` perform buffer-wide normalization across the
  complete flat buffer, not each row independently. The two-dimensional shape
  does not introduce a normalization axis. `Index` and `Scatter` also use flat offsets, not arbitrary-rank indexing.
- The positive-floor kernel convention in `Log` and `Reciprocal` uses `1e-7`,
  not an absolute-value clamp: a finite negative input is replaced by that positive floor. `Sqrt`
  instead floors at zero.
- For a zero-norm input, `L2Normalize` uses zero inverse norm and returns zeros.
  The matching gradient kernel multiplies by that inverse norm. This is an
  implementation convention, not a proof of an analytic derivative at zero.
- These formulas describe kernels, not numerical-validity guarantees for every
  graph or non-finite input. Source inspection in this documentation pass did
  not execute an autodiff test or benchmark.
