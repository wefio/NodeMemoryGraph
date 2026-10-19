# Autodiff 算子优化：历史设计与测量（2026-08-10）

[English](autodiff-operator-optimization-2026-08-10.md) | [简体中文](autodiff-operator-optimization-2026-08-10.zh-CN.md) · [术语](autodiff-operator-optimization-2026-08-10.terms.yaml)

**状态：**历史优化记录，后续补充了截至 2026-08-28 的测量。本次文档审计没有复现所报耗时与测试数量。本文涉及实验性 autodiff engine 和可选 GPU 工作；不是对 NMG Core 普遍性能或当前 GPU backend 的声明。

## 记录中的主要发现

- **代数化简与 activity analysis：**2026-08-10 报告记载 `l2_normalize_backward_128` 从约 14.8 µs 提升到约 8 µs／step（1.8×）。`controller_train_f32_b32` 与 `matmul_forward` 基本中性。
- **通用逐元素闭包融合：**controller 路径尝试后退化到约 105–113 µs，随后回退。Profile 将 38.8% 归因于闭包读取；该 workload 的数组较小，闭包调用开销大于避免分配的收益。
- **可选 compiled tape：**后续实现记录 `controller_train_f32_b32` 在 `NMG_AUTODIFF_COMPILE=1` 下从约 90–105 µs 降到 44–46 µs（约 2.2×）。`matmul_forward` 中性；`l2_normalize_backward` 回退 interpreter，表现约为中性。报告记载 compile mode 全局启用时 665/665 测试通过，并用 parameter-identity guard 防止跨模型复用梯度缓存。
- **CSE／hash-consing：**暂缓，等待出现足以覆盖 interning 开销的 workload。
- **GPU：**仍是独立可选实验。报告指出小型在线 CPU workload 无法摊销 launch 与数据传输成本；没有采用 GPU 阈值作为可选 tier。
- **SIMD 候选（2026-08-28）：**四列 loop-unroll 实验测得 84.88 与 84.65 µs/op，差异约 0.3%，落在多轮波动范围内，因此未保留。报告建议只有在 profile 确认算术成为瓶颈、且相关矩阵尺寸下有稳定端到端收益时才重启。

## 报告中的设计教训

笔记强调：先 profile 再选择优化，优化测得的瓶颈，而不是看起来最有吸引力的技术。测量中的 controller workload 很小，瓶颈偏向 interpreter／调度，因此通用融合和局部算术调优不会自动带来收益。对重复训练图，复用稳定图结构的 compiled tape 比每步重建并解释图更匹配观察到的负载。

报告中的 compiled mode 使用 forward／backward tape、数据 rebind 和结构 guard，并在不匹配时 fallback。笔记还记录了两种失败方案：每步重新计算字符串结构签名，以及让 data getter 替换由 backward 持有的 session。这些是历史实现经验，不是当前代码的完整规格。

## 证据边界与当前 owner

这些有日期的测量是本地微基准，绑定其图形状、环境与 opt-in mode。它们不能证明其他 workload 的性能、默认启用，或 GPU crossover。原文文献综述与详细接口提案未纳入本精简记录，也没有独立复核。

- Autodiff engine：[`src/lab/autodiff.ts`](../../../src/lab/autodiff.ts)
- Backend 选择探索：[批量 backend 成本模型](backend-selection-cost-model-2026-08-10.zh-CN.md)
- 当前行为与测试：依赖历史结论前，应检查现行 `src/lab/` owner 与目标测试。