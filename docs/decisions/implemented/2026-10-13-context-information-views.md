# Item-based shared context information

[中文](2026-10-13-context-information-views.zh-CN.md) · [Terms used](2026-10-13-context-information-views.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Shared information output](2026-10-07-shared-information-output.md)

## Problem

The dynamic turn message combines source-oriented recall and AG blocks with maintained state,
control instructions and diagnostics. Large strings cannot be selected independently; history
board reads and old tool failures can continue to appear as current material.

## Decision

The [state-space owner](../../design/state-spaces.md#unified-context-information-items) defines one
InformationView protocol for existing and future state content and the dynamic message.
Typed entries remain the basic unit. Purpose-based presentation does not create a source owner,
a state table, a graph store, a Task abstraction or an orchestration language.

Shared preparation selects complete items and counts the grouped envelope in one context budget.
Ordinary flat output remains compatible. Automatic preparation does not mark omitted memories as
disclosed or infer provider exposure. AG and board owners retain lifecycle and permissions;
explicit history reads remain available without automatically becoming working context.

## Alternatives considered

- Keeping five large strings: does not allow item-level omission or preserve independent purposes.
- Separate StateView or per-adapter selectors: duplicates the existing source-bound protocol.
- Markdown tables or a view graph as the protocol: presentation would become data or another owner.
- Guessing task relevance or error recovery from body text: conflates semantics with deterministic lifecycle.

## Consequences

Source and purpose are independent. Candidate previews, scratchpad qualifiers and graph reference
scope stay attached to their items. Maintained state remains atomic; bounded compaction recovery
precedes optional material. Omission bookkeeping cannot evict state, recovery or diagnostics.
The RPC preserves structured tool-result/error provenance rather than inferring it from text.
Short-lived observations have
an owner-provided turn stamp; legacy observations remain explicitly readable rather than being
silently promoted to current context. Existing delivery, write fencing and collaboration decisions
are not changed by presentation.

## Deferred

Semantic task identity, an independent Task owner, a management table UI, graph visualization,
final provider transport confirmation and measured model/cache savings are not established.
Shared-daemon deployment requires its own coordinated reload; source verification is not deployment.
