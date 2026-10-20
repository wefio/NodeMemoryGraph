# Keyword tier calibration: first closed loop and fallback result

[English](recall-tier-calibration-2026-10-16.md) | [简体中文](recall-tier-calibration-2026-10-16.zh-CN.md) · [Terms](recall-tier-calibration-2026-10-16.terms.yaml)

## Question and result

This round computed "metric → distribution → boundaries → within-tier dispersion → adjust and
re-measure"; it did not continue editing host wiring. The result: **lexical scores do form
fairly tight statistical bands, but this round's weak request proxy did not select tiered
retention; keep FIFO and do not promote statistical bands to a runtime rule.** That is the
choice of the first offline experiment, not evidence that all tiers are useless, and it does
not settle demand detection for permanent or time-limited tiers. The current
[session word-pool contract](../../design/design/progressive-retrieval.md#progressive-retrieval)
and the default-off state are unchanged.

## Inputs and unit

A once-growable sample snapshot was reused from `.nmg/verification/recall-tier-calibration/`:

- 1,370 candidate words; not a frozen official vocabulary.
- Of 294 user-role rows, 106 turns satisfied the current static skip and pairable action-proxy
  conditions.
- The first 74 turns in time were training and the last 32 observation; training contains 17
  follow-up-search request proxies.
- Across all 106 turns, 23 have a direct search request or codemode search call syntax and 15
  have a cue candidate.
- A direct request is not success or real need, and call syntax proves execution even less.
  Unknown actions are not merged into negatives.

There were no historical real LLM cues. Replay drew one word uniformly from each eligible
source turn's literal candidates and ran 128 fixed-seed schemes; the decimals below are average
opportunity amounts for those word-selection proxies, not real query counts or recall rates.
Only source turns may enter the pool; a high vocabulary score never enables the whole
vocabulary, and an automatic hit neither extends life nor proves need.

Candidate words and lexical features come from a retrospective snapshot, so their availability
at the historical moment is unproven. The time split is not leak-free forward validation. Host
task anchors and the real pilot lease's birth and death were not reconstructed: replay assumes
the source channel stays available and caps each word's pool age. FIFO-1h is therefore a shadow
control, not a full reproduction of the live shared-expiry parent lease, and it authorizes no
automatic lease renewal.

## Metric and distribution

The two metrics were compared separately first, without inventing mixed weights:

- `mean_token_idf`: arithmetic mean of background-passage IDF over ICU component words after
  de-duplicating the phrase. Single-word IDF is `ln((N+1)/(df+1))+1` with snapshot background
  `N=4654`. It measures lexical distinctiveness, not a probability of need.
- `mean_token_contrast`: the existing component-word memory/background-corpus contrast feature;
  missing values stay unscored rather than becoming zero.

Background documents are not "no memory needed" negatives. That 1,370 words have lexical
features does not mean words without earlier behavioural observation suddenly have a need score.
Both retention directions are compared and "high IDF → keep longer" is not assumed.

Eight descriptive models were compared for positive IDF and five for signed contrast. Continuous
models used MLE; mixtures used multi-start fitting with a fixed variance floor. Positive
mixtures were fit in log space with the Jacobian added back at original scale. A fixed location
is not a free parameter. AIC/BIC were only compared within one response metric, never across
different metrics.

| IDF descriptive model | AIC | BIC | ECDF max distance |
| --- | ---: | ---: | ---: |
| Log-normal | 4442.980 | **4453.425** | 0.03411 |
| Gamma | 4457.654 | 4468.099 | 0.04334 |
| Three-component log-normal mixture | **4426.665** | 4468.445 | **0.01644** |
| Normal | 4570.017 | 4580.462 | 0.06949 |

By BIC, which favours simpler models, the IDF descriptive reference is log-normal; **AIC would
pick the three-component mixture, so the two criteria do not agree.** The signed-contrast BIC
reference is a three-component normal mixture, not force-shifted into a log-normal.

ECDF/Q-Q plots are in the private receipt directory as `closed-loop/ecdf-qq.svg` and `.png`, and
the tails still deviate. Phrases share component words, scores tie and mixtures are regularized;
nominal AIC/BIC is not a deterministic proof on independent samples. No uncalibrated same-sample
KS p-value is reported. Negative-binomial fits counts, so it is not fitted directly to these
continuous IDF scores.

## Boundaries, dispersion and feedback

Boundaries were initialized from the training source turns' weighted ECDF: each source turn
carries total weight 1, shared across its cue candidates. That prevents one long input with 26
candidates from outweighing a short input with one. It is a sampling-unit weight, not a learned
need weight.

Initial cut probabilities were `Φ(-z), 0.5, Φ(z)` over `z=0.5/1/1.5/2`, both retention
directions, the lowest active band and the age cap. Four bands are this round's trial structure,
not a band count BIC derived; tied scores are not split apart.

Resource constraints were stated up front as engineering trial points: new shallow-lookup
opportunities may take at most 25% of the training follow-up-search proxy volume, so the
training cap is `ceil(17×0.25)=5` and the later segment rounds the same per-turn ratio up to 3.
0%, 50% and 100% were also tested. These are neither a monetary nor a total-token optimum and
were not written into a product cross-turn limit. The current constraint comparison only used
the 1-hour age cap; 24 hours is a sensitivity assumption that neither modifies nor extends the
real lease.

The selection objective adds no arbitrary benefit mix: maximize proxy coverage under the hard
query cap, then reduce request-free calls, total calls and complexity in that order. That is
still a weak proxy objective. **The 48 tier combinations within 1 hour tie on the training
metrics, and both metrics and both directions are in the tied set, so no single needed metric
can be identified from them.** The table below picks one fixed representative for the later
variance adjustment and does not call it the single data-derived best policy.

### Sigma really feeds the adjustment

The representative's initial cuts were `3.898966 / 5.094872 / 5.897337`. Source-weighted
`Σ(weight_band × sigma_band²)` was computed and a weighted one-dimensional four-class k-means
proposed tighter boundaries. A boundary change was accepted only if that shape loss fell while
training proxy coverage did not drop and calls plus request-free calls did not rise at the same
budget.

That round accepted `4.059697 / 5.276161 / 6.825952`: source-weighted within-band SSE fell from
**3.466663 to 1.305898, a 62.33% reduction**. What was accepted is a geometric banding
improvement; no real need, temporal stability or online benefit follows from it.

| Observed band | IDF range | Share of this vocabulary | Vocabulary within-band σ | Source-weighted within-band σ | Shadow age cap |
| --- | --- | ---: | ---: | ---: | ---: |
| L0 | `<4.059697` | 9.49% | 0.4026 | 0.3109 | 450s, observe without triggering |
| L1 | `[4.059697,5.276161)` | 36.72% | 0.3270 | 0.3037 | 900s |
| L2 | `[5.276161,6.825952)` | 39.85% | 0.4219 | 0.3619 | 1800s |
| L3 | `≥6.825952` | 13.94% | 0.9281 | 0.3414 | 3600s |

The table is the positive representative; the reverse candidate only reverses retention order.
Word-count shares are not query or cost shares, and whole-vocabulary cross-sectional σ is not
temporal stability. The age ladder `T/8,T/4,T/2,T` is an explicitly revocable initial
assumption, not a lifetime pretended to be estimated from σ. The total pool cap remains 8;
unscored entries follow baseline age, capacity exit falls back to FIFO when scores are
incomparable, and missing is not treated as the lowest score.

## Recalibration and migration control

Session-block resampling was implemented, drawing one candidate uniformly inside each resampled
source turn to address source correlation and unknown cue selection. The 7 training session
blocks were resampled 500 times; **52 had no valid cue source** and were recorded explicitly,
leaving 448 valid. Cut resampling intervals are wide — the first is roughly `[3.5920,8.0917]` —
which does not support precise thresholds or permanent promotion.

The initial trial control rule was:

1. Calibrate only after at least 4 new weak cue sources accumulate; otherwise keep accumulating
   into the next round without resetting the count.
2. Accept a cut move only when the new cut falls outside the previous calibration's bootstrap
   interval; if a partial update reverses cut order, keep the whole previous set.
3. Operational hysteresis takes the larger of "neighbouring-band cross-sectional σ" and "95th
   percentile of the bootstrap cut's absolute error", capped at one quarter of the neighbouring
   cut spacing. Representative values are `0.3041 / 0.3041 / 0.3874`. **That cap does not
   shorten a statistical interval and pass it off as higher confidence.**
4. A word migrates only after crossing the hysteresis band in two consecutive calibration
   rounds, one band at a time; automatic hits do not extend life. "4 new sources, two rounds, a
   quarter spacing" are initial control assumptions, not proven optimal constants.

Prefix replay actually ran 53 → 74 → 106 turns with 10 → 12 → 15 sources. The second round had
only 2 new sources and held; the third accumulated 5 new sources but the new cut still fell
inside the old interval and also held. Candidate cuts were roughly `4.0927/5.3696/6.8883`,
`4.0597/5.2762/6.8260` and `4.0191/5.2161/6.7579`. This is a control replay of changing source
composition, not a real time series of historical word scores; the scores themselves come from
one retrospective snapshot.

A Kaplan–Meier literal-reappearance curve with right censoring at session end was also computed.
The 15-source uniform word-selection scheme averaged only about 2.97 reappearance events. It
describes literal appearance, not need or natural relearning after eviction, and cannot fit a
real promotion/demotion Markov chain. This round added no multivariate Bayesian model or
fabricated state-transition labels merely to fill a tool inventory.

## Same-budget outcome and adoption

On the last 32 turns at the same opportunity budget of 3 with 128 cue-proxy schemes:

| Shadow scheme | Mean query opportunities | Coverage of follow-up proxies | Queries with no follow-up proxy |
| --- | ---: | ---: | ---: |
| FIFO-1h | 1.0000 | 1.0000 | 0 |
| σ-adjusted representative tiers | 0.4766 | 0.4766 | 0 |

Tighter statistical banding actually lost proxy coverage. This replay triggered no capacity
eviction and did not use the query cap, so it showed no pressure that would require tiered
eviction to buy resources; that does not deny tiers' future value under capacity pressure. The
sensitivity check keeping only direct requests and treating pure call-syntax rows as unknown gave
93 turns (65/28) and 8 cue sources; neither scheme covered the later segment and training still
chose FIFO. That further weakens reading the main result as real benefit.

**This round's recommendation: do not drive runtime tiering from these lexical scores; keep the
current simple word pool.** The initial tier candidates, budget and migration rules stay as
shadow parameters: no frozen vocabulary, no claimed single best metric, no permanent tier, and no
direct decision of need level by a candidate distribution. The product gains none of those
budgets, TTL ladders or automatic calibration.

## Reproduction and verification

The complete local receipts, including private inputs, are in
`.nmg/verification/recall-tier-calibration/closed-loop/`: `calibrate.py`, `test_calibrate.py`,
`calibration.json`, `direct-only/calibration.json`, `decision.json` and the plots. Source-data
hashes, script hashes, package versions, random seeds and resampling parameters are all in the
JSON. That directory is not configuration read by the product. No memory statements or user
prompts are published. The private sample is not committed with the documentation; this report
keeps the method, numbers and trade-offs so a private index does not become normative.

From the repository root:

```text
python -X utf8 .nmg/verification/recall-tier-calibration/closed-loop/test_calibrate.py
python -X utf8 .nmg/verification/recall-tier-calibration/closed-loop/calibrate.py --incidence .nmg/verification/recall-tier-calibration/turn-incidence.json --scores .nmg/verification/recall-tier-calibration/token-idf-scores.csv --out-dir .nmg/verification/recall-tier-calibration/closed-loop
```

Adding `--proxy-mode direct` with another output directory redoes the sensitivity check; defaults
are bootstrap=500, 128 selection schemes and seed 1729. The run environment was Python 3.14.7,
NumPy 2.5.2, SciPy 1.18.0 and scikit-learn 1.9.0 with no new dependency installed.

Twelve computation self-checks covered source weights, ties, missing values, hard pool/query
caps, hits not extending life, variance modification and hysteresis. Runtime and data identities
passed, and the relevant Python LSP reported no diagnostics. The original `turn-coverage.py` was
only changed into an importable shared request proxy, and the original default CLI's cohort, 60
opportunity cases and 21 budget comparisons are identical item by item. Python DAP's `debugpy`
adapter was unavailable, so no Python step-through evidence is claimed. This round ran no live
retrieval, LLM/embedding/paid call, product source or configuration change, pilot activation or
shared-service restart.
