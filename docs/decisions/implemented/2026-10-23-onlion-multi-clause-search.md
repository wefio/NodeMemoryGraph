# Multi-clause search in one request

[简体中文](2026-10-23-onlion-multi-clause-search.zh-CN.md) · [Terms](2026-10-23-onlion-multi-clause-search.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

`/search` accepted one `query` plus `options`, and built its retrieval clauses
as `query` and `query + ' ' + option`. That shape fits multiple-choice questions.
It cannot express an independent clause: a clause whose text is not the question
with a suffix, such as the question's content words alone or an entity-plus-
attribute probe.

A caller that wants two retrieval views therefore sends two requests and fuses
them itself. That pays the per-request fixed costs twice — store open, manifest
read, snapshot fetch — and leaves the server's own fusion unused even though
`AmlMemoryService.search` already loops clauses and keeps the highest score per
memory id.

## Decision

`/search` accepts an additive `queries` field: one to eight clauses, each either
a string or `{text, name}`. The caller supplies the clauses; the server does not
invent retrieval dimensions. The response fuses them exactly as before — highest
`combinedScore` per memory id, sorted, capped at `top_k` — and adds one row per
clause:

```json
{"clauses": [{"name": "original", "index": 0, "contributed": 7, "exclusive": 2}]}
```

`contributed` counts returned memories the clause surfaced; `exclusive` counts
returned memories no other clause surfaced. Both are computed over the returned
page, so a caller can see whether a dimension it added earned its request.

`queries[0]` is the presentation clause: temporal rendering already uses the
first query. Identical clause text collapses before retrieval, keeping the first
label, so a fusion index always names one clause. `queries` with `query` or with
`options` is rejected rather than guessed. The legacy shape keeps working and now
also receives a single `clauses` row.

## Alternatives considered

- Per-clause `top_k`: measured retrieval depth beyond about twenty candidates
  adds nothing to the returned page, so a second number would add an untested
  combination without buying coverage.
- A fusion-mode switch: keeping the highest score per id measured better than
  round-robin interleaving (20.8% versus 20.1% on the same questions).
- Server-side clause construction: it would move retrieval policy into the wire
  format and make each new dimension a server release.
- Concatenating clauses into one query string: a clause's unique contributions
  are memories the original query never ranks at all, so concatenation is a
  different mechanism and is not assumed equivalent.

## Consequences

One request now carries up to eight retrieval views and returns one pool with
per-clause attribution. The internal clause loop stays sequential per request, so
the saving is the repeated per-request work, not the retrieval computation
itself. Response size stays bounded by `top_k`.

The clause implementation is text-only; a multimodal `query` keeps its existing
content-view path. Attribution is descriptive: it does not prove that a clause
improved an answer, and it does not rank clauses for a caller.
