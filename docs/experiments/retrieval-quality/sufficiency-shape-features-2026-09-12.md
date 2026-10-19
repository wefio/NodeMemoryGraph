# Predicting whether a recall is worth opening: the normalized-shape feature family

[English](sufficiency-shape-features-2026-09-12.md) | [简体中文](sufficiency-shape-features-2026-09-12.zh-CN.md) · [Terms](sufficiency-shape-features-2026-09-12.terms.yaml)

**Status:** plan + first measurement. Steps S1–S6 below are the implementation order.
This document is the home for the shape-feature line; the gate/composition records stay
in `docs/decisions/implemented/2026-09-09-retrieval-relevance-gate.md` and
`gate-certification-2026-09-09.md`.

## 1. The problem, restated

This is the dated S1–S6 plan and historical measurements including the later
2026-09-15 label audit, not current deployment or permission to run. The
[training protocol](../../design/relevance-training.md) owns data admission;
its current trainer fits candidate relevance, not an automatically deployed
whole-list head. External accounts/raw artifacts were not reverified. All the
qrels-derived results, including early AUC tables, use historical assumed
negatives and do not establish verified live-noise reduction. The reported
15.6% lexical / 52.8% embedding pool figures are cache/slice-specific, not a new
matched causal comparison. Open-one-positive is not complete multi-hop sufficiency.

The product symptom is "most injected memories are irrelevant". Deleting candidates is a
bounded remedy: a gate can only remove what a retriever already put in front of it, so its
ceiling is the retriever's pool. Measured on LoCoMo caches: only **15.6%** of questions have
any gold in the lexical pool (**52.8%** with embeddings), and the shipped deterministic
program gate lifts candidate precision from **5.9% to 13.1%** while keeping 81% of
gold-carrying questions. That is a reported 2.2x proxy ratio, not verified live-quality improvement.

The unbounded question is a different one, and it is a **per-recall decision**: _is this
recall's list worth opening at all?_ Two motivations, not statistically independent evidence sources, were recorded:

- The rotation record motivated query-level selection, but the certification note
  also reports item-level calibration passes. "Only the query family ever
  certified" is not correct across those runs: calibration passes, held-out
  bound rechecks and empirical-risk changes are different outcomes.
- The capture's own labels are **display-level** (`noise` / `partial` / `on_target`), not
  per-candidate, which is the granularity of an open/abstain decision.

The same decision also has a name and a literature: **retrieval sufficiency prediction**, a
branch of query performance prediction (QPP).

## 2. What we already measured (ours)

| Measurement                                                            | Result                                                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| In-domain recall labels, 6 query-level signals, 25 labels              | best signal `top_gap` AUC **0.683**; `max_score` **0.444**, `mean_score` **0.421** (inverted); nothing is established at this n |
| NFCorpus qrels, 298 queries, 46.0% sufficient, normalized shape family | logistic test AUC **0.658** (5 splits: 0.654 / 0.720 / 0.539 / 0.659 / 0.719)                                                   |
| NFCorpus single features                                               | `top1` 0.622, `bimodal_gap` 0.600, `top_gap` 0.547, `gap_concentration` 0.520, rest ~0.50                                       |
| Split variance                                                         | **0.539–0.720 across splits at n=298** — a single split says nothing                                                            |

Two readings that drive the plan:

1. **`top1` (an absolute score) is the strongest single feature on NFCorpus (0.622), while
   the same kind of feature was inverted in-domain (0.42).** Absolute-score use is restricted to a retriever configuration; this alone
   does not calibrate scores across queries or establish cross-configuration transfer. Train per
   configuration; let the shape features carry transfer.
2. **Split variance dominates at these sizes.** Every future number is reported as a mean
   over ≥5 splits with the spread, never as one split. The earlier composition sweeps failed
   exactly because single splits were read as results.

## 3. What the literature says (arXiv 2609.11646, _Your Retriever Already Knows_)

The closest work predicts **retrieval sufficiency** (Hit@k: is at least one sufficient item
in the top k?) from **distribution-shape** features of the retriever's own score list.

**Features** — 24 non-lexical features in three families; a 13-feature lean subset performs
the same, so feature _count_ is not the lever:

- **Distribution (15):** `top1−p99 gap`, `top1−top10 gap`, `top-10 std dev`, `score decay
slope`, `bimodal gap` = mean(top-3) − mean(ranks 10–30), `exp. decay rate`, `99th
percentile`, `nn above 0.8`, `nn above 0.7`, `top-50 skewness`, `top-5 concentration` =
  Σtop5/Σtop100, `max 2nd derivative` (elbow), `nn above τ`, `top-1 margin over τ`,
  **`gap concentration` = (top1−top2)/(top1−top10)**.
- **Query surface (5):** char length, word count, has numbers, punctuation count, average
  word length.
- **Global (4):** corpus mean/median similarity, max similarity, percentile range (p90−p10).

