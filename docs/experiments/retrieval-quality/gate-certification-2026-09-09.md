# Gate certification: can the relevance gate promise anything?

[English](gate-certification-2026-09-09.md) | [简体中文](gate-certification-2026-09-09.zh-CN.md) · [Terms](gate-certification-2026-09-09.terms.yaml)

**Date:** 2026-09-09
**Status:** measurement (LoCoMo, lexical/degraded path); provisional.
**Method:** `tools/relevance-model-train.ts --certify` (see "Reproduce" below).
**Prefaced by:** [the selected literature scan](gate-cascade-literature-2026-09-09.md).
This is a historical lexical/degraded-path analysis, not a current deployment
certificate. External papers, raw cached runs and reported defaults were not
reverified here. "Noise" means failure of the benchmark gold-match rule, not an
independently verified negative relevance judgment. Current admissible data,
manifest isolation and deployment-ineligible artifacts belong to the
[training protocol](../../design/relevance-training.md); the legacy LoCoMo
fit/split described here is not a permitted current training recipe.

## What is being certified

Here certification is a statistical-tool outcome, not permission to ship.
Risk needs accepted > 0; all-abstain is not a zero-risk certificate.
Question-disjoint splits are not proof of independent users/conversations or
i.i.d. questions. Exact binomial validity needs the stated sampling assumptions
and valid candidate-family construction. The old text derives cuts on calibration;
today's protocol constructs them on training data. Bonferroni over one lattice
at one alpha does not validate arbitrary adaptive families, repeated test tuning
or all alpha choices at once. Item cluster-bootstrap bounds are approximate,
not the same exact finite-sample theorem as the question binomial test.

The question is not "what is the precision" but **"may this gate ship?"**:

- **Unit:** a question. We _accept_ a question when the gate keeps at least one
  candidate for it; a kept question is an _error_ when **every** kept candidate is
  noise (no gold). A gate that abstains exposes nothing and is not an error.
- **Risk** `R(λ)` = errors / accepted for a threshold pair `λ` = (set-level cut,
  model floor). **α** is the promise: `R ≤ α`.
- **Test.** On a calibration split (n = 307 questions, disjoint from the model's
  training split, and the model's Platt calibration is deliberately _not_ fitted —
  the floor is a free lattice axis), each pair's error count is tested against
  `H: R > α` with the exact one-sided binomial tail, and certified when
  `p ≤ δ / |lattice|` (Bonferroni, δ = 0.05; BalanceRAG's sequential graphical
  testing is a tighter alternative we did not implement).
- **Lattice:** 67 points = one no-gate baseline + (4 cv cuts + 7 QPP cuts) ×
  {model off, floors 0.2/0.35/0.5/0.65/0.8}. The inspected `latticeSpec` builder
  includes that baseline, explaining 67 rather than 66 under these reported axes.
  The old quantile derivation used the split's own scores. The later 109-point
  controller-expanded run is a different lattice (an extra 42 points is consistent
  with seven cuts × six floors); the complete old cut lists were not recovered.
- The chosen pair is the **highest-acceptance certified pair**, then re-evaluated
  on a held-out test split (n = 307). That is an additional held-out check, not a population guarantee or proof of sampling independence.

The set-level score is either raw-scale `cv` (the shipped program gate) or the
product's own QPP score (`composeQpp` = `top1 + 0.5·nqc`, `src/core/qpp.ts`,
rebuilt from the cached bounded hybrid scores).

## The number that bounds everything

Only **48 / 307 (15.6%)** of test questions have gold anywhere in this fixed
pool. A remove-only gate cannot recover absent gold. Accept-all question risk is
84.4% (at least 84%), but this does not impose the same risk on selective gates.
For accepted fraction a and gold-bearing fraction c, an oracle lower bound is
max(0, 1 − c/a) for a > 0. At 10% acceptance with c = 15.6%, zero risk is not
excluded by pool coverage alone. The measured threshold-family frontier is not
a universal best-achievable-risk bound.

## Frontier (chosen on calibration, test uses the same floor)

`q` = question risk, `c` = candidate risk (share of injected items that are
noise), `n` = accepted units, `acc` = acceptance.

| point                    | cal acc / q / c / n          | test acc / q / c / n         |
| ------------------------ | ---------------------------- | ---------------------------- |
| no gate (accept all)     | 100.0% / 83.1% / 94.3% / 307 | 100.0% / 84.4% / 94.7% / 307 |
| cv ≥ 0.0583, model off   | 25.1% / 53.2% / 84.4% / 77   | 26.4% / 63.0% / 87.2% / 81   |
| cv ≥ 0.1414, model off   | 10.4% / 34.4% / 78.1% / 32   | 9.8% / 36.7% / 77.8% / 30    |
| cv ≥ 0.2652, model off   | 2.9% / 11.1% / 70.4% / 9     | 2.0% / 33.3% / 77.8% / 6     |
| cv ≥ 0.1414, model ≥ 0.5 | 3.3% / 10.0% / 10.0% / 10    | 2.3% / 14.3% / 14.3% / 7     |

The model floor buys a large drop in injected noise (78% → 10% at the same cut)
**by accepting 3% of questions instead of 10%**.

