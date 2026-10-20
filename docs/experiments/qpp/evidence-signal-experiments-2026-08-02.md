# QPP evidence-signal experiments: top-1 gap, coherence, and LLM sufficiency (2026-08-02)

[English](evidence-signal-experiments-2026-08-02.md) | [简体中文](evidence-signal-experiments-2026-08-02.zh-CN.md) · [Terms](evidence-signal-experiments-2026-08-02.terms.yaml)

> **Status:** Historical research report. The two named result JSON files are absent from this checkout, so the values below are preserved from the report and were not independently reproduced in this documentation pass. The formula and rollout recommendations below describe the experiment's time, not the current runtime; see the [current QPP design](../../design/retrieval-confidence-controller.md).

## Background and protocol boundary

At the time of this experiment, automatic recall's QPP prototype used a then-current formula recorded as `C = Top1 + 0.3·variance + 0.3·intentCoverage + 0.2·reasonHealth`. The current score is different: `Top1 + 0.5 × NQC`; see the [current design](../../design/retrieval-confidence-controller.md#current-contract).

The hypothesis was that a single-evidence question should have a large Top-1 margin, while a multi-evidence question should have greater evidence-to-evidence similarity than evidence-to-noise similarity. The experiments tested these hypotheses using labels for evaluation only.

## Experiment 1: retrieval-signal audit

Protocol: 1,978 evidence-labelled questions from `locomo10.json`; BGE-small record vectors; weighted RRF@20 over raw retrieval, Top-1 reverse lookup, and QPP2 reverse lookup; five folds grouped by session. Labels did not enter retrieval or features.

The feature set combined seven baseline signals, five top-1-distribution signals, and four list-coherence signals.

| Feature | `multi_evidence` AUC | `complete@20` AUC |
| --- | ---: | ---: |
| `top1` (baseline, absolute score) | 0.466 | 0.564 |
| `gap` (baseline, absolute difference) | 0.471 | 0.580 |
| **`nqc`** (normalized dispersion) | 0.470 | **0.667** |
| `t1_over_mean` | 0.458 | 0.664 |
| `qpp2_top1_mass` (baseline) | 0.456 | 0.655 |
| `mass_gap` | 0.464 | 0.611 |
| `t1_margin_rel` | 0.474 | 0.578 |
| `t1_zscore` | 0.469 | 0.573 |
| `list_coherence` | 0.485 | 0.438 |
| `top1_neighbourhood` | 0.477 | 0.455 |
| `top1_iso` | 0.523 | 0.545 |
| `list_query` | 0.482 | 0.474 |
| All-feature logistic fusion | 0.513 | 0.667 |

**Hypothesis A — top-1 dispersion predicts evidence count:** not supported in this sample. The top-1 dispersion features scored 0.46–0.52 AUC for `multi_evidence`, near chance. The same feature family did better for `complete@20`; NQC was its best single feature at 0.667. In this experiment, a strong top-1 distribution signal was more indicative of retrieval completeness than of how many evidence records the question required.

**Hypothesis B — unlabelled list coherence:** the proxy features were weak for both targets (AUC 0.44–0.55). A label-based diagnostic over 110 visible lists containing at least two evidence items found mean evidence-to-evidence similarity `0.808` versus evidence-to-noise similarity `0.761`; the gap was positive in `85.5%` of lists and predicted `complete@20` at AUC `0.657`. This diagnostic requires knowing which items are evidence, so it is not an online feature.

## Experiment 2: LLM sufficiency judgment

Protocol: top-12 retrieval; a balanced sample of 150 questions (75 single-evidence and 75 multi-evidence, at most eight per session); `deepseek-chat` (`deepseek-v4-flash`, temperature `0`) judged whether the retrieved records were sufficient, returning `{sufficient, confidence}`. Labels were evaluation-only.

| Target | Prevalence | Confidence AUC | Binary AUC | Confusion (TP/FP/TN/FN) | Balanced accuracy |
| --- | ---: | ---: | ---: | ---: | ---: |
| `multi_evidence` | 46.7% | 0.508 | 0.463 | 8/15/65/62 | 0.463 |
| `complete@20` | 28.7% | **0.732** | 0.670 | 17/6/101/26 | 0.670 |

