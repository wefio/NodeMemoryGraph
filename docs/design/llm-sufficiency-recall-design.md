# Historical design note: progressive recall and QPP signal repair

[English](llm-sufficiency-recall-design.md) | [简体中文](llm-sufficiency-recall-design.zh-CN.md) · [Terms](llm-sufficiency-recall-design.terms.yaml)

> **Status:** Historical implementation/design note dated 2026-08-02, not the current contract. Its test count, measured values, and “implemented” labels describe that dated rollout and are not current verification. The current owners are [retrieval confidence and controller boundaries](retrieval-confidence-controller.md) and [Fibonacci progressive recall](fibonacci-progressive-recall.md).

## Context at the time

The note followed a trace audit of `nmg_automatic_recall` and `searchContext`. It reported that QPP score `C` stayed near `0.92` because `reasonHealth` was `1.0` and `intentCoverage` was `0.5` on the audited benchmark traces; only one of 3,140 recorded traces triggered. It also reported that one evaluation path began at a fixed limit and immediately stopped, while the Pi extension did not pass `secondPass`.

The accompanying evidence-signal experiment later documented why the score needed to change: NQC dispersion predicted `complete@20` better than the then-used signals in that sample, while the LLM sufficiency judgment was an offline comparator, not a reason to build an NMG-hosted judge. See the [experiment report](../experiments/qpp/evidence-signal-experiments-2026-08-02.md).

## Decisions recorded on 2026-08-02

The note proposed five changes:

1. Start the progressive walk from a configurable `initialEvidenceTarget` rather than treating the initial fixed limit as the answer; use `limit` as a hard ceiling.
2. Remove constant positive contributions from `intentCoverage` and `reasonHealth` and use normalized dispersion (`NQC`) in the QPP score.
3. Preserve the expanded-budget and caller-limit guardrails.
4. Use a relative Top-1/Top-2 gap of at least `0.05` as the measured strong-hit condition for a smaller initial target; absolute Top-1 alone did not predict evidence count in the cited sample.
5. Do not add an NMG-hosted LLM sufficiency judge. The proposal assigned semantic sufficiency judgment to the consuming Agent and described further retrieval as request-driven.

The note also stated that QPP was not intended to predict whether a question needs one or multiple evidence records. That boundary is consistent with the later evidence report, but the exact implementation and defaults have since evolved.

## What the dated note recorded as implemented

It recorded a Fibonacci walk with an initial target of `13`, a strong-hit target of at most `3` when the relative gap reached `0.05`, a hard caller limit, a QPP threshold of `0.55`, and stage details in the retrieval trace. It reported 30 focused tests and a full `502/502` test run, followed by a build. These are historical claims from the 2026-08-02 note, not checks run for this documentation update.

The same note cited the LoCoMo 1,986-question comparison: records `-27.8%`, noise `-28.6%`, and evidence coverage `+0.8` percentage points against fixed Top-20, using an oracle append upper bound. The [experiment record](../experiments/qpp/evidence-signal-experiments-2026-08-02.md) scopes those figures; they do not establish current product quality or a live consumer-model append rate.

## Current behavior boundary

- The current score is `Top1 + 0.5 × NQC`; `intentCoverage`, `reasonHealth`, and other components are diagnostic, not score terms. The current QPP and guardrail definitions are in the [controller design](retrieval-confidence-controller.md).
- `searchContext()` does not enable `secondPass` by default. The convenience wrapper does; Pi QPP2 is default-off; the OmniMemEval bridge defaults it on. Once a caller enables the pass, the core walks eligible Fibonacci tiers and lets QPP stop at sufficient evidence. These are caller-specific contracts, not a universal default.
- The caller's `limit` is a hard ceiling and does not create an arbitrary intermediate Fibonacci rung. The walk re-selects from one over-sampled candidate pool; it does not rerun ANN/FTS or progressively increase relation expansion.
- Learned listwise folding and the deterministic QPP walk are distinct. The 2026-07 local-probe experiment does not prove that its QPP2 model is the current product model.

See the current [caller-specific activation table](retrieval-confidence-controller/confidence-and-trigger-design.md#caller-specific-activation) and [progressive-recall details](fibonacci-progressive-recall.md).

## Historical scope limits

The original note explicitly excluded an NMG-hosted LLM judge and listwise QPP2 compression at that stage. Those were decisions for that design snapshot, not permanent product prohibitions: the current deterministic pass and optional Pi QPP2/controller paths have separate owners and defaults. Do not use the historical “Status: current” or old test receipt as evidence of present behavior.