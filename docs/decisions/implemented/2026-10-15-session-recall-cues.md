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

The existing main LLM can recover with explicit search and propose a literal cue
through the shared `recall_gate` Lab capability. A lease and a bounded in-memory
cache keep this experiment separate from saved facts and candidate relevance
learning. A revision ties correction to a supplied skipped query; it does not
certify the assistant's intent judgment. The
[retrieval owner](../../design/design.md#session-only-recall-cues) defines the
matching, budgets and lifetime; the
[operation manual](../../../skills/nmg-memory/references/optional-capabilities.md#recall_gate-operations)
contains the input contract.

Pi forwards native turn observations and consumes the shared decision. MCP and
DSH expose the same Lab operations; their automatic context lifecycle is not
claimed equivalent. No new model or independent per-turn LLM judge is used.

## Alternatives considered

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

Fixtures exercise explicit rescue, later cue reuse, retirement, isolation and
lease lifecycle. They do not establish natural LLM self-correction, provider-send
behavior, precision or cost improvement.

## Deferred

Natural-use observation, low-budget lexical comparison, TARG-style uncertainty
signals, and any cross-session promotion remain separate experiments. No live
model evaluation, shared-daemon replacement or default activation is part of
this implementation.
