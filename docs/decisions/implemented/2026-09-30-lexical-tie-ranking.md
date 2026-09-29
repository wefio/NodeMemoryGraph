# Resolve lexical score ties after evidence selection

[中文](2026-09-30-lexical-tie-ranking.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [independent relevance training](2026-09-15-independent-relevance-training.md)

## Problem

Equal first-stage lexical scores leave some selected evidence in a weak order.
The tested small neural ranker did not demonstrate a material, reliable gain over
product ranking on real recall traces. The measured outcomes are in
[the retrieval experiment](../../experiments/retrieval-quality/lexical-tie-ranking-2026-09-30.md).

## Decision

The FTS5-only path reorders adjacent, exactly equal-`combinedScore` records after
the Active Graph budget has selected them. The tie-break uses IDF-weighted coverage
of the query's word terms over a selected statement and its first 500 evidence
characters. It preserves the selected set, non-tied order, QPP decisions, and
hybrid retrieval. The small neural ranker is a failed experiment for this task;
no neural ranker or model artifact is added by this change.

## Alternatives considered

- Add the tested MLP to product ranking: rejected because its same-candidate
  result was weaker than the existing ranker, and its top-tie gain was not
  statistically supported.
- Reorder all candidates or alter candidate generation: outside the measured
  rule and would change the evidence budget or recall set.
- Keep existing lexical tie order: loses the measured LoCoMo ranking gain.

## Consequences

The rule uses transient CPU work and no model weights. It improves LoCoMo ranking
on the pinned sample while LongMemEval and BEAM have small regressions; R@20 and
candidate membership do not improve. It is not evidence of better semantic
candidate recovery or answer quality.
