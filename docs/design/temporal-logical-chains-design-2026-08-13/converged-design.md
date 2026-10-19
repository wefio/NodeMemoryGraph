# Design convergence: bounded chain disclosure

[English](converged-design.md) | [简体中文](converged-design.zh-CN.md) · [Terms](converged-design.terms.yaml) · Parent: [Temporal/logical chain design history](../temporal-logical-chains-design-2026-08-13.md)

Dated design synthesis from 2026-08-13. External research comparisons below are historical citations, not independently verified NMG evidence. Current expansion values in “Current source contract” were checked against the current source; the implementation remains authoritative.

## Design boundary

Temporal questions can require ascending, descending, or bounded time windows; the query determines which order is useful. Retrieval should recall relevant evidence without globally re-ranking all results by time. Chain structure is a recall supplement and presentation aid, not a reasoning engine: callers write membership and directed edges explicitly, and downstream consumers interpret the returned context.

A temporal chain stores ordered references to records; the store appends members by default, so callers that require event-time order must supply positions derived from `eventTime`. Logical chains use explicit membership and directed DAG edges. A memory may belong to multiple chains; sharing a member creates intersections, but does not imply that the system inferred a relation.

## Current source contract

Chain expansion runs only when the caller sets `expandChains`. It appends a bounded supplement and leaves the primary retrieval ranking intact. Current defaults and hard caps in `src/core/store/retrieval.ts` are:

- Cross-chain intersection: `chainExpansionMaxHops` defaults to `1` and is capped at `1`, so a direct-hit chain may expose one adjacent chain layer (`C0 → C1`), never recursively `C2`.
- Chain selection: `chainExpansionMaxChains` defaults to `4`, hard-capped at `8`. The code uses MMR-style selection: relevance is stronger for direct-hit chains plus topic overlap; redundancy is the Jaccard overlap of member IDs; score is `0.7 × relevance − 0.3 × redundancy`.
- Edge disclosure: `chainExpansionMaxEdges` defaults to `64`, hard-capped at `128`.
- Logical-chain member traversal: `chainExpansionMaxMemoryHops` defaults to `2`, hard-capped at `8`; temporal chains use position and `chainExpansionWindow` instead.
- `chainExpansionWindow`, when supplied, bounds member positions around the hit positions. Without it, non-hit members pass an activation threshold of `0.5`. `chainExpansionMaxMembers` defaults to the number of primary results.
- Appended supplements share a default budget of `min(16,000, 1,024 + 0.75 × primaryEvidenceChars)`; callers may override the budget options. This budget is shared with other appended, unranked supplements.
- Logical-chain rendering has a separate default structure budget of `2,048` characters in `src/integration/chain-projection.ts`. It does not replace the evidence budget, and statement bodies remain separate from the projected structure.

These are current source values, not evidence that a particular chain improves answer quality. Exact code and callers are linked below.

## Recorded rationale

The dated design selected four constraints: keep temporal ordering query-aware rather than globally re-ranking; represent temporal/logical paths as explicit static references; allow bounded cross-chain evidence through shared members; and keep inferred reasoning outputs from silently mutating memory or chain structure. The last constraint is a governance boundary, not a claim that all callers have identical supervision.

The previous draft used Mem0, Zep/Graphiti, TH-RAG, MMR, chronological passage assembly, MemOps, TrustMem, FOREVER, and ForgetBench to motivate those choices. Reported third-party metrics and conclusions are not reproduced here and must not be presented as NMG measurements.

## Source references

See [`SearchOptions`](../../../src/core/types.ts), [chain expansion and appended budget](../../../src/core/store/retrieval.ts), [chain persistence and DAG checks](../../../src/core/store/base.ts), [logical-chain projection](../../../src/integration/chain-projection.ts), and the [chain test suite](../../../tests/core/memory-chains.test.ts).