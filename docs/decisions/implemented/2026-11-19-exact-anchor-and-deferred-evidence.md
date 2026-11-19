# Resolve exact anchors and load evidence after ranking

[中文](2026-11-19-exact-anchor-and-deferred-evidence.zh-CN.md) · [Terms used](2026-11-19-exact-anchor-and-deferred-evidence.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

The default local search waits for a query embedding even when the user supplies a
precise identifier. The engine loads historical evidence for the entire candidate
pool before it knows which records will be returned. SQLite also recalculates the
same query norm and may score the same hierarchy vector for several memories.

## Decision

A standalone identifier or quoted phrase can satisfy a default explicit local search
through a complete statement match among visible candidates. Literal matching keeps
identifier punctuation and checks boundaries. Scope, user-selected retrieval mode,
and alternate queries retain their normal behavior.

Finish candidate selection before loading evidence. The engine keeps the existing
candidate order for ties and preserves evidence order within the pinned read
revision. SQLite reuses the query norm. The
[structural leaf decision](2026-11-19-structural-leaves-record-vectors.md)
defines the scope of vector scoring.

## Alternatives considered

Skipping embeddings on any matching term would let common words suppress semantic
recall. A bounded shortlist based on approximate vector scores would alter the
ranked candidate set. A new persistent cache would add invalidation and storage
costs to a problem that can be solved within each query.

## Consequences

A successful literal lookup avoids the embedding request. A literal miss adds one
bounded lexical pass before normal retrieval. Tests cover exact and prefix-only
matches, scoped fallback and explicit hybrid mode. A fixed-vector comparison can
check numerical parity without an embedding service.
