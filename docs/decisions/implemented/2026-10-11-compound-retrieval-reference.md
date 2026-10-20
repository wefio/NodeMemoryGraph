# Graph-scoped compound retrieval references

[简体中文](2026-10-11-compound-retrieval-reference.zh-CN.md) · [Terms used](2026-10-11-compound-retrieval-reference.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Shared disclosure copy](2026-10-10-shared-disclosure-copy.md)

## Problem

Full UUIDs consume tokens in both candidate headers and exact-read arguments.
The user authorized a bounded trial against UUIDs, not a new ID generator or
production deployment. A short combination that is unique only against current
content can silently move to another record after edits or deletion.

## Decision

The isolated prototype uses graph-scoped prefix/quote selectors with immutable
original content witnesses in the existing private retrieval projection. The
[Agent Surface contract](../../design/design.md) owns formatting,
identity and failure behavior. Witnesses are bounded projection data, not a new
alias store or durable memory. Resolution establishes original identity before
checking current content. Ordinary get RPC and shared library helpers perform
this work without a model decoder, additional tool or host-local resolver.

The [fixed experiment](../../experiments/retrieval-quality/compound-reference-2026-10-11.md)
counts duplicate quote text, get arguments, graph IDs and changed instructions.
It does not require beating a pure-short-ID alternative. Canonical storage,
compact JSON IDs, exact evidence, attribution and lifecycle IDs remain intact.

Operational adoption observation uses two in-memory counters on the existing
status surface, not another trial or telemetry pipeline. Both read forms stay
supported; no persistent usage log, new tool or reference-selection policy is
introduced. The design owns counter scope and lifetime.

## Alternatives considered

- Full UUIDs preserve independent, durable lookup and remain the fallback.
- Unchecked UUID truncation and current-content-only matching cannot establish
  original identity under collisions or record edits.
- A standalone alias database adds another owner and lifecycle; the existing
  session projection already owns the relevant immutable read snapshot.
- Compact native IDs or UUID encodings change generation or parsing obligations
  beyond this reference trial.

## Consequences

Normal copied-reference paths are cheaper in the named offline token fixtures.
Canonical-only/fallback paths still pay a small static instruction increase.
Expired projections and changed quotes can fail; a manual UUID recovery costs
another call and can erase the saving. These references therefore do not replace
UUIDs for durable citations. Backend reads also add observed local CPU cost.
No claim is made about model relevance, semantic information gain, billing,
cache reuse, raw JSON savings or final transport confirmation.

## Deferred

Merge, deployment, daemon restart and a durable-reference policy require separate
approval. Live model/embedding benchmarks and model-matched billing are outside
the trial.
