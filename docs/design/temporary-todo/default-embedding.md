# Make embedding work by default on store and retrieve

**Authority:** [Parent scope](../temporary-todo.md).

## Make embedding work by default on store and retrieve

User requirement: embedding must be present on the normal write and search
paths; local hashing is a fallback, not a substitute. Observed failure: the
embedding config lived only in a repo `.env` that the daemon never reads, so a
daemon restart silently dropped the API key and every subsequent search fell
back to lexical while the operator believed embedding was on
(`embedding_index_state.status = "failed"` after a single free-tier 429,
`last_succeeded_at = null` → search always lexical). The configured provider
did build 96 vectors on 2026-09-01 and then never ran again.

- [x] Trigger a bounded embedding drain on every remember/search (no
  writeThreshold/accessThreshold batching): each operation tops up one small
  batch of missing vectors in the background, so low-activity stores still
  converge and a 429 just queues the rest for the next operation.
  (`syncEmbeddingTarget` `maxBatches`, `#drainEmbeddings` fires on every
  `#signalMaintenance` from remember/search with `{ maxBatches: 1 }`.)
- [x] Treat provider rate-limit / transient failures as *pause, not fail*: a
  429/5xx must not set the whole index to `failed` (which permanently disables
  hybrid until a full rebuild); record `last_failed_at` + reason and resume on
  the next drain. Only persistent (non-rate-limit) failure degrades.
  (Search now serves hybrid from a *partial* index — `LEFT JOIN` keeps lexical
  results while indexed records get the vector lift — so a failed/429'd index
  is never a dead end; the drain retries on later operations. Provider
  failures additionally start a 30s cooldown so a down provider cannot hang
  every query; search reports `degraded: true` with the reason.)
- [x] Retrieve with a local-hashing degrade when no external vector exists —
  **evaluated and closed: not doing.** The current fallback degrades to plain
  lexical with `degraded: true` + reason, which is the intended end state. A
  local-hashing blend was measured and rejected: on the real store, 256-d
  `nmg-hashing-v1` blended retrieval is byte-identical to pure lexical
  (self-recall 45/154 both arms; vector scores ≈ 0), matching the published
  dimensionality bottleneck for low-dimensional hashing vectors. The known
  fix — NUMEN-style very high dimensions (16K–32K) that beat BM25 — costs
  enormous fixed memory per vector, which is not acceptable for a local,
  SQLite-backed store. Feature-hashing/SimHash are word-level tools
  (spelling, near-dedup), not semantic retrieval. See the rejected decision
  record (2026-09-03-hashing-vector-retrieval-fallback).
- [x] Drop the `NMG_EMBED_AUTO_SYNC` gate: presence of a configured provider
  (+key) implies auto-sync. Keep the env as an explicit *disable* switch.
- [x] Persist embedding configuration at the deployment layer (User-level env /
  documented daemon launch) so a restart keeps provider + key; document this in
  the owning guide/ADR rather than inventing a new config-file mechanism.
  (User env set 2026-09-03; daemon restart keeps `provider: gemini` +
  `indexId` ready.)

**Available mechanism:** write and access paths already `signalMaintenance`
(`src/cli/service.ts` #remember/#search); `#drainEmbeddings` already runs
records→leaves→nodes incrementally from the SQLite missing-vector queue
(`embeddingDocuments` with a limit, batch 64); every record already carries
local hashing vectors (`memory_embeddings` model `nmg-hashing-v1`, 327 rows);
`searchMemoryContext` already has a lexical fallback seam and a
`degraded/reason` return shape; `embedding_index_state` already tracks
running/ready/failed with `last_error`.

**Pre-change blocker (resolved by the checked changes above):** the drain is gated behind the maintenance threshold
(16 writes / 32 accesses) so low-activity use never converges; one 429 marks
the index `failed` and there is no pause-and-resume; and without the env the
configured provider silently disappears on daemon restart (operator's real
incident). Industry practice confirms the direction: async post-write
embedding with background queue and automatic semantic-search upgrade
(mcp-memory-ts), and a provider lifecycle that degrades only on *persistent*
failure with an unavailable-reason + fallback path (openclaw #94240/#101272).

**Acceptance criteria (recorded before implementation):** with a configured provider, a fresh `remember` produces a
searchable vector within one operation cycle and a later `search` reports
hybrid; a simulated 429 pauses the drain without `status = failed` and the next
operation resumes it; with no provider (or provider down), search degrades to
lexical with `degraded: true` and an explicit reason; and a daemon restart with
persisted config keeps embedding enabled (verified against the real store). The checked items above record implementation status; this review did not independently re-verify every end-to-end criterion.
