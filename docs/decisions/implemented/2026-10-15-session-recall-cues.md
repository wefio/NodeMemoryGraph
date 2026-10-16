# Session-only recall cue trial

[中文](2026-10-15-session-recall-cues.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Recall intent](2026-10-10-recall-intent-and-diagnostics.md)

## Problem

Static entry patterns miss implicit requests for past user information. Training
labels and an additional resident deep model are unsuitable under the user's
data and memory constraints. The user chose a session-only trial rather than
cross-session rule persistence.

## Decision

The existing main LLM can propose a literal cue while already making a normal
supplemental search. The shared `recall_gate` lease and bounded active pool keep
this weak signal separate from saved facts and candidate relevance learning.
Proposal fences tie admission to a supplied skipped query; they do not certify
the assistant's intent judgment. The
[retrieval owner](../../design/design.md#session-only-recall-cues) defines the
matching, budgets and lifetime; the
[operation manual](../../../skills/nmg-memory/references/optional-capabilities.md#recall_gate-operations)
contains the input contract.

Pi receives a small pool snapshot in its existing turn response and uses the
shared matcher. It sends bounded native source only with a proposed supplemental
search, not through an extra per-turn `prepare` RPC or injected notice. MCP/DSH
clients can piggyback an explicit preparation revision; their automatic context
lifecycle is not claimed equivalent. A bounded, on-request event ring permits
inspection without a second collector or automatic history injection.

## Alternatives considered

- Per-turn preparation/diagnosis: adds work before any normal supplemental search;
  the user rejected that overhead. Piggybacking still has schema, parameter and
  transport costs; it is not a claim of zero or minimum total cost.
- Whole-vocabulary activation by IDF/distribution: rarity and vocabulary share do
  not establish need or query budget. These features are not runtime policy.
- Cross-session/global rules: not the scope selected by the user; weak mistakes
  must not become permanent behavior in this trial.
- Append generated regexes to source: lacks session scope and simple retirement.
- Train a classifier: adds data preparation and deployment requirements the
  user rejected as prerequisites.
- Treat model confidence or retrieved overlap as labels: conflates intent,
  relevance and factual support.

## Consequences

Previously unseen expressions still depend on the main model's tool judgment.
Conservative lexical exclusions can miss valid requests, and learned cues can
still retrieve noise. Default-off behavior and removal limit exposure without
turning the cache into a truth or permission authority.

Fixtures exercise piggyback admission, later cue reuse, retirement, stale-fence
rejection, isolation and lease lifecycle, including private Pi HTTP and MCP stdio
transport. They do not establish natural LLM self-correction, provider-send
behavior, precision or cost improvement.

## Deferred

Natural-use observation, low-budget lexical comparison, TARG-style uncertainty
signals, and any cross-session promotion remain separate experiments. No live
model evaluation, shared-daemon replacement or default activation is part of
this implementation.
