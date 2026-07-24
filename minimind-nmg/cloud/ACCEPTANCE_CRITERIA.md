# MiniMind-NMG Cloud Training — Acceptance Criteria

## Must Pass (hard gates)

### G1. Training Convergence
- [ ] Epoch 1 loss starts ≥2.5 (near random InfoNCE = log(batch_size))
- [ ] Epoch 5 loss ≤0.30 (vs 0.20 on 5877 synthetic — more data = harder task)
- [ ] Loss monotonically decreasing across all 5 epochs
- [ ] No NaN losses or divergence

### G2. Embedding Quality
- [ ] Cross-language semantic pairs cosine ≥0.55:
  - "Machine learning tutorial" ↔ "机器学习教程" ≥0.55
- [ ] Unrelated cross-domain pairs cosine ≤0.40:
  - "Machine learning" ↔ "Hello world" ≤0.40
- [ ] All output vectors L2-normalized (min=1.0000, max=1.0000 to 4 decimal places)
- [ ] Pairwise cosine spread across batch of 6 diverse texts: max−min ≥0.30 (not collapsed)
- [ ] Code vs natural language cosine <0.20 (distinct domain separation)

### G3. ONNX Export
- [ ] `encoder-cloud.onnx` file exists, size ~142MB
- [ ] ONNX checker passes (no verification errors)
- [ ] Test inference produces (B, 256) output for (B, 256) input

### G4. BEAM Benchmark
- [ ] nmg-graph score ≥0.68 (match or beat the 1800-sample AllNLI model)
- [ ] event_ordering ≥0.50 (was 0.66 on 1800 AllNLI)
- [ ] summarization ≥0.50 (was 0.60 on 1800 AllNLI)
- [ ] No category regressing below 0

## Should Pass (soft targets)

### S1. Cross-Language Transfer
- [ ] LCQMC Chinese question similarity separation: similar pairs ≥0.70, dissimilar ≤0.40
- [ ] English performance not degraded by Chinese data (AllNLI pairs still ≥0.70 for entailment)

### S2. Training Efficiency
- [ ] ≤3.5 hours total training time
- [ ] Peak GPU memory ≤20GB (headroom for RTX 4090 24GB)
- [ ] GPU utilization ≥60% (not bottlenecked by CPU tokenization)

### S3. Edge Cases
- [ ] Short text (2-3 characters) doesn't cause NaN
- [ ] Full-length text (max_length=256) embedding differs from truncated version by cos≤0.10
- [ ] Whitespace-only text produces low activation (activation_head output <0.3)

## Regression Test (after deploying ONNX to Node.js)

- [ ] `node --experimental-strip-types scripts/test-onnx.ts` passes
- [ ] Output matches Python PyTorch model bit-exact (max difference = 0)
- [ ] Inference latency ≤10ms per text (in-process ONNX runtime)

## Baseline Comparison

| Metric | Synthetic 5877 (5ep) | AllNLI 1800 (3ep) | Cloud 500K (5ep) target |
|---|---|---|---|
| Train loss end | 0.25 | 0.84 | ≤0.30 |
| BEAM nmg-graph | 0.66 | 0.68 | ≥0.68 |
| event_ordering | 0.43 | 0.66 | ≥0.50 |
| summarization | 0.20 | 0.60 | ≥0.50 |
| Cross-lang cosine | N/A | N/A | ≥0.55 |
| Collapse check | FAIL (0.999) | PASS (0.84) | MUST PASS |
