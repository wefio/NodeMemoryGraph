# Reduce retrieval assembly and InformationView preparation cost

[中文](2026-10-26-retrieval-infrastructure-cost.zh-CN.md) · [Terms used](2026-10-26-retrieval-infrastructure-cost.terms.yaml)

**Status:** implemented
**Approved:** auto

## Problem

InformationView preparation rebuilt the complete admitted output for every
candidate's budget check. Direct and node retrieval separately fetched links
and history rows for every returned memory. Both costs grew with the amount
of evidence offered to the reader.

## Decision

Optimize the existing `prepareInformationOutput` and store assembly paths.
Preparation maintains incremental character counts and reuses each source
fingerprint. Store assembly reads linked history with bounded SQL joins.

The contracts remain at [state presentation](../../design/state-spaces.md#unified-context-information-items)
and [retrieval evidence assembly](../../design/design/progressive-retrieval.md#evidence-assembly).
The existing rendered-evidence token estimator and exact-evidence renderer
remain unchanged. This change adds no independent renderer, budget or cache.

## Alternatives considered

- Re-render every candidate: simple, but repeated copying dominates large views.
- Cache full rendered outputs: requires invalidation across source changes;
  incremental accounting needs only request-local state.
- Hydrate only the final AG page: could save more work, but crosses consumers
  that inspect provenance during intermediate retrieval. Batching at the
  existing assembly boundary preserves those consumers.

## Consequences

Counter correctness depends on separators, group envelopes and omission
removal. Boundary tests cover these cases, including a mixed AG/board wrapper
that becomes shorter when an item is added. Evidence tests cover ordering,
shared sources, empty results, missing history and chunk boundaries.

The [offline measurements](../../experiments/retrieval/infrastructure-performance-2026-10-26.md)
include output hashes and repeat runs. They establish local cost reductions;
the separate full LME paired check establishes unchanged recall@20 and output
on 500 questions. Neither result establishes recall improvement or a speedup
of the complete answer-and-judge pipeline.
