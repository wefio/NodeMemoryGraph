# Batch Training Loads and Backend-Selection Cost Model (2026-08-10)

[English](backend-selection-cost-model-2026-08-10.md) | [简体中文](backend-selection-cost-model-2026-08-10.zh-CN.md) · [Terms](backend-selection-cost-model-2026-08-10.terms.yaml)

**Status:** Historical CPU experiment. Measurements below are from the dated report and were not reproduced in this documentation pass. The 2026-08-13 implementation correction explicitly says the GPU threshold was only a hypothesis: without a WGSL backend, `pickTier` must choose only executable `compiled-tape` or `interpreter` tiers. Re-check current code before treating any path or threshold as live.

Related: [Autodiff operator optimization](autodiff-operator-optimization-2026-08-10.md), especially its compiler-mode and HPC sections.

## Batch representations and protocol

- **Stacked:** combine B samples into an `[B,D]` matrix and compute `X·W → [B,1]`; arrays grow while the graph stays near eight nodes.
- **Loop:** sum B single-sample subgraphs; the graph grows as `O(B)` (about `6·B` nodes) while arrays remain scalar. The report says the controller used this form, batching only at eight or more samples.

The measurement ran one training step (forward, backward, gradient step), kept parameters persistent across the training loop, and compared interpreter with compiled tape (`NMG_AUTODIFF_COMPILE=1`). The grid was `D ∈ {16,128}` × `B ∈ {1,4,16,64,256,1024}`; `tools/batch-backend-bench.ts` ran seven rounds and reported medians.

## Reported results

### Representation mattered more than backend

| Shape × backend | B=1024, d=16 | B=1024, d=128 |
|---|---:|---:|
| loop interpreter | 8047 µs | 11287 µs |
| loop compiled tape | 3049 µs | 4652 µs |
| stacked interpreter | 397 µs | 2738 µs |
| stacked compiled tape | 316 µs | 2202 µs |

For the same backend, stacked was up to 9.6× faster than loop (`d=16, B=1024`: 397 vs 8047 µs). The report attributed the gap to `O(B)` graph growth and per-sample interpreter overhead in loop form, versus a constant-size graph and matrix multiplication in stacked form. It recommended stacked representation for batch training; this is a result for the measured workload, not a universal threshold.

### Compiled tape in a reusable training loop

| Shape | Compiled/off ratio over the grid |
|---|---|
| stacked | 0.49–0.80 (about 1.25–2× faster) |
| loop | 0.32–0.74 (about 1.35–3× faster) |

The report attributed larger loop gains at high B to removing per-node interpreter overhead. The stated prerequisite was stable structure and persistent parameters; for one-shot graphs, compilation cost `O(V)` may not amortize.

### Double forward in compiled mode

The note observed that reading `loss.scalarValue` runs a forward pass, then `loss.backward()` / `runCompiledBackward` runs another. For loop `d=16, B=1024`, compiled tape took 3236 µs with `scalarValue` versus 1908 µs without it (about 40% extra); interpreter took 7936 versus 7163 µs (about 10%). It proposed a compile-once API that reuses forward results; the reported opportunity was about 1.7× for large arrays and 3–5% for the controller's 49-node case.

### GPU threshold: hypothesis only

The largest measured CPU matrix multiply, `[1024,128]×[128,1]` (about 0.26M FLOPs), took 2202 µs/step in compiled mode. The report hypothesized that GPU might become a candidate around 8M FLOPs, but this threshold was uncalibrated and no WGSL execution backend existed. The implementation correction therefore forbade selecting a non-executable GPU tier. Re-measure only after a real backend exists.

## Historical cost-model contract

The report described a pure decision module in `src/lab/backend-selection.ts`:

```text
pickTier(metrics, context) →
  reusable && expectedRuns ≥ 3  ? "compiled-tape" : "interpreter"
```

It reported that a local `.validate-selection.mjs` check matched the faster compiled tier for 24/24 reusable cells, chose interpreter for one-shot or `expectedRuns < 3`, and never selected a missing GPU tier. These are historical validation results, not a current verification receipt.

## Recorded trigger and follow-up ideas

The report suggested stacked representation from roughly `B ≥ 8`, compiled tape for stable reusable training loops, and interpreter for one-shot work. It listed a compile-once API, automatic `pickTier` integration in place of the global environment switch, and GPU crossover measurement after WGSL support as follow-ups. These recommendations are not current product commitments.