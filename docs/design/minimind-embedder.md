# MiniMind-NMG Encoder — Dedicated Vector Model Design (Historical Archive)

[English](minimind-embedder.md) | [简体中文](minimind-embedder.zh-CN.md) · [Terms](minimind-embedder.terms.yaml)

> **Status: Not adopted; related implementation was removed from the main repository on 2026-07-29.**
>
> This document preserves a design that was seriously explored but did not meet the adoption bar. It proposed training a dedicated bidirectional text encoder of about 30M parameters for NMG and running inference inside the Pi plugin process through ONNX. The prototype showed that the training, export, and invocation pipeline could be assembled; it did not show that the model was a better fit for NMG than existing small embedding models.
>
> Reasons for stopping this direction:
>
> - Preparing data, constructing negatives, multilingual coverage, distillation, evaluation, and deployment formed a separate model project outside the core boundary of NMG as a lightweight long-term-memory plugin for Pi.
> - Available compute, data quality, and model-training capability were insufficient; the experimental results did not reach the level needed to replace mature embedding models such as BGE.
> - A dedicated model added maintenance burden for PyTorch, ONNX, tokenizer mapping, and model files.
> - NMG's main uncertainties were memory writes, graph organization, retrieval, and QPP—not the embedding model itself. More encoder tuning would not test the core value first.
>
> NMG therefore retained the general `VectorEmbedder` boundary and prioritized existing models or compatible APIs. Everything below is a historical design record, not current implementation, roadmap, or validated performance. The referenced `minimind/`, `minimind-nmg/`, ONNX adapter, and test paths were removed; recover their source from Git history only if needed.

## Core judgment and design principles

MiniMind's value to NMG was not that it was already a good embedding model, but that it was:

- small enough for repeated ablation experiments;
- structurally transparent (causal → bidirectional, LM head → embedding heads);
- accompanied by a complete training pipeline (pretraining → SFT → RL);
- based on a small vocabulary, avoiding the embedding-table cost of multilingual models.

Three design principles, inspired respectively by FlashKDA, FlashMLA, and DeepEP:

1. **State updates should have explicit degrees of freedom.** Model each transition from old state to new state explicitly: how much to absorb, retain, and decay.
2. **Storage and computation can be asymmetric.** Persist fewer dimensions than are used for computation: store small, compute large.
3. **Minimal resource use is a core advantage.** Graph-side resource use should remain far below LLM inference so the true bottleneck gets as many resources as possible.

## Three-layer overview

```
┌─ MiniMind-NMG Encoder (ONNX; trained in PyTorch; frozen at deployment) ─┐
│ text → bidirectional Transformer → masked mean pool → L2 → Float32[256] │
│ Deployment: onnxruntime-node (in-process Node.js; no HTTP/IPC)           │
│ Training: offline PyTorch; distilled from Qwen3-0.5B teacher             │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ Float32[256] L2
┌─ DifferentiableAdapter (trainable TypeScript autodiff) ──────────────────┐
│ Linear(256→128) → L2 normalize                                           │
│ ~33K parameters; jointly backpropagated with Controller in one UOp DAG    │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ Float32[128] L2
         ┌─────────────────────┼─────────────────────┐
         ↓                     ↓                     ↓
   HA (Hierarchical    MGR (MemoryGraph      Differentiable
    Activation)          Reasoner)             Controller
   g₁/g₂/g₃ + h₁/h₂/h₃  traverse / whatIf    expand/stop/budget
```

Reason recorded for retaining an adapter:

```ts
// One backward pass updates the adapter and controller together
L_total = L_retrieval + λ * L_contrastive
loss.backward();          // the same UOp DAG
gradientStep(embedderParams, lr_e);
gradientStep(controllerParams, lr_c);
```

## Encoder requirements decided by the graph side

Read the full responsibility in [Encoder requirements](minimind-embedder/encoder-requirements.md).

## Model configuration

Read the full responsibility in [Model configuration](minimind-embedder/model-configuration.md).

## Architecture changes from native MiniMind

### Required changes

```
1. causal mask → bidirectional attention (inspired by dLM)
   Remove the causal mask so each token can attend to the full sequence.

2. LM head → encoder heads
   embedding head:   Linear(hidden, 256) → L2Normalize
   activation head:  Linear(hidden, 1) → Sigmoid

3. max_position_embeddings: 32768 → 2048
   Cover p99+ long text; retain YaRN for training-time extrapolation.

4. CE loss → ranking + distillation losses
   InfoNCE + pairwise ranking + teacher-score MSE
```

### Prefer to retain

