# 部署：ONNX Runtime Node.js

[English](onnx-deployment.md) | [简体中文](onnx-deployment.zh-CN.md) · [术语](onnx-deployment.terms.yaml) · 上级：[MiniMind-NMG 编码器历史档案](../minimind-embedder.zh-CN.md)

## 部署：ONNX Runtime Node.js

**状态：**已删除的历史原型。下方测量值是归档报告，不是当前运行时保证，也未在本次审计中独立复现。

原型曾通过 `src/core/onnx-minimind-embedder.ts` 提供进程内推理：

```ts
import { OnnxMiniMindEmbedder } from "../src/core/onnx-minimind-embedder.ts";
const e = await OnnxMiniMindEmbedder.create(modelPath, mappingPath);
// Token IDs（由外部 tokenizer 产生）→ L2 向量
const emb = await e.embed(tokenIds, masks);  // Float32Array[batch*dim]
// 加载 ~370ms, 推理 ~7ms/text (batch=5, seq=64, RTX 3060)
```

关键决策：**Tokenizer 与 ONNX 分离**
- Tokenizer 薄层（Python / WASM / 预 tokenize），不跟 ONNX runtime 耦合
- ONNX 进程内 `onnxruntime-node`，Float32Array 零拷贝
- 已验证：Node.js vs Python ONNX 输出 bit-exact 一致 (max diff = 0)

### 导出接口

```python
# PyTorch → ONNX
torch.onnx.export(
    model,
    (input_ids, attention_mask),
    "minimind_nmg_encoder.onnx",
    input_names=["input_ids", "attention_mask"],
    output_names=["embedding", "activation"],
    dynamic_axes={"input_ids": {0: "batch"}}
)
# embedding: [batch, 256] L2-normalized
# activation: [batch, 1]  sigmoid
```

### Node.js 调用

```ts
// ONNX 编码器 → L2 向量
const encoded = tokenizer.encodeBatch(texts);
const outputs = await session.run({
  input_ids: encoded.inputIds,
  attention_mask: encoded.attentionMask
});

// 适配层投影 → 图空间
const graphVector = adapter.project(outputs.embedding);
// Float32Array[128] L2 → 进入 HA / MGR / Controller
```

### DifferentiableAdapter 接口

```ts
class DifferentiableAdapter {
  readonly inputDim: number;   // 256（编码器输出）
  readonly outputDim: number;  // 128（图空间）

  readonly #projection: Tensor;  // [128, 256]
  readonly #bias: Tensor;        // [128]

  project(encoderOutput: Float32Array): Float32Array;
  // → Linear(256→128) → L2 normalize → Float32Array(128)

  // 训练态：构建 UOp 节点，参与 autodiff DAG
  forward(encoderOutput: Float32Array): Tensor;
  // → UOp[128] L2，梯度可回传至 #projection / #bias

  train(batch: AdapterBatch, learningRate?: number): TrainingResult;
  // 与 HA / Controller 同一个 DAG 的 backward

  toJSON(): DifferentiableAdapterState;
  static fromJSON(state: DifferentiableAdapterState): DifferentiableAdapter;
}
```

### 精度与缓存

```
FP16 作为生产默认：
  总模型: ~60 MB（Dense 30M, 每层约 5M 参数 × 2 bytes = 10 MB/层）
  逐层推理：每层权重 10 MB，典型 L3 cache (16-32 MB) 可以常驻
  FP32 → FP16 质量损失通常可忽略，ONNX Runtime 一行转换
```

| 精度 | 总大小 | 每层 | L3 适配 | 说明 |
|------|--------|------|---------|------|
| FP32 | 120 MB | ~20 MB | 勉强 | 可能跨层 evict |
| **FP16** | **60 MB** | **~10 MB** | **舒适** | 生产默认 |
| INT8 动态 | ~35 MB | ~5 MB | 绰绰有余 | 需验证质量 |

### 性能优化顺序

```
双向小 Encoder
→ 固定 max_length (2048)
→ FP16 精度（每层 ~10 MB，L3 cache 常驻）
→ 动态批处理（微批窗口合并）
→ ONNX Runtime Node.js
→ 缓存不变节点向量 ★ 最大优化
```

### 编码器与可微图的缓存边界

```
              ┌─── 缓存在 256 侧 ─────────────────────┐
              │  Float32VectorCache(256-dim, FP16)     │
              │  百万节点 ≈ 512 MB                     │
              │  适配层重训 → 缓存不失效                │
              └────────────┬──────────────────────────┘
                           │ 缓存命中: 直接取
ONNX Encoder (冻结) ───────┴─→ Float32[256] L2 ──→ Adapter (autodiff) ──→ Float32[128] L2
     ↑  缓存未命中: 重新编码         ↑                              ↑
     训练时不变                      训练时参与梯度                   进入 HA/MGR/Controller
```

**为什么缓存 256 而不是 128：** 适配层是 autodiff 可训练参数，重训后 128 维空间变化，
存 256 维编码器输出不随适配层重训失效。每次查询只需 adapter.project() ——
Linear(256→128) → L2，一次 matmul + add + normalize，图侧几乎不可感知。

```ts
// 推理态
const enc256 = cache.get(nodeId) ?? encoder.encode(text);  // 缓存命中 or ONNX
const vec128 = adapter.project(enc256);                     // Float32Array[128] L2
ha.propagate(query128, [{ nodeId, vector: vec128 }], ...);  // 进入图

// 训练态
const query128 = adapter.forward(encoderVec);               // UOp[128] L2, 参与梯度
const loss = ha.propagate(query128, ...).contrastiveLoss;
loss.backward();                                            // 梯度流过 adapter + HA
gradientStep([adapter.#projection, adapter.#bias], lr);     // 只更新适配层
// ONNX 编码器始终不参与梯度
```

### 批处理策略

Agent 单轮常见场景：
```
batch=1:  当前 query (~1-3ms)
batch=4:  query + 3 个候选节点
batch=16: query + 15 个新增节点
```

小 batch 延迟是关键——不要只测 batch=200。
