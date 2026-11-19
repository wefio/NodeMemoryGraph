# Use nodes and leaves for structural retrieval

[中文](2026-11-19-structural-leaves-record-vectors.zh-CN.md) · [Terms used](2026-11-19-structural-leaves-record-vectors.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

SQLite retained node and leaf vectors alongside record vectors. In the local
LoCoMo ablation, record-only hybrid retrieval had 59.75% evidence Recall@20.
Adding both hierarchy layers gave 59.24% and helped some individual queries.
The existing leaf links also provide a way to find related evidence directly.

## Decision

Use named nodes and recorded relations for structural lookup. Keep semantic
scoring at the record level. Expand leaf context from ranked seeds using
existing membership links or a shared primary source. Keep these additions
bounded and within the seed's scope.

The local compatibility values `hierarchy` and `union` both request bounded
leaf context, with the chosen lexical or record retrieval mode providing the
seeds. Use spare result slots for leaf context and identify those results in
the retrieval output.

## Alternatives considered

Retaining a separate semantic hierarchy kept a second scoring path and its
storage cost. Deriving new groups by fixed time windows would group unrelated
facts in long sessions. Existing membership and exact source identity give
direct links with a clear provenance. Reserving ranked slots for leaf context
lowered LoCoMo evidence Recall@20 to 57.71% from 59.75%.

## Consequences

The SQLite upgrade keeps memberships and record vectors in the same database
and retires the derived node and leaf vector table without file compaction.
Evaluation of the structural expansion uses a separate arm from the former
hierarchy scoring.