```
RMSNorm  — faster than LayerNorm
GQA      — 8 q_heads / 4 kv_heads; faster inference
SwiGLU   — better than a ReLU FFN
Pre-Norm — more stable training
QK Norm  — Qwen3-style; more stable training
no bias  — Qwen3-style; fewer parameters
```

### Pooling

- **Masked mean pooling** (default): average valid tokens and ignore padding.
- Attention pooling (optional experiment): learnable weights.
- Weighted multi-layer mix (optional experiment): for example, a weighted sum of layers 2, 4, and 6.

Last-token pooling was not recommended because a decoder-only model's final token has positional bias.

## Tokenizer strategy

| Phase | Plan | Vocabulary | Rationale |
|---|---|---:|---|
| Phase 1 | Full Qwen tokenizer | ~152k | Fastest way to test distillation |
| Phase 2 | Qwen-compatible pruning | 24k–32k | Prune after measuring token frequency in NMG corpora |

Estimated cost at hidden=512, FP16:

| Vocabulary | Embedding parameters | Approx. memory |
|---:|---:|---:|
| 6,400 (MiniMind) | 3.3M | 6.5 MB |
| 24,000 | 12.3M | 24 MB |
| 32,000 | 16.4M | 32 MB |
| 152,064 (Qwen) | 77.9M | 156 MB |

Tokenizer and model were to deploy separately: ONNX accepts only `input_ids` and `attention_mask`.

## Training strategy

### Three phases, no benchmark leakage

```
Phase 1 — establish a baseline on standard public datasets (no benchmark access)
  AllNLI (SNLI + MultiNLI): ~1M entailment pairs
  MS MARCO:                ~500K query-passage pairs
  DuReader / mMARCO-zh:    ~200K Chinese pairs
  → contrastive learning only: InfoNCE + pairwise ranking loss

Phase 2 — self-supervision from NMG's existing memory store (no benchmark access)
  Read active nodes from SQLite
  Encode with Qwen3-0.5B → similarity matrix → positive pairs (cos > 0.85)
                                      → hard negatives (0.6 < cos < 0.85)
  → hundreds of pairs for ranking distillation of the Phase 1 model

Phase 3 — fine-tune after real usage traces accumulate
  Collect natural retrieval feedback from NMG use
  → fine-tune after several hundred used/unused examples
```

### Teacher: Qwen3-0.5B (Phase 2 only)

The historical note reports Qwen3-0.5B > bge-small. In Phase 2, Qwen3 would compute similarities among existing NMG nodes without seeing benchmarks. The target was not general semantic knowledge, but Qwen's similarity ordering over NMG nodes. This reported comparison is not reproduced evidence in this archive.

### Loss functions

```
Phase 1: L = L_contrastive + β·L_rank
Phase 2: L = L_contrastive + γ·L_teacher
Phase 3: L = L_contrastive + δ·L_behavior

L_contrastive: InfoNCE (used/similar > unused/dissimilar)
L_rank:        pairwise margin ranking
L_teacher:     MSE (student score ≈ Qwen3 score)
L_behavior:    cross-entropy (predict whether a memory is used)
```

### Ablation matrix

| Version | Attention | Layers | Output | Purpose |
|---|---|---:|---:|---|
| A | causal | 8 | 256 | Minimal-change baseline |
| B | bidirectional | 8 | 256 | Test the value of bidirectionality |
| C | bidirectional | 6 | 256 | Test quality after shrinking |
| D | bidirectional | 4 | 128 | Test the lightweight limit |

## ONNX Runtime Node.js deployment

Read the full responsibility in [ONNX Runtime Node.js deployment](minimind-embedder/onnx-deployment.md). The archived prototype's path and measurements are not current runtime guarantees.

## Evaluation metrics proposed

The design proposed measuring more than general Recall@K:

```
Recall@K / MRR / NDCG
Recall of ultimately useful nodes in the Active Graph
Rate of injecting unused nodes
Duplicate retrieval rate
Mean encoding latency (batch=1, 4, 16, 64)
Peak memory
Encoded nodes per second
```

The key proposed measure was the proportion of nodes entering the Active Graph that were ultimately used under a fixed context budget. No result in this archive establishes this metric for a current NMG model.

## MiniMind variant trade-offs

| Variant | Retain | Omit |
|---|---|---|
| **dLM** | Bidirectional attention, mask-corruption training, AR→dLM weight transfer | Multi-step denoising and diffusion generation |
| **Dense mainline** | RMSNorm, RoPE, GQA, SwiGLU, complete training pipeline | Causal mask, LM head, CE loss |
| **V (vision)** | Projector idea: map modalities into one latent space | Vision encoder |
| **O (Omni)** | Shared backbone + multiple heads; intermediate-layer bridge | Speech/vision modules |
| **Linear** | Long-sequence/streaming state (consider Phase 6) | Not for current node encoding |

