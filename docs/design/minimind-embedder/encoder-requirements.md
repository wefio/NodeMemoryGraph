# Encoder Requirements Chosen by the Graph Side

[English](encoder-requirements.md) | [简体中文](encoder-requirements.zh-CN.md) · [Terms](encoder-requirements.terms.yaml) · Parent: [MiniMind-NMG encoder archive](../minimind-embedder.md)

Historical design input. The recorded data distribution and architecture choices are not current implementation requirements or independently reproduced measurements.

## Encoder requirements chosen by the graph side

The encoder output was intended for three consumers, each relying on L2-normalized vectors:

```
Encoder output: Float32[256] L2
         │
         ├─→ HA (HierarchicalActivation)
         │     query·candidate cosine → g₁ cross-attention
         │     7-way blended scoring → nodeScores
         │     ★ cosine similarity is the base signal; encoder quality affects downstream behavior
         │
         ├─→ MGR (MemoryGraphReasoner)
         │     g = σ(v^T @ q + b)    gate depends on v^T @ q
         │     q' = g·v + (1-g)·q   residual mixing
         │     r = q'^T @ v          local relevance
         │     ★ the gate depends on cosine similarity; encoder bias would bias the gate
         │
         └─→ DifferentiableController
               node/edge/control/budget heads
               ★ does not consume encoder output directly; consumes HA nodeScores
```

**Conclusion in the archived design:** the encoder's single core job is to map semantically similar text to nearby L2 directions. Selective attention, multi-scale aggregation, and temporal memory belong on the graph side. A simpler encoder was considered easier to validate, export, and accelerate.

### Final attention choice in the design

| Option | Decision | Rationale recorded at the time |
|---|---|---|
| **Bidirectional full attention** | ✅ selected | Each token can see the full sequence; ONNX-friendly; native Flash Attention support |
| KDA-style state | ❌ | Cross-node state overlaps/conflicts with MGR gate biases and the `h₁` EMA role |
| MLA-style compression | ❌ (Phase 6) | Storage compression was expected to matter mainly beyond one million nodes; correctness first |
| Sparse attention | ❌ | A single-vector encoder output does not need token-level sparse selection |
| Causal attention | ❌ | A generation-model inheritance that prevents earlier tokens seeing later context |

These were design choices for an unadopted prototype, not current encoder requirements.

### Recorded message-length distribution

The archive reports a sample of 5,732 messages from four benchmarks:

```
p50:    359 tokens
p75:    951 tokens
p90:   1180 tokens
p95:   1318 tokens
p99:   1657 tokens

< 500 tokens:  53%
≥ 500 tokens:  47%
≥ 1000 tokens: 21%
```

It grouped inputs into short queries/summaries (50–200 tokens), medium/long evidence or dialogue (200–800), and long documents/traces (1,000–5,000+). The sample files are not linked here, so these figures are retained as historical reported values, not reproduced data.