# Borrow Float32 payloads only during synchronous scoring

[中文](2026-10-09-borrow-float32-scoring.zh-CN.md)

**Status:** implemented
**Approved:** auto
**Relates to:** [single vector payloads](2026-10-07-single-vector-payload.md)

## Problem

`searchWithVector` decoded every preferred BLOB into an ordinary JavaScript
array immediately before cosine scoring. The binary payload already contains
the same Float32 values. A user-supplied single-dialog comparison suggested
avoiding this allocation; its reported approximately 40% end-to-end improvement
is not independently reproduced here.

## Decision

Add the internal `scoringVector` reader and use it only inside the synchronous
record-vector cosine expression. Borrow a `Float32Array` only on little-endian
hosts when the projected value is a `Uint8Array`, its byte offset and length
are multiples of four, and its backing store is a private, non-resizable
`ArrayBuffer`. Preserve the exact slice, not the whole backing allocation.

All other cases call the unchanged `storedVector` decoder: projected NULL and
mistyped values keep precedence, legacy JSON and separate-column rows remain
readable, and incomplete float payloads keep their previous truncation behavior.
There is no new storage marker, migration, precision change, environment option,
or public return type. Stored-vector readers and caches retain their previous
ordinary-array behavior.

Borrowed views are read-only by usage, not by JavaScript enforcement. They must
not be cached, returned to consumers, or retained across async work or WASM heap
growth. Shared/resizable buffers are excluded rather than extending their
mutable lifetime into cosine scoring.

## Alternatives considered

- Continue allocating ordinary arrays for every record: correct but unnecessary
  for complete aligned payloads used immediately.
- Return views from public stored-vector APIs: rejected because that changes
  ownership, mutability and lifetime expectations.
- Accept shared/resizable buffers or ignore trailing bytes on the fast path:
  rejected; retain the decoder for these cases without redefining its semantics.
- Change candidate selection, normalize vectors ahead of time, or cache every
  decoded vector: separate decisions with different validity and storage costs.

## Consequences

Eight safety/contract regressions cover slice ownership, alignment, incomplete
payloads, precedence/fallback, nonmutation, Float32 edge values, native SQLite
statement reuse/deletion/close, basic WASM heap growth, public arrays, and exact
result/score parity against the decoder fallback. Store parity uses positive
qwen3/hash results and hybrid's no-FTS-hit vector fallback; the existing
hybrid FTS-hit parameter-order defect is tracked in the
[active queue](../../design/temporary-todo.md#8-repair-hybrid-fts-hit-sql-parameter-ordering),
not changed or treated as vacuous ranking proof.

The [offline observation](../../experiments/retrieval/float32-scoring-2026-10-09.md)
measures only a synthetic scoring kernel. It supports avoiding decoding copies,
not a general retrieval or cloud speed claim.

## Deferred

Reproduce the supplied LoCoMo/cached-Qwen comparison from its harness and vector
artifacts. Validate actual Sites/SQLite WASM/VFS integration and deployment
memory ownership; a basic `WebAssembly.Memory` test is not that validation.
Big-endian hardware has not been exercised; it uses the decoder branch. No
production benchmark, live model call, or cloud deployment is part of this work.
