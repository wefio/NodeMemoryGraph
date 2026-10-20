# Retrieval sufficiency and the controller boundary

[English](retrieval-confidence-controller.md) | [简体中文](retrieval-confidence-controller.zh-CN.md)

The deterministic post-retrieval QPP score and same-pool Fibonacci walk are implemented, but expansion is caller-dependent rather than a universal default. The current score is `Top1 + 0.5 × NQC`, with a `0.55` threshold and permanent guardrails. The learned controller remains optional: its runtime defaults to `shadow`, and a rolling-threshold artifact cannot activate itself.

## Scope

QPP estimates whether the selected retrieval set is sufficient to continue; it does not establish answer correctness, predict how many evidence records a question needs, or replace per-record extraction confidence. `MemoryRecord.confidence` is a different property.

This page owns the rationale and evidence boundary. [QPP score, progression, and controller wiring](retrieval-confidence-controller/confidence-and-trigger-design.md) owns implementation details. [Progressive recall](fibonacci-progressive-recall.md) owns the Fibonacci tier and trace contract.

## Current contract

- The core computes QPP from the current selected result set. Its score uses direct-candidate `Top1` and normalized score dispersion (`NQC`); intent coverage, reason health, and expansion diagnostics are recorded but do not currently contribute to the score.
- When a caller enables `secondPass`, retrieval walks cumulative Fibonacci evidence targets by re-selecting from one over-sampled candidate pool. It does not issue another ANN/FTS search. `searchContext` does not enable the pass by default; wrappers and adapters choose their own defaults.
- The default target and threshold are operating points, not universal optima. The value `13` comes from bounded LoCoMo research; it should not be generalized beyond its measured setup.
- Learned allocation, folding, and reranking are separate optional paths. A `shadow` controller cannot actuate. Controlled or active execution is gated by candidate state and the applicable evidence/approval contract; it is not implied by a benchmark or by a switch alone.

The caller defaults and all activation conditions are listed in the [implementation detail](retrieval-confidence-controller/confidence-and-trigger-design.md#caller-specific-activation).

## Why this remains a design area

A 2026-08 LoCoMo signal experiment found normalized dispersion (`NQC`) useful for predicting `complete@20` in that sample (single-feature AUC `0.667`), but near chance for predicting multi-evidence questions (AUC `0.470`). The result supports a bounded sufficiency signal, not evidence-count prediction or a general quality guarantee. See the [experiment](../experiments/qpp/evidence-signal-experiments-2026-08-02.md).

A separate LongMemEval audit reports answer accuracy conditioned on exact-evidence coverage: `89.67%` with all labelled evidence, `16.67%` with partial evidence, and `7.45%` with none. This is an auxiliary, strict audit—not an official benchmark score and not a measurement of QPP trigger lift. See the [OmniMemEval report](../../evals/omnimemeval/README.md).

## Boundaries and non-goals

- The current trigger is deterministic; it does not call an LLM to judge sufficiency. A future model-based judge would be a separate design decision.
- The system predicts retrieval sufficiency, not the number of supporting records. The offline evidence does not justify exposing `single`/`multi` as a product assertion.
- This work does not train an embedding model or make ANN/top-K selection differentiable. The learned controller consumes bounded scalar features and remains behind its own runtime channel.
- Self-RAG and FLARE are not the current mechanism: they depend on generation-side behavior rather than this post-retrieval decision.

For curated implementation history, see [implementation lineage](implementation-lineage.md).