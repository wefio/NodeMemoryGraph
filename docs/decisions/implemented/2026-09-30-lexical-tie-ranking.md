# Resolve lexical score ties before evidence budgets

[中文](2026-09-30-lexical-tie-ranking.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [independent relevance training](2026-09-15-independent-relevance-training.md)

## Problem

Equal first-stage lexical scores leave some selected evidence in a weak order.
The tested small neural ranker did not demonstrate a material, reliable gain over
product ranking on real recall traces. The measured outcomes are in
[the retrieval experiment](../../experiments/retrieval-quality/lexical-tie-ranking-2026-09-30.md).
Resolving ties only after selection cannot recover the preferred record once a
direct cap or AG budget has removed it. A one-record query can therefore return
a different first record from the same two-record query.

## Decision

The FTS5-only path resolves adjacent, exactly equal-`combinedScore` records
before the direct result cap and before AG selection. The existing tie-break
uses IDF-weighted query-word coverage over a statement and its first 500 evidence
characters, with term frequency calculated over the pool at that stage.
It preserves scores and non-tied order, not the selected prefix or QPP observations.
Candidate generation, budget limits, gate parameters, semantic retrieval and forced
surface supplements remain unchanged. Open attachments keep their reserved positions.
No neural ranker or model artifact is added.

## Alternatives considered

- Add the tested MLP to product ranking: rejected because its same-candidate
  result was weaker than the existing ranker, and its top-tie gain was not
  statistically supported.
- Keep post-selection tie sorting: preserves the selected set but cannot help a
  preferred record below either cap, which defeats this small-budget slice.
- Change scores, reorder non-tied candidates or alter candidate generation:
  outside this change and unsupported by the controlled comparison.

## Consequences

The rule uses transient CPU work and no model weights. The original post-selection
experiment improved LoCoMo ranking while LongMemEval and BEAM had small regressions;
its unchanged R@20 applies only to that former same-selected-set comparison.
The pre-budget extension has separate
[controlled small-budget evidence](../../experiments/retrieval-quality/lexical-budget-2026-10-10.md).
It can change selected membership, QPP decisions and estimated context cost, and
runs coverage over up to the existing 500-record pool. Neither experiment proves
current online noise rate, general semantic recovery, or answer quality.