## Integration with the existing system (proposed)

### Replacement path

```
Existing: OpenAIEmbeddingClient → Qwen3-0.6B (HTTP API)
                         ↓
Transition: OpenAIEmbeddingClient → localhost (MiniMind ONNX-compatible format)
                         ↓
Final: onnxruntime-node → Encoder → Adapter → 128-dim L2 → HA/MGR/Controller
```

### Interface compatibility

```ts
class MiniMindNMGEmbedder implements VectorEmbedder {
  readonly dimensions = 128;  // adapter output = graph-space dimension
  readonly model = "minimind-nmg-v1";

  embed(text: string): readonly number[] {
    const l2_256 = session.run(...);              // ONNX → 256-dim L2
    const l2_128 = adapter.project(l2_256);       // Linear → 128-dim L2
    return l2_128;
  }
}
```

### Joint training

```ts
const encoderVec = session.run(...);              // Float32Array[256] L2; no gradient
const adapterOut = adapter.forward(encoderVec);   // UOp[128] L2; differentiable
const haOutput = ha.propagate(adapterOut, ...);
const loss = controller.computeLoss(haOutput, labels);

loss.backward();  // gradient flows through adapter + HA + controller
gradientStep(adapter.params, lr_a);
gradientStep(ha.params, lr_ha);
gradientStep(controller.params, lr_c);
```

## Explicitly out of scope for the first version

- ❌ Tokenizer pruning (first test the full Qwen tokenizer).
- ❌ Multiple Q/K/V vectors (first validate embedding + activation).
- ❌ Per-node-type projectors (first use one text encoder).
- ❌ Linear Attention (for short sequences, full attention was expected to be faster and simpler).
- ❌ int8 quantization (first validate quality with FP16).
- ❌ MLA-style storage compression (correctness first).

## Planned file layout (historical)

```
minimind-nmg/                       # Python training/export side
  model/
    minimind_encoder.py             # ✅ bidirectional MiniMind Encoder (6L/512h, FlashAttn)
    pooling.py                      # ✅ masked mean / attention pooling
  trainer/
    train_encoder.py                # ✅ main training script (AMP, TF32, pre-tokenize)
    generate_synthetic.py           # ✅ generate pairs from local text
    prepare_data.py                 # ✅ Phase 1 data loader
    data.py                         # NMG traces → training examples
  export/
    export_onnx.py                  # ✅ PyTorch → ONNX (dynamic batch)
  server/
    embed_server.py                 # ✅ lightweight HTTP server (debug only, not production)
  tokenizer/
    prune_qwen_vocab.py             # ✅ generate ID mapping (do not modify tokenizer)
  out/tokenizer/old_to_new.json     # ✅ 151k→32k ID mapping

src/core/onnx-minimind-embedder.ts # ✅ in-process ONNX inference
scripts/test-onnx.ts                # ✅ raw ONNX runtime test
scripts/test-embedder.ts            # ✅ wrapper + Python comparison test
```

The checkmarks and file paths above are the archive's historical project notes; the current checkout contains no MiniMind implementation paths.

## Implementation roadmap (historical)

```
✅ Phase 0 — pipeline validation
  ✅ training script + synthetic data (5,877 pairs, 5 epochs)
  ✅ vocabulary pruning (151k→32k, ID remap)
  ✅ ONNX export + FP16
  ✅ in-process Node.js inference (onnxruntime-node)
  ✅ BEAM benchmark validation (nmg-graph 0.66)

□ Phase 1 — standard-data baseline
  □ load AllNLI + MS MARCO + DuReader (no benchmark exposure)
  □ train max_length=512/2048 (requires larger GPU or cloud)
  □ more epochs + larger batches

□ Phase 2 — self-supervised distillation from NMG memory
  □ encode all active nodes with Qwen3-0.5B → similarity matrix
  □ generate contrastive pairs automatically
  □ teacher MSE + ranking distillation

□ Phase 2b — compare MoE
  □ 4 experts, top-1, ~45M total / ~18M active
  □ compare long-text recall

□ Phase 3 — training loop + joint optimization
  □ multi-task train the activation head
  □ jointly train adapter + HA + Controller

□ Phase 4 — further tokenizer optimization
  □ measure token frequencies in NMG corpora → adjust ID mapping

□ Phase 5 — advanced features (as needed)
  □ multiple Q/K/V vectors, int8 quantization, MLA storage compression
```