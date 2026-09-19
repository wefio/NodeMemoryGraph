# Predicting whether a recall is worth opening: the normalized-shape feature family

**Status:** plan + first measurement. Steps S1–S6 below are the implementation order.
This document is the home for the shape-feature line; the gate/composition records stay
in `docs/decisions/implemented/2026-09-09-retrieval-relevance-gate.md` and
`gate-certification-2026-09-09.md`.

## 1. The problem, restated

The product symptom is "most injected memories are irrelevant". Deleting candidates is a
bounded remedy: a gate can only remove what a retriever already put in front of it, so its
ceiling is the retriever's pool. Measured on LoCoMo caches: only **15.6%** of questions have
any gold in the lexical pool (**52.8%** with embeddings), and the shipped deterministic
program gate lifts candidate precision from **5.9% to 13.1%** while keeping 81% of
gold-carrying questions. That is a real 2.2x improvement and it is still not enough.

The unbounded question is a different one, and it is a **per-recall decision**: _is this
recall's list worth opening at all?_ Two independent signals point the same way:

- In the certification lattice, the only family that ever certified was the **query-level**
  one (the controller), never an item-level head; the split-rotation sweep then showed the
  item-level compositions rotate with the draw.
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
   the same kind of feature was inverted in-domain (0.42).** Absolute scores are comparable
   _within_ one retriever configuration and not across configurations. Train per
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

## 4. The correction: our feature family is wrong

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
- **Keep:** the product's QPP components and the text-overlap maxima (they are non-lexical
  enough and cheap), the raw dispersion features only as _per-configuration_ features.
- **Drop as portability traps:** any absolute score used across configurations
  (`nn above 0.8`, `nn above 0.7` are scale-bound in the same way).

## 5. Labels and data (existing datasets only, no annotation)

- **Label definition:** a recall is _sufficient_ when at least one judged-sufficent item is in
  the disclosed list. For qrels corpora this is derivable — `label = any(relevant in list)` —
  so an existing dataset supplies the target with **no annotation and no memory benchmark**.
- **Negative kinds are recorded** (in-corpus-unanswerable vs topic-absent), because the
  decision to abstain is the adversarial case and the two behave differently.
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
number of queries; a set whose rate is far off means the retrieval or the label join is wrong.

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

1. No memory-benchmark dataset (LoCoMo, LongMemEval, BEAM, PersonaMem, HaluMem) is used for
   training. They are evaluation surfaces at most.
2. Every number is a mean over ≥5 splits with its spread; single splits are not results.
3. Labels come from existing judgements (qrels) or from in-domain judging — never from
   gold-answer-string containment, which is what made the earlier AUC of 0.894 meaningless
   next to 0.722 on real judgements.
4. The bar for a learned head is a linear model on the same features, and it must beat the
   deterministic rule at matched coverage.
5. Absolute scores are per-configuration; shape features carry the transfer.

## 8. Results so far (S4, S5)

Head trained out of sample (5 folds, logistic on the 11 shape features); "coverage" is the
fraction of queries left open after the threshold. Item precision is the share of injected
items that are actually relevant, sufficient-recall the share of answerable queries whose
list stays open. Baselines are the cheapest deterministic rules on the same scores.

**SciFact** (300 queries, 41.7% sufficient, 126 relevant items, 597 noise items):

| coverage | head              | cv rule       | single feature `top1` |
| -------- | ----------------- | ------------- | --------------------- |
| 50%      | **26.5% / 78.4%** | 20.9% / 67.2% | 24.7% / 69.6%         |
| 70%      | 21.9% / 89.6%     | 19.5% / 85.6% | 21.8% / 86.4%         |
| 90%      | 18.6% / 96.8%     | 17.7% / 94.4% | 18.6% / 96.0%         |

**NFCorpus** (298 queries, 46.0% sufficient, 195 relevant items, 525 noise items):

| coverage | head              | cv rule       | single feature `top1` |
| -------- | ----------------- | ------------- | --------------------- |
| 50%      | **34.4% / 60.6%** | 21.4% / 47.4% | 32.7% / 58.4%         |
| 70%      | 30.4% / 76.6%     | 27.2% / 75.9% | 31.9% / 78.8%         |
| 90%      | 28.0% / 92.7%     | 28.4% / 94.9% | 29.2% / 95.6%         |

Reading:

1. **The gain is concentrated at a tight abstain budget**, and it is real: at 50% coverage the
   head beats the product's own dispersion rule on both axes on both corpora (+5.6pt precision
   and +11.2pt recall on SciFact; +13pt/+13pt on NFCorpus). At 90% coverage it is level with, or
   slightly behind, the deterministic rules — abstaining on a tenth of the queries changes little.
2. **A single raw feature gets most of it at loose coverage.** At 70% and 90% the 10-feature head
   is within noise of `top1`. The head earns its place only when the budget is tight, so the
   decision this table informs is a product parameter, not a modelling choice: _how often may a
   recall come back empty?_
3. **Magnitude**: SciFact precision 17.4% (all queries open) to 26.5% (50% open) is 1.5x, the
   same order as the shipped program gate's 2.2x, and it is a different layer, so the two stack.
4. **Domain caveat**: these are IR document corpora, and the head's quality is
   configuration-dependent (0.562 on NFCorpus against 0.803 on SciFact with identical code), so
   the numbers are a feasibility and magnitude signal for the mechanism, not a product promise.
   A product number needs in-domain labels.

**S5 — the knob.** `coverageThreshold(scores, targetCoverage)` returns the threshold that opens
approximately the requested share of queries. It needs **no labels**: opening a fraction of
queries is a property of the score distribution, so the knob is usable in production from live
logits alone. Labels are needed only to decide which coverage to run at — which is the table
above. Ties open together, so the realised coverage can exceed the target by the size of a tied
run.
