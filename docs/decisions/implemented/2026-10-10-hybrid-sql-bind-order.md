# Bind hybrid candidates in SQL placeholder order

[中文](2026-10-10-hybrid-sql-bind-order.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Borrow Float32 scoring payloads](2026-10-09-borrow-float32-scoring.md)

## Problem

Hybrid retrieval repeats lexical candidate IDs in `WHERE` and `ORDER BY`. The
second list was bound before event-time and scope values, although its SQL
placeholders follow those filters. Valid FTS hits could disappear; a controlled
window-only example also admitted out-of-window records. Production prevalence
is not measured. Empty-result parity cannot validate this path.

## Decision

The second FTS ID list follows all event-time and scope parameters and precedes
the row limit. SQL predicates, candidate bounds, priority expression, score
weights, vector representation and public APIs are unchanged. Filtering remains
in SQL rather than a compensating post-query pass.

The [store contracts](../../../tests/core/store/hybrid-bindings.test.ts) exercise
positive FTS hits without filters, each time bound, both bounds, multi-key scope
and their conjunction. They check inclusivity, missing fields, exclusions,
repeatable ordering, public second-pass context, and FTS-only/vector-only,
no-hit hybrid and forced-candidate controls. The
[scoring parity contract](../../../tests/core/store/vector-scoring.test.ts)
compares positive-FTS hybrid results, not just the no-hit fallback.

## Alternatives considered

- Disable lexical priority or force semantic-only retrieval: avoids the defect by
  changing candidate behavior rather than repairing it.
- Reorder SQL clauses or filter after scoring: does not respect SQL syntax or
  filter-before-limit semantics.
- Replace the complete query with named-parameter infrastructure: larger change
  than the misplaced list requires. The regression matrix protects this seam.
- Time the broken hybrid path against the repair: different eligible outputs
  make that comparison unsuitable as an optimization benefit.

## Consequences

The bounded reproducer fails six positive cases before repair and passes after
repair; existing fallback/forced paths keep their constraints. A context test
uses `qppThreshold: 1` to request expansion explicitly rather than assuming the
maximum result limit overrides QPP's valid early stop.

Only after correctness is restored does the
[context-level observation](../../experiments/retrieval/hybrid-context-scoring-2026-10-10.md)
compare decoded arrays with borrowed Float32 scoring on the same repaired query.
It records synthetic store-level latency and exact output parity, not real
LoCoMo/Qwen, RPC/harness, deployment or worst-case gains.
