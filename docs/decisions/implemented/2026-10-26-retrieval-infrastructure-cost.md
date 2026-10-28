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
remain unchanged. The assembly change adds no independent renderer or budget.

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

## Request-local query preparation extension

A daemon search can call the shared search entry for several stores or repeated
semantic clauses. Previously each healthy hybrid branch embedded the same text
again. Reuse only the query preparation within that invocation, while preserving
fresh store reads and the existing automatic deadline. Failures and empty
responses remain retryable. This avoids the invalidation, tenant boundaries and
retention cost of a process-wide cache; it does not combine different queries or
alter provider batch semantics. The [retrieval contract](../../design/design/progressive-retrieval.md#request-local-query-preparation)
owns its lifetime and exclusions.

The [paired measurement](../../experiments/retrieval/request-preparation-2026-10-28.md)
records provider call counts, simulated waiting time and exact candidate equality.
Tests include a real loopback HTTP provider through `NmgService`, deletion between
reads, concurrent consumers, retries and cancellation. This extension has not been
measured against live providers or a full recall benchmark; the earlier 500-question
LME evidence above belongs to the earlier assembly change.
