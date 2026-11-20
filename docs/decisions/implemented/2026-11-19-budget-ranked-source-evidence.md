# Budget the ranked source-evidence page once per search

[中文](2026-11-19-budget-ranked-source-evidence.zh-CN.md) · [Terms used](2026-11-19-budget-ranked-source-evidence.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

Selecting records independently spends the available characters on tall first-ranked
records and repeats inference across stores and alternate query texts.

## Decision

The portable service accepts an evidence ranker as a dependency. It collects a
bounded shortlist, merges admitted results, and calls the ranker once per search.
The [retrieval contract](../../design/design/progressive-retrieval.md#evidence-assembly)
owns the page budget, provenance and fallback.

## Alternatives considered

A ranker call for each store or query variant repeats model work and spends the
page budget separately. Limiting the number of items in the strong model's
shortlist saves inference but can remove useful evidence before ranking.

## Consequences

A bounded optimization step applies source utility and text cost to all
shortlisted records. This lets several short records compete with a long
first-ranked record for the page budget. Implicit lexical or exact lookups still use their dedicated paths
when that retrieval mode is requested. Scoring only uses records already
admitted by the caller's storage and session filters.

## Deferred

Production ranking requires evidence across source corpora with the same
retrieval and character limits. The service accepts a ranker from its caller for
isolated tests. Any learned production profile must follow the
[independent training data contract](../../design/relevance-training.md#boundary).