**Labels:** Hit@k, with **two negative kinds** — _in-corpus unanswerable_ (no sufficient
item exists but partial matches do) and _topic-absent/adversarial_ (the topic is missing
entirely). The model detects the adversarial kind best.

**Data:** ~1,032–1,747 labelled queries per domain (1,208 train / 302 test, 80/20, 3-fold CV
for architecture selection, 5 seeds), ~50% positive.

**Model:** logistic regression / ridge / small MLPs (64, 32). Moving from the classical
pooled features to theirs buys only **+0.018 AUROC** (0.875 → 0.893 on its Hit@5 set), so the
model is not the bottleneck.

**Two negative results worth having:** an absolute-score threshold baseline scores AUROC
**0.489** (useless), and a per-query **LLM judge scores 0.649** — worse than the 24-feature
model (0.856) and ~3000x slower. Do not build an LLM judge for this.

**Limitations the authors state:** single retriever, single judge, not validated on live
queries, and cross-domain transfer is weak (leave-one-domain-out AUROC drops to ~0.71).

## 4. Proposed feature-family comparison

Not all listed features are normalized: score differences and standard deviation
retain score units. Ratios need defined zero-denominator, short-list and
negative-score handling; this prose chooses no fallback. Shape transfer is an
empirical question, not automatic invariance.

The controller today reads 12 features, of which the informative core is _raw_ dispersion
(`cv_raw`, `max_bounded`, `mean_bounded`, `mean_raw_log`) plus the product's QPP components
and text overlaps. The literature replaces raw magnitude with **normalized shape**: where the
mass sits, how steeply the list decays, and how the top gap compares with the top-10 range.

Concretely, adopt:

- **Normalized shape (new):** `gap_concentration`, `bimodal_gap`, `top10_std`,
  `decay_slope`, `top5_concentration`, `elbow` (max 2nd derivative over the top-10), and
  `top1 − top10 gap`.
- **Coverage-anchored (new):** `nn above τ` and `top-1 margin over τ`, where τ is calibrated
  for a **target coverage** (the paper uses 90%) rather than by risk. This is also the right
  operating rule for "how often do we open a recall".
- **Query surface (new):** word count, char length, average word length, has-numbers,
  punctuation count. These need the **query text**, which our caches currently do not keep.
- **Keep:** the product's QPP components and the text-overlap maxima (text overlap is lexical and cost/transfer need measurement), the raw dispersion features only as _per-configuration_ features.
- **Drop as portability traps:** any absolute score used across configurations
  (`nn above 0.8`, `nn above 0.7` are scale-bound in the same way).

## 5. Labels and data (existing datasets only, no annotation)

- **Label definition:** a recall is _sufficient_ when at least one judged-sufficent item is in
  the disclosed list. For qrels corpora this is derivable — `label = any(relevant in list)` —
  so known positives provide positive targets without new annotation. With
  positive-only qrels, missing matches remain unknown, not negative supervision.
- **Negative kinds require evidence** (in-corpus-unanswerable versus topic-absent).
  Missing qrels or failed retrieval alone cannot establish either class.
- **Sources:** NFCorpus (323 judged queries) and SciFact (339) are local; both are IR
  corpora, not memory benchmarks. Scale target ~1,000 queries per configuration, which is
  what the literature uses and what makes a split's spread small enough to read.
- **In-domain (89 recall instances / 25 display labels) is used for ADJUSTMENT ONLY** —
  coverage/threshold calibration, never retraining.

## 6. Steps

**S1 — implement the shape family as pure functions.** Add the normalized-shape and
query-surface features next to `CONTROLLER_FEATURE_NAMES`, with unit tests on hand-built
lists (monotone list, flat list, one-elbow list, empty list). No model, no product change.
This is the correction itself, so it goes first.

**S2 — capture the features the runtime will actually have.** Store the query text and the
per-candidate score split (lexical / vector / route) plus `memoryType` in the recall
instance. Today the capture keeps only `combinedScore`, so the intended feature vector cannot
be reproduced at training time; until this lands, any trained head is trained on a different
distribution than it will see live.

**S3 — build the sufficiency sets.** Store the query text in the qrels group cache and derive
`label = any(relevant in list)`; add SciFact. Assert on the positive rate (~50%) and on the
number of queries; deviation from the proposed ~50% is a diagnostic prompt, not proof of a join
bug or permission to force class balance or convert unknowns to negatives.

**S4 — train small and compare honestly.** Logistic regression first (standardized features),
then a small MLP only if the linear model is beaten. Report the **mean over ≥5 splits with
the spread** for: the shape family, the current 12-feature controller, and the deterministic
cv rule. Bar to proceed: beat the deterministic rule at matched coverage.

**S5 — adjust on in-domain, do not retrain.** Pick τ by target coverage on the 25 in-domain
labels; if in-domain says the head is worse than the rule, the head does not ship.