## Iso-acceptance frontier (the robust comparison)

Risk at "accept at least L", calibration → test, model-off versus the best point
anywhere in the lattice:

| L (question unit) | model-off   | any point       | chosen point               |
| ----------------- | ----------- | --------------- | -------------------------- |
| 5%                | 34.4 → 36.7 | 12.5 → 35.7     | qpp ≥ 0.3847, model ≥ 0.35 |
| 10%               | 34.4 → 36.7 | **26.3 → 51.4** | qpp ≥ 0.3529, model ≥ 0.2  |
| 15%               | 53.2 → 63.0 | 35.4 → 52.5     | qpp ≥ 0.2826, model ≥ 0.2  |
| 20%               | 53.2 → 63.0 | 53.2 → 63.0     | cv ≥ 0.0583, model off     |
| 30%, 50%          | 75.8 → 83.2 | 75.8 → 83.2     | qpp ≥ 0.3529, model off    |

From 20% acceptance up the model changes nothing; at 10% its apparent calibration
advantage **reverses on test** (36.7% → 51.4%).

## Certification

| α           | verdict                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.10 – 0.50 | **nothing certified**, in either family (cv or qpp)                                                                                                                           |
| 0.60        | cv ≥ 0.0583, model ≥ 0.2: cal 11.7% / q 27.8% / n=36 → **test 8.8% / q 40.7% / n=27**; or qpp ≥ 0.2826, model ≥ 0.2: cal 15.6% / 35.4% / n=48 → **test 13.0% / 52.5% / n=40** |
| 0.70        | cv ≥ 0, model ≥ 0.2: cal 16.0% / 36.7% / n=49 → test 13.0% / 52.5%                                                                                                            |

The item-unit run is reported in its own section below; it is the promise the
original complaint was about, and it behaves differently.

## Item level: the promise the original complaint was about

In this table n counts kept items and acc is item acceptance; earlier n/acc
count questions. `DROPS` means failing the same statistical bound on the new
split, not necessarily observed noise exceeding alpha: at alpha 0.40/0.50 the
14.3%/23.1% point risks remain below target. Source inspection of `boundHolds`
confirms it re-applies the binomial/bootstrap criterion. Finite cluster resampling
cannot rule out unseen errors; all-zero observed clusters resample as all-zero.

"Auto-recall injects mostly noise" is an **item-level** claim (what share of the
injected memories is irrelevant), not the question-level claim above. The two
need different tests, so `--risk item` bounds the _aggregate_ noise share of the
injected items with a **cluster bootstrap over questions** — items inside one
question are correlated, so the exact binomial on items would be optimistic.

Baselines: **94.3% cal / 94.7% test** of injected items are noise with no gate;
**84.4% / 87.2%** at the shipped program cut (`cv ≥ 0.0583`).

| α         | certified pair             | cal: acc / noise / n | test: acc / noise / n | holds     |
| --------- | -------------------------- | -------------------- | --------------------- | --------- |
| 0.10      | cv ≥ 0.2652, model ≥ 0.2   | 0.7% / 0.0% / 6      | 0.3% / **33.3%** / 3  | **DROPS** |
| 0.20–0.30 | qpp ≥ 0.3847, model ≥ 0.35 | 1.7% / 12.5% / 16    | 1.5% / **35.7%** / 14 | **DROPS** |
| 0.40      | cv ≥ 0.1414, model ≥ 0.5   | 1.1% / 10.0% / 10    | 0.8% / 14.3% / 7      | **DROPS** |
| 0.50      | cv ≥ 0.1414, model ≥ 0.35  | 1.5% / 14.3% / 14    | 1.4% / 23.1% / 13     | **DROPS** |
| 0.50      | qpp ≥ 0.3529, model ≥ 0.2  | 4.1% / 26.3% / 38    | 3.8% / **51.4%** / 35 | **DROPS** |
| 0.60–0.70 | cv ≥ 0, model ≥ 0.2        | 5.3% / 36.7% / 49    | 4.3% / 52.5% / 40     | **DROPS** |

Two things follow, and they point in opposite directions:

- **The item-level promise is formulable and certifiable on calibration**, unlike
  the question-level one — a pair certifies at α = 0.10-0.50.
- **Every reported selected pair is labelled DROPS on the held-out bound recheck.**
  The earlier "1.4-2.5×" summary is not uniform: 12.5% → 35.7% is about 2.86×,
  and 0.0% → 33.3% has no finite ratio. Operating points retain only 6-49 items.
  Small samples, resampling limitations and split differences are concerns, not
  an isolated proof that sample size alone caused the result.

**Which knob actually moves item noise?** Not the set-level cut: throwing away 90%
of the candidates (`cv ≥ 0.1414`) still leaves 78.1% noise, because `cv`/QPP are
query-level scores and say nothing about which item inside a kept question is
garbage. The item model is what moves it (94% → 10-24%), and only by keeping 1-2%
of the items. That is why the two knobs are complementary rather than
alternatives, and why an auto-injection policy can be precision-first (inject
nothing most of the time) while explicit search keeps recall.

