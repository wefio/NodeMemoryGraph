# Browse memory neighborhoods through explicit search

[简体中文](2026-11-21-explicit-memory-neighborhood.zh-CN.md) · [Terms used](2026-11-21-explicit-memory-neighborhood.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

A compact recall result may point to relevant context outside the preview.
The caller needs a way to inspect that context using the displayed reference.

## Decision

Local search interprets a bare canonical memory ID or an owned compound reference
as a neighborhood anchor. It uses source and graph indexes with the caller's
visibility and recall bounds. A follow-up search gets its own candidate page;
the economy preview allocates its space to the initial recall.

## Alternatives considered

Allocating space to neighbors during economy recall makes them compete with
the initial candidates on every admitted query. A separate tool would require
hosts to register a second entry for the same candidate surface.

## Consequences

A search result already carries the anchor and graph needed to follow a
reference. Reusing that pair keeps one search tool and lets the caller decide
when a neighborhood is worth reading. An ID has no relevance text to embed.
The [search and display contract](../../design/recall-context-and-display.md#browse-a-memory-neighborhood)
defines the entry point and the result.
