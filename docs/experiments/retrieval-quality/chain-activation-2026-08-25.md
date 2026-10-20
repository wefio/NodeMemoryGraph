# Retrieval-quality activation-gated chain expansion — 2026-08-25

[English](chain-activation-2026-08-25.md) | [简体中文](chain-activation-2026-08-25.zh-CN.md) · [Terms](chain-activation-2026-08-25.terms.yaml)

Evidence boundary (2026-10-17 documentation review): this is a historical
experiment record. The configurations, measurements, implementation descriptions
and follow-up proposals below are scoped to that experiment. This review did not
rerun the experiment or independently revalidate its original artifacts; these
are not current test receipts, default-policy decisions or general guarantees.

Follow-up to
[retrieval-quality-chains-2026-08-24.md](chains-2026-08-24.md).
That run showed whole-chain `expandChains` is a coverage win but the context
cost (159k chars, 27× lexical) is undeployable. This change replaces the
default whole-chain expansion with **activation gating**, so a chain member is
appended only when its activation reaches 0.5:

```
activation = 1/(1 + distance to nearest ranked hit)   (proximity)
           + 1 if the member shares query terms        (relevance)
           + 0.5 × static importance                   (prior)
```

Proximity dominates on purpose: the chain exists to rescue evidence the query
signal missed, so gating on relevance alone would filter out exactly the
members expansion is for (an ordering question's earlier event rarely mentions
the query's anchor). With the default importance 0.5 the gate behaves like a
soft ±3 radius that query-matching or high-importance members escape at any
distance — spreading activation in the spirit of HippoRAG's PPR, and the 1-hop
neighborhood A-MEM retrieves. A hard cap (`chainExpansionMaxMembers`, default:
the ranked-result count) bounds the supplement by the primary evidence budget.
Setting `chainExpansionWindow` explicitly keeps the old window behavior.
Constants are fixed by principle, **not** swept on the benchmark — the goal is
a defensible default, not a leaderboard number.

Raw artifacts: `evals/results/retrieval/2026-08-25T04-04-32-114Z`
(stacked+node+chains, activation-gated; store reused, `+0 generated` — zero
LLM calls). Baselines from the 08-24 runs listed above.

## Results (BEAM, R@20 / any@20 / all@20 / ctx chars)

| arm | R@20 | any@20 | all@20 | legacy evid | ctx chars |
| --- | ---: | ---: | ---: | ---: | ---: |
| stacked+node (no chains) | 27.4% | 65.1% | 26.4% | 29.3% | 51,110 |
| + chains, whole-chain | 27.7% | 80.0% | 39.6% | 46.1% | 159,364 |
| + chains, activation-gated | **28.9%** | 68.9% | 30.2% | 34.6% | **93,915** |

Event_ordering slice (n=40), whole-chain → gated: R@20 17.4% → 15.6% (back to
the no-chain level), any@20 90.0% → 57.5%. The report also lists p50 latency
41ms → 25ms without identifying a matched latency workload or baseline;
that pair is not a controlled speedup measurement.

## Reading

- Relative to no-chains, the gate retains about **25.5% of the any@20 gain**
  (+3.8 / +14.9 points), using about **39.5% of the additional context**
  (42,805 / 108,254 characters). Total context is 93,915 / 159,364 ≈ 58.9%
  of whole-chain context. The earlier "40% of the coverage gain at 40% of
  the context cost" wording conflated these denominators. R@20 is 28.9%
  versus 27.7%; these single-run tables do not establish significance.
- **Event_ordering loses everything the chains gave it.** Its evidence sits
  several positions away from the hit and shares no query terms — exactly the
  members a proximity-decayed gate drops. Coverage there needs either a wider
  reach or a different trigger than per-member activation.
- The natural next trigger is **density escalation** (AutoMerging-style):
  ≥2 ranked hits in the same chain corroborate it, so cover the whole
  hit-spanning segment [minHit−W, maxHit+W] instead of per-member gating.
  Whether ordering questions actually produce ≥2 ranked hits in one chain is
  measurable from the existing per-question ranks before writing any code.
- Context cost is still 16× lexical. The appended-section character budget
  remains the open lever for a hard protocol bound.

## Caveats

- Single dataset (BEAM), single run per arm; ±1 pt differences are not
  accompanied here by an uncertainty estimate or significance test at n=235
  scored questions.
- The gate constants (θ=0.5, importance weight 0.5, cap = ranked count) are
  principled defaults, deliberately not tuned on this benchmark; production
  chains (small, topical, edged) may shift the trade-off versus BEAM's
  63-member session chains.

## Follow-up: density-escalation precondition check (zero-cost, 2026-08-25)

Before building AutoMerging-style density escalation (≥2 ranked hits in one
chain → cover the hit-spanning segment), we checked from the existing reports
whether the trigger would even fire. Gold evidences were mapped back to their
session (= eval chain) and position; a "ranked hit" is a gold at rank ≤ 20.

**BEAM event_ordering (n=39, 5.5 golds/question):**
- Golds are **scattered across sessions**: only 8% of questions have all
  golds in one session; same-session golds span a median of 50 messages.
- The density trigger fires on **10%** of questions (≥2 ranked golds in one
  session). Multi_session_reasoning 25%, summarization 20–25%.
- Gold-hit coverage was incomplete under the report's diagnostic:
  170/216 missed golds sit in sessions with **no ranked gold at all** in this
  diagnostic. That does not exclude a non-gold ranked member as a chain seed.
  The whole-chain report reduced same-session misses to 2, left 145/216 in
  sessions it described as untriggered, and kept all@20 at 2.5%; those counts
  do not establish a universal upper bound for all chain seeds.

**LoCoMo (no chains in store; prospective):** category 2 (temporal) is 91%
single-session with span 2 but only 1.2 golds/question — expansion adds
little. Category 1 (multi-hop, 3.1 golds/question): 5% single-session, 585
missed golds in sessions without ranked golds. These prospective counts
motivate testing cross-session first-hit recall (the summary report recorded
48.6% R@20 without chains); they are not a direct LoCoMo chain-arm evaluation.

**LongMemEval:** golds are whole sessions (avg 12 turns) and matching is
candidate-in-gold — one retrieved member of the gold session already counts.
With within-session chains, adding more members from an already-hit gold
session does not create a new session-level hit under this metric. That
argument does not cover other chain constructions or evidence metrics.

**Interpretation boundary:** this diagnostic counted ranked **gold** hits, not
all ranked chain members. A non-gold member could still seed expansion, so
"no ranked gold" does not prove an untriggered chain or a mechanism-wide
upper bound. The reported 10–25% gold-hit trigger rates motivated prioritizing
session first-hit routing over this density proposal in the sampled workloads;
they do not establish that density escalation is universally ineffective,
that chains only help BEAM, or that a production default is authorized.
Current bounds and caller behavior belong to the
[chain design](../../design/temporal-logical-chains-design-2026-08-13/converged-design.md),
not this dated experiment.
