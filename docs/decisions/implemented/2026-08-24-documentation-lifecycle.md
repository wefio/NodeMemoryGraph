# Lightweight documentation lifecycle

[中文](2026-08-24-documentation-lifecycle.zh-CN.md)

**Status:** implemented

## Problem

NMG accumulated normative design, implementation status, temporary work,
experiments, and operating guidance faster than their ownership rules evolved.
Repeated summaries made it difficult to tell which file should be updated, while
a strict mirrored bilingual system would add maintenance cost unrelated to NMG.

## Decision

Use a lightweight ownership and lifecycle system:

- one normative design baseline plus owning topic designs;
- lifecycle-managed decision records for rationale;
- separate evidence, completion-audit, and unresolved-TODO surfaces;
- one project Skill named `doc-maintenance` as the operational workflow;
- paired bilingual public indexes and normally paired decisions, without
  paragraph-level equivalence or translation hashes;
- a structural verifier that fails on broken local links, missing headings, or
  malformed decision records, while bilingual drift remains a warning.

## Alternatives considered

- Keep informal conventions only. This had too little guidance for multiple
  Agents and allowed ownership drift.
- Mirror every document strictly with hashes or sidecars. This would improve
  mechanical parity but impose high churn on experiments and internal notes.
- Prefix every artifact with `nmg-`. The repository already supplies the project
  namespace, so `doc-maintenance` is clearer and sufficient.

## Consequences

Contributors must identify the owning document before adding another file. Public
entry points remain bilingual, but translation is judged by preserved intent
rather than identical structure. The verifier catches objective breakage without
turning evolving translations or historical notes into release blockers.
