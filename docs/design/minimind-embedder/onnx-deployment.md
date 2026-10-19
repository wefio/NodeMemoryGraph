# ONNX Runtime Node.js Deployment

[English](onnx-deployment.md) | [简体中文](onnx-deployment.zh-CN.md) · [Terms](onnx-deployment.terms.yaml) · Parent: [MiniMind-NMG encoder archive](../minimind-embedder.md)

Deleted historical prototype. The measurements below are archived reports, not current runtime guarantees or independently reproduced results.

The prototype reportedly provided in-process inference through `src/core/onnx-minimind-embedder.ts`:

```ts
import { OnnxMiniMindEmbedder } from "../src/core/onnx-minimind-embedder.ts";
const e = await OnnxMiniMindEmbedder.create(modelPath, mappingPath);
// Token IDs (produced by an external tokenizer) → L2 vectors
const emb = await e.embed(tokenIds, masks);  // Float32Array[batch*dim]
// Reported: ~370ms load, ~7ms/text (batch=5, seq=64, RTX 3060)
```

Key decision: **separate the tokenizer from ONNX**.

- Keep tokenization as a thin layer (Python / WASM / pre-tokenization), not coupled to ONNX Runtime.
- Run `onnxruntime-node` in-process and pass `Float32Array` without an HTTP/IPC boundary.
- The archive reports bit-exact Node.js/Python ONNX output (maximum difference 0); this result was not reproduced in the current audit.

## Export interface

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
# activation: [batch, 1] sigmoid
```

## Node.js invocation

```ts
// ONNX encoder → L2 vectors
const encoded = tokenizer.encodeBatch(texts);
const outputs = await session.run({
  input_ids: encoded.inputIds,
  attention_mask: encoded.attentionMask
});

// Adapter projection → graph space
const graphVector = adapter.project(outputs.embedding);
// Float32Array[128] L2 → HA / MGR / Controller
```

## DifferentiableAdapter interface (proposed)

```ts
class DifferentiableAdapter {
  readonly inputDim: number;   // 256 (encoder output)
  readonly outputDim: number;  // 128 (graph space)

  readonly #projection: Tensor;  // [128, 256]
  readonly #bias: Tensor;        // [128]

  project(encoderOutput: Float32Array): Float32Array;
  // → Linear(256→128) → L2 normalize → Float32Array(128)

  // Training mode: construct UOp nodes for the autodiff DAG
  forward(encoderOutput: Float32Array): Tensor;
  // → UOp[128] L2; gradients flow to #projection / #bias

  train(batch: AdapterBatch, learningRate?: number): TrainingResult;
  // Backpropagate in the same DAG as HA / Controller

  toJSON(): DifferentiableAdapterState;
  static fromJSON(state: DifferentiableAdapterState): DifferentiableAdapter;
}
```

## Precision and cache estimates (historical)

The proposal selected FP16 as the production default:

```
Total model: ~60 MB (Dense 30M; about 5M parameters/layer × 2 bytes = 10 MB/layer)
Layer-wise inference: each layer's weights ~10 MB; expected to fit in a typical 16–32 MB L3 cache
FP32 → FP16 quality loss was expected to be negligible; ONNX Runtime conversion was proposed
```

| Precision | Total size | Per layer | L3 fit (proposal) | Note |
|---|---:|---:|---|---|
| FP32 | 120 MB | ~20 MB | Marginal | May be evicted across layers |
| **FP16** | **60 MB** | **~10 MB** | **Comfortable** | Proposed production default |
| INT8 dynamic | ~35 MB | ~5 MB | Ample | Quality still needed validation |

## Proposed performance-optimization order

```
Small bidirectional encoder
→ fixed max_length (2048)
→ FP16 precision (~10 MB/layer; target L3 residency)
→ dynamic batching (merge micro-batches in a short window)
→ ONNX Runtime Node.js
→ cache vectors for unchanged nodes ★ largest expected optimization
```

## Cache boundary between encoder and differentiable graph

```
              ┌─── cache on the 256 side ─────────────────┐
              │ Float32VectorCache (256-dim, FP16)        │
              │ one million nodes ≈ 512 MB                 │
              │ adapter retraining → cache remains valid   │
              └────────────┬──────────────────────────────┘
                           │ cache hit: return stored value
ONNX Encoder (frozen) ─────┴─→ Float32[256] L2 ──→ Adapter (autodiff) ──→ Float32[128] L2
     ↑ cache miss: re-encode       ↑                            ↑
       unchanged during training     differentiable                 used by HA/MGR/Controller
```

**Why cache 256 rather than 128:** the adapter is trainable with autodiff, so retraining it changes the 128-dimensional space. The 256-dimensional encoder output would remain valid. A query would only need `adapter.project()`—Linear(256→128) → L2, one matrix multiply, add, and normalize.

```ts
// Inference
const enc256 = cache.get(nodeId) ?? encoder.encode(text);  // cache or ONNX
const vec128 = adapter.project(enc256);                     // Float32Array[128] L2
ha.propagate(query128, [{ nodeId, vector: vec128 }], ...);  // graph input

// Training
const query128 = adapter.forward(encoderVec);               // UOp[128] L2; differentiable
const loss = ha.propagate(query128, ...).contrastiveLoss;
loss.backward();                                            // gradients through adapter + HA
gradientStep([adapter.#projection, adapter.#bias], lr);     // update adapter only
// The ONNX encoder never receives gradients.
```

## Batch strategy proposed

Typical one-turn Agent cases:

```
batch=1:  current query (~1–3ms)
batch=4:  query + 3 candidate nodes
batch=16: query + 15 newly added nodes
```

The proposal prioritized small-batch latency and warned against measuring only batch=200. These are archived design estimates, not current performance data.