- The LLM judgment also failed to predict evidence count (AUC `0.508`), consistent with Experiment 1 and the earlier v1 audit (`0.513`).
- It predicted evidence completeness better than the retrieval-only features in this sample (`0.732` versus NQC `0.667`), but would add a model call.
- Six of 150 judgments said “sufficient” when the evidence was incomplete. The model more often said “insufficient” than “sufficient with missing evidence” (26 false negatives versus 6 false positives).
- Cost recorded by the report: 76,070 prompt and 6,831 completion tokens (about 82K tokens, approximately RMB 0.5 for 150 calls).

## Stage 3: dynamic-recommendation measurements

Protocol: `locomo10.json`, 1,986 questions grouped by session, one record per turn, BGE-small semantic retrieval. The report added `audit-elbow.ts`, per-query score-sequence and gold-hit-position outputs, and an embedding cache. It reported that a rerun took about five minutes; the named generated artifacts are not part of this checkout.

### Observations in this dataset and retrieval setup

- Fixed top-K recall followed an approximate power-law shape (`R²=0.995` for the reported fit), with declining marginal gains and linearly increasing noise. This is a fit to this dataset and setup, not a universal retrieval law.
- Three unsupervised score-distribution approaches did not estimate the needed evidence count reliably here: semantic cosine scores were flat (median top-1/top-2 gap `1.25%`), evidence/noise discrimination was `2.2%`, and an elbow detector chose ranks 1–3 with Spearman correlation about `0.05` against the labelled needed count. Adaptive-K then behaved like a constant K plus a constant buffer.
- The one useful extreme signal was a relative top-1/top-2 gap above `5%`; those queries had median required count near `3`. Absolute Top-1 strength alone did not indicate a low evidence count; even high-Top-1 queries could require up to `7` records.
- The report proposed leaving evidence sufficiency to the consuming Agent, while reducing QPP's automatic role to retrieval guardrails. This is a historical proposal; current caller-specific defaults and the implemented score are documented in the [current design](../../design/retrieval-confidence-controller.md).

### Historical comparison with fixed Top-20

| Metric | Fixed Top-20 | Reported adaptive proposal | Difference |
| --- | ---: | ---: | ---: |
| Records (token proxy) | 20.00 | 14.44 | -27.8% |
| Noise records | 19.51 | 13.94 | -28.6% |
| Evidence coverage | 0.389 | 0.397 | +0.8 pp |

The report says 77% of queries completed in one pass; its `22.9%` append rate is an oracle upper bound, not a live consumer-model rate. The strong-gap group was `5.9%` of queries and used an initial target of three records. These are bounded offline results, not a product-level quality or cost guarantee.

### Historical implementation recommendations

The report recommended a configurable `initialEvidenceTarget`, a strong-hit branch at `topGap ≥ 5%`, a consumer request for further evidence, and `secondPass: true` as the production default. These were recommendations at the time and are not a statement of current defaults. Current core `searchContext`, the convenience wrapper, Pi QPP2, and OmniMemEval use different activation defaults; see [caller-specific activation](../../design/retrieval-confidence-controller/confidence-and-trigger-design.md#caller-specific-activation).

## Conclusions recorded by the experiment

1. **Do not predict evidence count from these signals.** The retrieval-only and LLM signals were near chance for `multi_evidence` in the measured sample. Evidence count is not interchangeable with retrieval completeness.
2. **Completeness prediction is the supported target.** In this report, LLM sufficiency confidence scored 0.732 AUC, NQC 0.667, and `qpp2_top1_mass` 0.655 for `complete@20`. These sample-specific measurements do not establish a live trigger policy.
3. **Label-based coherence is an audit feature, not an online trigger.** It depends on knowing the gold evidence set.
4. **Use relative baselines and preserve configurability.** The reported adaptive proposal was compared with fixed Top-20 on one dataset and used an oracle append upper bound; no universal optimum is established.

The result JSON files named in the original report, `evals/results/locomo-evidence-mode-signal-v2.json` and `evals/results/llm-sufficiency-150.json`, are absent from this checkout. This report preserves their narrative values; it does not substitute for those artifacts or a rerun.