# Retrieval-quality activation-gated chain expansion — 2026-08-25

Follow-up to
[retrieval-quality-chains-2026-08-24.md](retrieval-quality-chains-2026-08-24.md).
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
the no-chain level), any@20 90.0% → 57.5%. p50 latency 41ms → 25ms.

## Reading

- The gate keeps roughly **40% of the coverage gain at 40% of the context
  cost** (any@20: +14.9 → +3.8 pts over no-chains; ctx: 3.1× → 1.8× of
  stacked+node). R@20 is unmoved or slightly better (28.9% vs 27.7% — ~10
  golds, noise-level), confirming chain expansion was never a ranking lever.
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
  significant at n=235 scored questions.
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
- The dominant miss pool is unreachable by any within-chain mechanism:
  170/216 missed golds sit in sessions with **no ranked gold at all** — the
  chain is never triggered there, at any window size. (Whole-chain expansion
  confirms the ceiling: it reduced same-session misses to 2 but left 145/216
  in untriggered sessions, and all@20 stayed 2.5%.)

**LoCoMo (no chains in store; prospective):** category 2 (temporal) is 91%
single-session with span 2 but only 1.2 golds/question — expansion adds
little. Category 1 (multi-hop, 3.1 golds/question): 5% single-session, 585
missed golds in unranked sessions. Chains would not move LoCoMo either; its
headroom is cross-session first-hit recall (which the summary tiers already
address: 48.6% R@20 without chains).

**LongMemEval:** golds are whole sessions (avg 12 turns) and matching is
candidate-in-gold — one retrieved member of the gold session already counts.
Chains can't pull from sessions with no hit, so they are structurally
near-useless for this metric.

**Conclusion:** density escalation is dead on arrival (trigger fires on
10–25% of the target questions), and chains are a BEAM-specific,
message-level-multi-evidence tool. The binding constraint everywhere is
**first-hit recall per relevant session**, not within-chain expansion — the
activation gate is the right deployable default, and further chain work has
poor expected value compared to routing/base-recall improvements.
