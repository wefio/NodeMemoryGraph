# 模型配置

[English](model-configuration.md) | [简体中文](model-configuration.zh-CN.md) · [术语](model-configuration.terms.yaml) · 上级：[MiniMind-NMG 编码器历史档案](../minimind-embedder.zh-CN.md)

未采用原型的历史配置提案；这些数值不是当前 NMG 模型设置。

## 模型配置

### Phase 1 基线：Dense Small

```
参数量：     ~30M
层数：       6
hidden：     512
heads：      8 (q_heads=8, kv_heads=4, GQA)
head_dim：   64
ffn：        1536 (SwiGLU)
max_length： 2048 tokens（需覆盖 p99+ 的长文本）

编码器输出：  256-dim L2 → 适配层 → 128-dim L2 → HA / MGR / Controller
activation： 1 个标量（节点激活先验，可选）
```

- 适配层 Linear(256→128) 约 33K 参数，TypeScript autodiff 轻量可控
- 比 BGE-small (~118M) 轻 4 倍，比 Qwen3-0.5B (~500M) 轻 16 倍

### Phase 2 对比：MoE

```
参数量：     ~45M total / ~18M active
层数：       6
hidden：     512
experts：    4, top-1 routing
max_length： 2048 tokens

编码器输出：  同 Dense
```

MoE 的价值在于长文本（≥500 tokens）上不同 expert 可能按文本类型/长度分化。
Phase 2 在 Dense 基线稳定后做对比实验：
- 测试数据：benchmark 中长文本子集
- 决策指标：长文本 recall 提升 > 10% 且 batch=1 延迟 < 3ms → 选 MoE
- 风险：routing collapse、ONNX 导出兼容性

### 可选档位

| 档位 | 层数 | hidden | 类型 | 参数量 | 用途 |
|------|------|--------|------|--------|------|
| Tiny | 4 | 384 | Dense | ~15M | 粗召回 / 极低延迟 |
| **Small** | **6** | **512** | **Dense** | **~30M** | **Phase 1 基线** |
| Small-MoE | 6 | 512 | 4 experts | ~45M/18M active | Phase 2 对比 |
| Medium | 8 | 512 | Dense | ~55M | 质量兜底 |

### 完整结构

```
MiniMind-NMG Encoder (Dense 版本)
├── Token Embedding (Qwen vocab, 初始完整, 后续裁剪至 24-32k)
├── 6× Transformer Block
│   ├── RMSNorm (pre-norm)
│   ├── Bidirectional Full Attention (GQA: 8 q_heads / 4 kv_heads)
│   │   ├── Q/K/V projections (no bias, Qwen3 style)
│   │   ├── QK RMSNorm (Qwen3 style)
│   │   ├── RoPE (max 2048)
│   │   └── Flash Attention / manual softmax (ONNX 兼容)
│   ├── Residual
│   ├── RMSNorm (pre-norm)
│   ├── SwiGLU FFN (gate + up + down, no bias)
│   └── Residual
├── Final RMSNorm
├── Masked Mean Pooling (over valid tokens, ignoring padding)
├── Embedding Head: Linear(hidden, 256) → L2Normalize
└── Activation Head (v2): Linear(hidden, 1) → Sigmoid
```
