# UOp 算子目录

[English](uop-catalogue.md) | [简体中文](uop-catalogue.zh-CN.md) · [术语](uop-catalogue.terms.yaml)

**Authority:** [父级范围（英文）](../learnable-routing-and-differentiable-query-graphs.md)。

## 来源与范围

本参考描述 [`src/lab/autodiff.ts`](../../../../src/lab/autodiff.ts) 中内部 `Op` key 与 evaluator。
`UOp` 节点携带 operation、二维 `Shape`、来源节点，以及可选的数组或数值参数。
标量使用 `[1,1]`；缓冲区值为 `Float32Array`。

本目录不是公开工具协议、benchmark 结果，也不授权启用学习型 controller。
架构与准入策略由父级拥有，数值实现由源码拥有。本文不使 STG、LTG 或会话 Active Graph
变成可微结构。

## 算子

下表使用源码 key，包括 `SoftmaxGradient`、`L2NormalizeGradient` 与 `Sqrt`；
缩写的 gradient 标签不是 API 名。内核假设图已被有效构造，本表不新增一般性的 shape
或索引校验保证。

| Op key | 内核含义 | Shape |
| --- | --- | --- |
| `Add` | `a[i] + b[i]` | 相同 shape |
| `SumN` | `Σⱼ srcⱼ[i]`, 一次遍历累加各输入 | 相同 shape |
| `Multiply` | `a[i] * b[i]` | 相同 shape |
| `Negate` | `-src[i]` | 相同 shape |
| `Broadcast` | 用以下值填充目标缓冲区： `src[0]` | 目标二维 shape |
| `Matmul` | `left @ right`, 采用 `ikj` 循环顺序 | `[leftRows, rightColumns]` |
| `Transpose` | `result[col*rows+row] = src[row*cols+col]` | `[columns, rows]` |
| `Sum` | 对整个来源缓冲区求和 | `[rows, columns] → [1,1]` |
| `Exp` | `exp(src[i])` | 相同 shape |
| `Log` | `log(max(src[i], 1e-7))` 对有限输入 | 相同 shape |
| `Reciprocal` | `1 / max(src[i], 1e-7)` 对有限输入 | 相同 shape |
| `Sqrt` | `sqrt(max(0, src[i]))` | 相同 shape |
| `Sigmoid` | `1 / (1 + exp(-src[i]))` | 相同 shape |
| `Softmax` | `exp(x[i]-max(x)) / Σⱼ exp(x[j]-max(x))` 作用于整个缓冲区 | 相同 shape |
| `SoftmaxGradient` | `p[i] * (g[i] - Σⱼ p[j]*g[j])` | 相同 shape |
| `L2Normalize` | `src[i] * invNorm`; 零范数时采用 `invNorm = 0` | 相同 shape |
| `L2NormalizeGradient` | `(g[i] - y[i]*Σⱼ y[j]*g[j]) * invNorm` | 相同 shape |
| `Index` | `src[index]` 使用展平缓冲区偏移 | `[rows, columns] → [1,1]` |
| `Scatter` | 把 `src[0]` 写到展平偏移，其余缓冲区元素为零 | `[1,1] → [rows, columns]` |
| `Constant` | 存储的 `Float32Array`，常量叶节点 | 声明的二维 shape |
| `Parameter` | 存储的 `Float32Array`，参数叶节点 | 声明的二维 shape |

## 数值边界

- `Softmax` 与 `L2Normalize` 执行全缓冲区归一化，聚合整个展平缓冲区，不是逐行独立计算。
  二维 shape 不额外引入归一化轴。`Index` 与 `Scatter` 也使用展平偏移，不是任意维索引。
- `Log` 与 `Reciprocal` 的正下限数值内核约定使用 `1e-7`，不是对绝对值截断：有限负输入会被替换为
  该正下限。`Sqrt` 则以下限零处理。
- 输入范数为零时，`L2Normalize` 使用零逆范数并返回零向量；配套 gradient 内核乘以
  该逆范数。这是实现约定，不是在零点存在解析导数的证明。
- 这些公式描述内核，不保证任意图或非有限输入的数值有效性。本轮文档工作只读源码，
  未执行 autodiff 测试或 benchmark。
