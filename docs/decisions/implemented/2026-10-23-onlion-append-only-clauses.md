# Append-only retrieval clauses

[简体中文](2026-10-23-onlion-append-only-clauses.zh-CN.md) · [Terms](2026-10-23-onlion-append-only-clauses.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Multi-clause search](2026-10-23-onlion-multi-clause-search.md)

## Problem

Clauses are fused by highest score per memory id and then capped to `top_k`. That
fusion assumes the clauses are comparable: a clause whose scores run high but
whose precision is low takes the page. Measured on the LoCoMo multi-hop set, a
fourth clause that retrieves only the question's entity names returns records
where 0.4% carry a labelled evidence turn; fused into the twenty-record page it
drops full coverage from 20.8% to 7.9% (0 wins, 36 losses). Rank fusion and
per-list score normalisation fare no better (12.9% and 7.5%).

The same clause used as a _supplement_ — added beside the page rather than in it
— raises coverage to 24.7% (+3.9pp) on the same questions.

The page is an allocation decision. A dimension that is broad but imprecise
should not be able to make that decision.

## Decision

A `queries` clause may carry `appendOnly: true` (or `mode: "append"`). Its
results never enter the ranked pool: they are collected separately, deduplicated
against the page by memory id, and returned as `appended` with the same
projection as `data`. The page still comes only from ranked clauses.

Bounds and refusals:

- the first clause carries the presentation and cannot be append-only;
- at least one clause must be ranked;
- `appended` is capped at `top_k` records and is absent when no clause is
  append-only, so a ranked-only response keeps its shape.

The service caps the supplement by record count. A text budget for the
supplement belongs to the caller that renders it: measured coverage rises with
appended characters up to about twice the page text and flattens after that.

## Alternatives considered

- Fuse everything and let scores decide: measured 7.9% with the broad clause.
- Reciprocal-rank or normalised-score fusion: 12.9% and 7.5%, still below the
  ranked-only 20.8%.
- Infer append-only automatically from the clause's precision: that needs a
  labelled signal at query time, which does not exist.
- Lower the broad clause's weight: a weight still lets it displace page records,
  and the right weight is unknown per question.

## Consequences

A caller can now attach an imprecise but wide dimension without paying for it in
the page. Two response fields instead of one make the distinction explicit, so a
reader can render the supplement under its own budget or ignore it.

The supplement is not ranked against the page: which record is "better" across
the two fields stays the caller's decision. Attribution keeps the same
`contributes`/`exclusive` counting, and an append-only clause reports zero page
contributions by construction.
