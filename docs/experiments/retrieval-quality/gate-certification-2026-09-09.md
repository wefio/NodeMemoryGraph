# Gate certification: can the relevance gate promise anything?

**Date:** 2026-09-09
**Status:** measurement (LoCoMo, lexical/degraded path); provisional.
**Method:** `tools/relevance-model-train.ts --certify` (see "Reproduce" below).
**Prefaced by:**
`docs/experiments/retrieval-quality/gate-cascade-literature-2026-09-09.md`, which
found that cutting a cascade's thresholds jointly under a finite-sample risk
bound (BalanceRAG) is the only shape in the literature that turns "should this
gate ship?" into a decision rather than a preference. This note runs exactly that
test on our own data.

## What is being certified

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
- **Lattice:** 67 pairs — 4 cv cuts and 7 QPP cuts (both auto-derived as quantiles
  of the split's own scores; hardcoded cuts keep nothing when the score scale
  moves), × {model off, floors 0.2/0.35/0.5/0.65/0.8}.
- The chosen pair is the **highest-acceptance certified pair**, then re-evaluated
  on a held-out test split (n = 307). The second figure is the honest one.

The set-level score is either raw-scale `cv` (the shipped program gate) or the
product's own QPP score (`composeQpp` = `top1 + 0.5·nqc`, `src/core/qpp.ts`,
rebuilt from the cached bounded hybrid scores).

## The number that bounds everything

Only **48 / 307 (15.6%)** of test questions have a gold **anywhere in the pool**.
No gate can help the other 84.4% except by abstaining, so the question-level risk
of any accept-everything gate is ≥ 84%, and the frontier below is a contest over
how much of that 84% a gate can learn to refuse.

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
- **Every certified pair drops on the held-out split.** The test noise is 1.4-2.5×
  the calibrated value (0.0% → 33.3% at the tightest point), and the operating points
  carry only 6-49 kept items. At this sample size the certificate is measuring noise,
  not the gate.

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

1. **The binding constraint is the pool, not the threshold.** 84.4% of questions
   have no gold to retrieve. The best achievable frontier at 10% acceptance is a
   34% risk; the gate cannot promise more because the evidence it would need was
   never retrieved. This is the retriever claim, now with a certification bound on
   it instead of an argument.
2. **Nothing certifies below α = 0.60.** With 307 calibration questions and 67
   lattice points, Bonferroni demands a near-zero error count, which only points
   with tiny acceptance have. That is the finite-sample discipline working, not a
   bug: a promise needs evidence, and we have ~300 questions.
3. **The two points that do certify at α = 0.6/0.7 do not survive the split**
   (calibration risk 27–37%, test risk 41–53%). Certifying on one split and
   shipping on another is exactly where this dies.
4. **The learned half earns no place.** At iso-acceptance its calibration gain
   reverses on test at L = 10% and is noise elsewhere; from L = 20% up the chosen
   point is model-off. This is consistent with the earlier AUC 0.89 / "cannot move
   recall" result — and it is a stronger statement, because it is stated at a fixed
   acceptance level rather than at a fixed floor.
5. **The product's QPP and the ad-hoc `cv` rank queries the same way here.** Their
   frontiers coincide, so on a single retrieval path the QPP advantage (scale and
   path consistency) is not visible. QPP remains the better _carrier_ of the signal
   — it is productized, has a documented threshold, and is path-consistent — but
   as a first axis it changes nothing on this data.
6. **The shipped program gate's item-level promise is weak.** At `cv ≥ 0.0583` the
   injected set is still 84.4% noise (item level) / 53.2% (question level); the
   accept-everything baseline is 94.3%/83.1%. The gate does reduce injected noise,
   but "most of what we inject is relevant" is **not** achievable at any
   non-trivial acceptance on this data.
7. **The item-level promise is the one that is reachable, and it is reachable only
   through the item model.** Item noise goes 94% → 10-24% via the model floor, but
   only at 1-2% item acceptance; the set-level cut alone cannot get below ~70%
   however tight it is.
8. **Certification succeeds on calibration at the item level (α = 0.10-0.50) and
   fails on the held-out split every time.** The blocker is now sample size at the
   operating point (6-49 kept items), not the method or the threshold: a bound
   needs evidence, and 307 questions do not provide it at these acceptances.
9. **The gate controller is a real but small win at the set level and no win at
   the item level** (48.1% vs 53.2% question risk at 20% acceptance; worse test
   noise than the constant cut wherever it certifies).

## What this implies

- **Do not enable the model gate**, and do not replace the shipped defaults with
  the α = 0.6 certified pair: its test risk (41-53%) is worse than the shipped
  program gate's own measured risk, and its acceptance is 9-13%.
- **The enablement bar is now a procedure, not a number.** Enable a threshold pair
  when `tools/relevance-model-train.ts --certify` certifies it at a target α on a
  calibration split **and it HOLDS on test**. On the current data no pair clears
  α ≤ 0.5 at the question level, and although pairs clear the item level on
  calibration, none holds.
- **What would settle the item-level question is more evidence, not a better
  model.** Five benchmark stores are ingested under `.benchmarks/retrieval-stores/`
  (`locomo`, `longmemeval`, `beam`, `halumem`, `personamem`); certifying per dataset
  and requiring the promise to hold on at least two raises the sample at the
  operating point by an order of magnitude. That is the next run, and it is cheap
  — the whole apparatus now exists.
- **The retriever is still the lever** for every number above; no threshold pair
  can substitute for a pool that lacks the evidence.

## What would change the answer

- A higher pool ceiling (restore the embedding path) — the dominant lever.
- More calibration questions, or a multi-store calibration, to give the
  finite-sample test something to bite on.
- A set-level signal with information `cv`/QPP cannot see (semantic agreement
  between the query and the kept set, i.e. an embedding-derived feature).

## Reproduce

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
