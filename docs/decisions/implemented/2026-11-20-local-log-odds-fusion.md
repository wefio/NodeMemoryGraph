# Use calibrated lexical and vector scores for SQLite hybrid retrieval

[中文](2026-11-20-local-log-odds-fusion.zh-CN.md) · [Terms used](2026-11-20-local-log-odds-fusion.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

Explicit search and economy recall ranked the same SQLite hybrid candidates
with separate scoring rules. The unified ranking needs to work without
relevance labels or per-library tuning.

## Decision

SQLite supplies BM25 and vector cosine scores for the authorized union of the
two candidate routes on the same read snapshot. The memory engine centers each
route on the median of its positive scores and scales by their population
standard deviation. It combines the calibrated vector and BM25 evidence with
fixed weights of 0.75 and 0.25. Candidates with a BM25 match use the weighted
sum scaled by the square root of two. Other candidates use their calibrated
vector evidence directly. Stable memory IDs break ties.

## Alternatives considered

Fixed weights avoid query-routing inputs or a relevance-label calibration step.
The evaluated 3:1 ratio improved evidence coverage over 6:1 at both tested
candidate depths. The compact recall replay also favored 3:1 over the prior
rank fusion at the same default five-item budget. Query-adaptive weights traded
coverage across the evaluated datasets without improving the pooled result.
The [experiment report](../../experiments/retrieval/local-log-odds-fusion-2026-11-20.md)
records the quality and SQLite read measurements.

## Consequences

The engine applies the authorization and visibility rules before score
calibration and reads original evidence after candidate selection. SQLite
reuses the existing full-text and vector indexes and batches cross-score
lookups. Lexical and vector-only modes retain their dedicated search paths.
The [display contract](../../design/recall-context-and-display.md#candidate-ordering)
describes how the daemon carries the resulting order into recall.
