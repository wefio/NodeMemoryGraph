# 批量训练负载与后端选择成本模型（2026-08-10）

[English](backend-selection-cost-model-2026-08-10.md) | [简体中文](backend-selection-cost-model-2026-08-10.zh-CN.md) · [术语](backend-selection-cost-model-2026-08-10.terms.yaml)

**状态：**历史 CPU 实验。以下测量来自带日期的报告，本次文档审计未复现。2026-08-13 的实现修正明确指出 GPU 阈值只是猜想：没有 WGSL backend 时，`pickTier` 只能选择可执行的 `compiled-tape` 或 `interpreter` tier。将路径或阈值视为当前状态前，应重新检查源码。

相关：[Autodiff operator optimization](autodiff-operator-optimization-2026-08-10.md)，尤其是编译模式与 HPC 部分。

## 批量表示与 protocol

- **Stacked：**将 B 个样本合成 `[B,D]` 矩阵并计算 `X·W → [B,1]`；数组变大，图保持约 8 个节点。
- **Loop：**累加 B 个单样本子图；图按 `O(B)` 增长（约 `6·B` 个节点），数组保持标量。报告称 controller 使用这种形式，仅在样本数至少为 8 时批量处理。

测量执行一个训练 step（forward、backward、gradient step），在训练循环中保持参数持久，并比较 interpreter 与 compiled tape（`NMG_AUTODIFF_COMPILE=1`）。网格为 `D ∈ {16,128}` × `B ∈ {1,4,16,64,256,1024}`；`tools/batch-backend-bench.ts` 跑 7 轮并报告中位数。

## 报告中的结果

### 表示法的影响大于 backend 选择

| 形态 × backend | B=1024, d=16 | B=1024, d=128 |
|---|---:|---:|
| loop interpreter | 8047 µs | 11287 µs |
| loop compiled tape | 3049 µs | 4652 µs |
| stacked interpreter | 397 µs | 2738 µs |
| stacked compiled tape | 316 µs | 2202 µs |

相同 backend 下，stacked 最多比 loop 快 9.6×（`d=16, B=1024`：397 vs 8047 µs）。报告将差异归因于 loop 形式 `O(B)` 图增长及逐样本解释开销，而 stacked 形式使用恒定规模图与矩阵乘法。报告建议批量训练优先 stacked；这是对测量 workload 的结果，不是普遍阈值。

### 可复用训练循环中的 compiled tape

| 形态 | 网格内 compiled/off 比值 |
|---|---|
| stacked | 0.49–0.80（约快 1.25–2×） |
| loop | 0.32–0.74（约快 1.35–3×） |

报告将高 B 下 loop 的较大收益归因于消除逐节点 interpreter 开销。前提是结构稳定且参数持久；对一次性图，编译成本 `O(V)` 可能无法摊销。

### Compiled mode 中的双重 forward

笔记观察到读取 `loss.scalarValue` 会跑一次 forward，随后 `loss.backward()`／`runCompiledBackward` 再跑一次。对 loop `d=16, B=1024`，compiled tape 有 `scalarValue` 时为 3236 µs，无此读取时为 1908 µs（约多 40%）；interpreter 为 7936 vs 7163 µs（约多 10%）。报告提出可复用 forward 结果的 compile-once API；估算大数组有约 1.7× 空间，controller 的 49-node case 约 3–5%。

### GPU 阈值：仅为假设

最大测得的 CPU 矩阵乘法 `[1024,128]×[128,1]`（约 0.26M FLOPs）在 compiled mode 下为 2202 µs／step。报告假设约 8M FLOPs 后 GPU 可能成为候选，但该阈值未经校准，且当时没有 WGSL execution backend。因此实现修正禁止选择不可执行的 GPU tier。只有真实 backend 存在后才能重新测量。

## 历史成本模型契约

报告描述了 `src/lab/backend-selection.ts` 中的纯决策模块：

```text
pickTier(metrics, context) →
  reusable && expectedRuns ≥ 3  ? "compiled-tape" : "interpreter"
```

报告称本地 `.validate-selection.mjs` 检查在 24/24 可复用单元中都选了更快的 compiled tier；一次性任务或 `expectedRuns < 3` 选择 interpreter；从不选择缺失的 GPU tier。这些是历史验证结果，不是当前验证回执。

## 当时记录的触发条件与后续想法

报告建议约从 `B ≥ 8` 起使用 stacked 表示；稳定、可复用训练循环使用 compiled tape；一次性任务使用 interpreter。后续想法包括 compile-once API、用自动 `pickTier` 替代全局环境变量，以及 WGSL 支持后测量 GPU crossover。这些建议不是当前产品承诺。