# Model Configuration

[English](model-configuration.md) | [简体中文](model-configuration.zh-CN.md) · [Terms](model-configuration.terms.yaml) · Parent: [MiniMind-NMG encoder archive](../minimind-embedder.md)

Historical configuration proposal for an unadopted prototype; these values are not current NMG model settings.

## Phase 1 baseline: Dense Small

```
Parameters:    ~30M
Layers:        6
hidden:        512
heads:         8 (q_heads=8, kv_heads=4, GQA)
head_dim:      64
ffn:           1536 (SwiGLU)
max_length:    2048 tokens (intended to cover p99+ long text)

Encoder output: 256-dim L2 → adapter → 128-dim L2 → HA / MGR / Controller
activation:     one scalar (optional node-activation prior)
```

- The `Linear(256→128)` adapter was estimated at ~33K parameters and intended to remain lightweight and controllable with TypeScript autodiff.
- The proposal estimated this model at about one quarter the size of BGE-small (~118M) and one sixteenth of Qwen3-0.5B (~500M).

## Phase 2 comparison: MoE

```
Parameters:    ~45M total / ~18M active
Layers:        6
hidden:        512
experts:       4, top-1 routing
max_length:    2048 tokens

Encoder output: same as Dense
```

The hypothesis was that experts might specialize by text type or length on long inputs (≥500 tokens). Phase 2 was to follow a stable Dense baseline:

- Test data: long-text subsets of benchmarks.
- Decision target: long-text recall improvement >10% and batch=1 latency <3ms before selecting MoE.
- Risks: routing collapse and ONNX export compatibility.

These are proposal thresholds, not measured outcomes.

## Optional size tiers

| Tier | Layers | hidden | Type | Parameters | Intended use |
|---|---:|---:|---|---:|---|
| Tiny | 4 | 384 | Dense | ~15M | Coarse recall / very low latency |
| **Small** | **6** | **512** | **Dense** | **~30M** | **Phase 1 baseline** |
| Small-MoE | 6 | 512 | 4 experts | ~45M / 18M active | Phase 2 comparison |
| Medium | 8 | 512 | Dense | ~55M | Quality fallback |

## Full proposed structure

```
MiniMind-NMG Encoder (Dense)
├── Token Embedding (Qwen vocabulary; initially full, later prune to 24–32k)
├── 6× Transformer Block
│   ├── RMSNorm (pre-norm)
│   ├── Bidirectional Full Attention (GQA: 8 q_heads / 4 kv_heads)
│   │   ├── Q/K/V projections (no bias, Qwen3 style)
│   │   ├── QK RMSNorm (Qwen3 style)
│   │   ├── RoPE (max 2048)
│   │   └── Flash Attention / manual softmax (ONNX-compatible)
│   ├── Residual
│   ├── RMSNorm (pre-norm)
│   ├── SwiGLU FFN (gate + up + down, no bias)
│   └── Residual
├── Final RMSNorm
├── Masked Mean Pooling (valid tokens only; ignore padding)
├── Embedding Head: Linear(hidden, 256) → L2Normalize
└── Activation Head (v2): Linear(hidden, 1) → Sigmoid
```

All configurations above belong to the archived MiniMind-NMG proposal. For the project decision and removal boundary, see the [parent archive](../minimind-embedder.md).