## The gate controller: does "how far to open" learn anything?

The controller (`--controller-cuts`, printed in the lattice line) is a 12-feature
query-level head whose target is "this pool contains a gold at all"; it decides
**how far the gate opens**, never which candidate to keep, so it holds no delete
permission. Trained on the same train split, certified in the same lattice (109
points now, so the Bonferroni threshold is tighter for every family).

- **It does improve the set-level frontier modestly.** At 15% and 20% acceptance
  the best point is `controller ≥ 0.1663` with the model off: **48.1% → 56.3%**
  question risk, where the best constant cv/QPP cut was 53.2% → 63.0%. So the
  per-query cut is not vacuous: it uses information the single global cut cannot.
- **It does not help the item-level promise at all.** No controller point certifies
  at α ≤ 0.10, and where it does certify (α ≥ 0.20) its test noise is worse than the
  constant cut's (42.9% vs 35.7%).

## Findings

1. The 84.4% no-gold fraction limits fixed-pool coverage, not selective precision
   at every acceptance. The reported ~34% risk at 10% acceptance describes this
   tested family, not all possible gates.
2. Nothing in the reported question-family run certifies below alpha 0.60 with
   307 calibration questions and 67 points. This is a tool result conditional on
   its inputs/assumptions, not proof that a different method cannot certify.
3. The alpha 0.6/0.7 points have calibration risk 27–37% and test risk 41–53%.
   Failed re-certification does not imply those test point risks exceed alpha.
4. At L = 10% the observed calibration advantage reverses on test; at L = 20%
   and up the selected point is model-off. L is a calibration acceptance floor,
   not necessarily equal held-out coverage. AUC 0.89 does not settle the policy.
5. The reported cv/QPP frontiers coincide in this restricted comparison. That
   does not prove identical query ordering, path invariance or universal equality.
6. At the evaluated cv ≥ 0.0583 point, calibration item/question risks are
   84.4%/53.2%, versus 94.3%/83.1% accept-all; test risks are 87.2%/63.0%.
   Keep these units and splits separate. This is not a current-default audit.
7. The item head's reported 94% → 10-24% noise reduction occurs at 1-2% item
   acceptance. It does not establish that only this model can achieve such a point
   or that calibration tool passes are population guarantees.
8. Item-level calibration passes at alpha 0.10-0.50 fail held-out bound rechecks.
   The 6-49 kept-item sample is small; neither the statistical method nor split
   construction is thereby cleared of responsibility.
9. The controller's 48.1% versus 53.2% calibration question-risk points at 20%
   acceptance, with test 56.3% versus 63.0%, are descriptive. Item test noise
   42.9% versus 35.7% is worse in that comparison; no replicated general win is proved.

## What this implies

- Retain the original recommendation **not to enable the model or replace defaults**.
  Its old reason that 41–53% test risk is "worse" than the program point is wrong:
  question-risk 40.7%/52.5% is below 63.0%, while 87.2% is item risk, not a valid
  cross-unit comparison. Acceptance also differs (about 9-13% versus 26.4%).
  Failed held-out bound checks and limited evidence, not that reversed comparison,
  support withholding promotion.
- A calibration pass and HOLDS check are evaluation evidence, not sufficient
  runtime authority. Current data admission, natural validation and reviewed
  activation policy remain separate; this report creates no enablement procedure.
- The five recorded stores (`locomo`, `longmemeval`, `beam`, `halumem`,
  `personamem`) under `.benchmarks/retrieval-stores/` motivated an old multi-store
  proposal. Requiring at least two does not prove a tenfold independent sample
  increase or measured cheapness. Current policy makes memory benchmarks
  evaluation-only; no new training/experiment/spending is authorized.
- A remove-only gate cannot create evidence absent from its fixed input pool.

## What would change the answer

- A higher pool ceiling (restore the embedding path) — the dominant lever.
- More calibration questions, or a multi-store calibration, to give the
  finite-sample test something to bite on.
- A set-level signal with information `cv`/QPP cannot see (semantic agreement
  between the query and the kept set, i.e. an embedding-derived feature).

## Reproduce

This is the preserved legacy command/split description, not a current runnable
recipe. The current trainer requires a manifest and training-derived lattice;
follow the training owner. No command was executed in this review.

```bash
node --experimental-strip-types tools/relevance-model-train.ts --certify \
  [--risk question|item] [--alphas 0.1,0.2,0.6] [--delta 0.05] \
  [--cv-cuts ...] [--qpp-cuts ...] [--controller-cuts ...] \
  [--model-floors ...] [--json]
```

`--risk question` uses the exact binomial on questions (i.i.d. per question);
`--risk item` uses the cluster bootstrap over questions, because items inside a
question are correlated. Every certified pair is re-checked on the test split and
reported as `HOLDS` or `DROPS`.

Inputs: the cached query-grouped LoCoMo store
(`.benchmarks/retrieval-stores/locomo-groups.json`, built without an embedding
service). Splits are by question (every 5th to test, the next 5th to calibration,
the rest to training). The run asserts a non-empty split, a non-zero pool ceiling,
and `errors ≤ accepted`; it refuses to print a number from an empty side.