**S6 — ship gate and mechanical guards.** A head may load only if its artifact declares
`domain`, `labelSource`, `unit`, `trainedAt` and the retriever configuration it was trained
for; the loader refuses a mismatch (the same pattern as `acceptsEmbedder`). Adopting the head
requires a decision record and, if a new gate flag appears, a hidden-features registry row.

## 7. Standing rules for this line

These are recorded plan constraints, not a second current policy owner. The
≥5-split/spread requirement remains, but historical tables omit some spreads
and do not thereby demonstrate compliance. Folds share data, not independent
natural tasks. Current label/training policy remains at the linked design.

1. No memory-benchmark dataset (LoCoMo, LongMemEval, BEAM, PersonaMem, HaluMem) is used for
   training. They are evaluation surfaces at most.
2. Every number is a mean over ≥5 splits with its spread; single splits are not results.
3. Labels come from existing judgements (qrels) or from in-domain judging — never from
   gold-answer-string containment, the 0.894 and 0.722 AUCs use different label/corpus settings and do not isolate
   the causal effect of a labeling method. Unjudged qrels remain unknown.
4. The bar for a learned head is a linear model on the same features, and it must beat the
   deterministic rule at matched coverage.
5. Absolute scores are per-configuration; shape-feature transfer must be demonstrated.

## 8. Results so far (S4, S5)

**Label audit (2026-09-15):** the local NFCorpus train/dev/test and SciFact
train/test qrels contain no explicit zero-score judgments. The historical importer
assigned zero to every candidate absent from the positive qrels. Consequently,
the tables below use *assumed* negatives, not independently verified noise labels;
they do not establish live noise reduction. The
[training protocol](../../design/relevance-training.md) retains these candidates
as unknown and refuses supervised fitting without explicit negative judgments.
Rebuilding labeled datasets and cross-corpus evaluation are required before a new
model-quality claim. The protocol's fixture tests exercise data isolation and
reporting, not these benchmark scores.

Head trained out of sample (5 folds, logistic on the 11 shape features); "coverage" is the
fraction of queries left open after the threshold. The displayed precision/recall pairs use the historical proxy judgment rule,
not verified noise or complete answerability. Sufficient-recall counts known
positive-bearing queries whose lists stay open. Baselines are the cheapest deterministic rules on the same scores.

**SciFact historical proxy labels** (300 queries, 41.7% recorded sufficient,
126 judged positives, 597 assumed-negative/unjudged items):

| coverage | head              | cv rule       | single feature `top1` |
| -------- | ----------------- | ------------- | --------------------- |
| 50%      | **26.5% / 78.4%** | 20.9% / 67.2% | 24.7% / 69.6%         |
| 70%      | 21.9% / 89.6%     | 19.5% / 85.6% | 21.8% / 86.4%         |
| 90%      | 18.6% / 96.8%     | 17.7% / 94.4% | 18.6% / 96.0%         |

**NFCorpus historical proxy labels** (298 queries, 46.0% recorded sufficient,
195 judged positives, 525 assumed-negative/unjudged items):

| coverage | head              | cv rule       | single feature `top1` |
| -------- | ----------------- | ------------- | --------------------- |
| 50%      | **34.4% / 60.6%** | 21.4% / 47.4% | 32.7% / 58.4%         |
| 70%      | 30.4% / 76.6%     | 27.2% / 75.9% | 31.9% / 78.8%         |
| 90%      | 28.0% / 92.7%     | 28.4% / 94.9% | 29.2% / 95.6%         |

Reading:

1. At 50% coverage the proxy head exceeds cv on both axes: SciFact +5.6pt
   precision/+11.2pt recall, NFCorpus about +13pt/+13pt. These are numeric proxy
   gaps, not verified live gains or significance tests.
2. At 70%/90%, "within noise" of top1 is not established without uncertainty.
   The intro says 11 shape features while the old reading calls it a 10-feature
   head; the artifact binding remains unresolved.
3. SciFact 17.4% → 26.5% (50% open) is about 1.5x versus a separate 2.2x
   program-gate claim. Different labels/corpora/operating points cannot be
   multiplied or declared stackable without a joint comparison.
4. Reported configuration-dependent 0.562 on NFCorpus and 0.803 on SciFact
   do not reconcile themselves with earlier AUC tables or demonstrate transfer.
   These limited feasibility proxies are not a product promise.

**S5 — the knob.** `coverageThreshold(scores, targetCoverage)` describes an
empirical score quantile, not a risk guarantee. Computing it needs no labels;
choosing useful coverage and claiming quality do. Ties open together, so that
sample's coverage can exceed target by the tied run; future traffic can differ
under drift. This interpretation presumes finite valid scores and a compatible
population; implementation edge handling belongs to its owner. Helper existence
is not production readiness or permission to load/activate a head.
