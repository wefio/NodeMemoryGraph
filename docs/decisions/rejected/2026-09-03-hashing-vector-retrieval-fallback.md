# Local hashing vectors as a retrieval fallback

[中文](2026-09-03-hashing-vector-retrieval-fallback.zh-CN.md)

**Status:** rejected  
**Date:** 2026-09-03

## Problem

When an external embedding provider is unavailable (rate-limited, down, or not
configured), retrieval falls back to lexical-only. The store already writes a
local `nmg-hashing-v1` vector (256-d deterministic hash) for every memory, so
it was proposed to blend those vectors with lexical search as a degraded
retrieval mode that is "better than pure lexical".

## Proposal

When no external vector exists, run search as lexical + local `nmg-hashing-v1`
vector blend (a local hybrid), marking the result `degraded: true`.

## Alternatives considered

- **Raise hashing dimensions (NUMEN-style 16K–32K) so the blend is
  discriminative.** Rejected: enormous fixed memory per vector is unacceptable
  for a local SQLite store; the whole point is small and dependency-free.
- **Treat hashing only as a word-level tool (near-dedup, spelling) rather than
  semantic retrieval.** Not part of this rejection — separately tracked as a
  candidate (see ticket 7), because that role is a different task with
  different dimension requirements.

## Why rejected

Measured and researched, the blend provides no gain and the known fix is
unaffordable:

- **Measurement (real store):** blending 256-d hashing vectors is
  byte-identical to pure lexical — self-recall 45/154 in both arms, vector
  cosine scores ≈ 0. The hashing vectors carry no discriminative signal at
  256 dimensions.
- **Published dimensionality bottleneck:** deterministic character-hashing
  retrieval only overtakes BM25 at very high dimensions (NUMEN, arXiv
  2601.15205: 93.90% Recall@100 at 32,768 dimensions vs BM25 93.6%).
  Low-dimensional hash vectors collapse distinct texts into near-orthogonal,
  information-poor vectors.
- **Cost of the fix:** NUMEN-style high dimensions need enormous fixed memory
  per vector (a FastText-style bucket table, or 32K floats per row), which is
  unacceptable for a local SQLite-backed store whose whole value is being
  small, offline, and dependency-free.
- **Out of scope — not rejected:** feature hashing and SimHash are word-level
  tools whose legitimate uses are spelling-tolerant matching and
  near-duplicate detection _as a complement to lexical search_, not semantic
  retrieval. This decision rejects only the semantic-retrieval blend; a
  word-level role (e.g. recalling near-duplicate candidates whose spelling or
  word form differs from the query, before an LLM judge decides) is a
  separate, independently evaluable candidate and is not covered by this
  rejection.

## Consequences

- The no-external-provider path stays a plain lexical fallback that reports
  `degraded: true` with a reason — honest about the degradation instead of
  silently adding a signal that measures as zero.
- Semantic retrieval quality comes from a configured external embedding
  provider (the hybrid path), which the embedding-default-on work makes
  reliable: every remember/search tops up a bounded batch, provider presence
  implies sync, and provider failures pause rather than fail the index.
- This rejection is scoped to hashing vectors as a _semantic_ retrieval
  signal. Word-level uses of hashing/SimHash (near-dedup candidate recall,
  spelling-tolerant matching) remain open for separate evaluation.
