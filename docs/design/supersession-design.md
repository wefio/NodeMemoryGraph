# Memory supersession design

[English](supersession-design.md) | [简体中文](supersession-design.zh-CN.md) · [Terms](supersession-design.terms.yaml)

**Status:** Current contract summary, reviewed against `src/core/store/writes.ts`, retrieval projection, the Pi remember surface, and the OmniMemEval bridge. The previous draft's persona score and “96 unit tests” claim had no linked run artifact and are not used as evidence here.

Supersession records that a newer value replaces an older value for the same scoped property. The old record becomes `superseded`; the newer record points back to it through `supersedes_id`, and retrieval can surface the current successor when a query matches old wording. Supersession is not a generic synonym for similarity, contradiction, or relatedness.

## Ownership and decision boundary

| Step | Owner | Contract |
| --- | --- | --- |
| Detect possible stale-value candidates | NMG core | Text/transition/polarity heuristics only; no semantic verdict. |
| Decide whether one candidate is truly replaced | Caller or evaluation judge | Similarity is not identity. The current Pi surface presents bounded candidates and asks the Agent to choose; the OmniMemEval bridge has a separate evaluation-only judge path. |
| Apply a declared relation | NMG core | Validates scope and chain constraints, then records the relation transactionally. |
| Project retrieval results | NMG core | By default, a stale lexical/vector hit resolves to the current successor (or the value valid at an as-of time); `includeHistorical` bypasses successor projection. |

The ordinary duplicate-merge callback and supersession are separate. `RememberInput.judgeDuplicates` is used by the near-duplicate path; `supersedeCandidates` are surfaced separately and are not automatically judged or applied by `remember()`.

## Candidate discovery

`RememberResult.supersedeCandidates` is a heuristic list, not a verdict. By default `supersedeScan` is enabled; it can be disabled for bulk ingestion that has no candidate consumer. The scan is O(scope size), so a caller that neither judges nor displays the results should set `supersedeScan: false`.

The current scan:

- considers same-scope records in `active` or `disputed` status, without restricting candidates to the most recent N records;
- uses token prefiltering and normalized overlap, but excludes near-duplicates (those belong to merge review);
- places explicit `from X to Y` transition and caller-supplied polarity-flip hits ahead of token-only candidates; transition/polarity candidates are then ordered by similarity;
- caps the returned list at `SUPERSEDE_CANDIDATE_MAX` (`10`).

Transition and polarity signals improve candidate order; they do not prove that a single-valued property changed. A caller must still determine whether the old and new statements refer to the same scoped property. NMG's existing `src/core/simhash.ts` utility is currently used for tessera file-drift recovery; it is not used to recall memory supersession candidates. The separate [SimHash lexical-complement proposal](simhash-lexical-complement-design.md) remains a draft.

## Applying supersession

The core has two deterministic entry paths:

1. **Explicit pointer on write:** `RememberInput.supersedesId` declares the old record. The write requires the same scope, a non-deleted predecessor, and no existing successor; it marks the predecessor superseded and records the new record's `supersedes_id` pointer in the write transaction.
2. **Post-write application:** `applySupersession({ newMemoryId, supersededMemoryId, validUntil? })` applies an independently chosen relation. It rejects missing IDs, self-supersession, deleted records, scope mismatch, predecessor overwrite, successor branching, and cycles. The old value becomes `status='superseded'`; the new value points back with `supersedes_id` and gets `evidence_role='update'`.

Repeated application of the same pair is idempotent. `valid_until` is set only if it has not already been set, so a retry does not rewrite the first boundary. The schema is a single-parent/single-successor chain, not a branching version graph.

A separate, explicit state-key rule applies when a write has `memoryType: "state"` and a resolved `stateKey`: the current active record with the same `stateKey` and identical scope is superseded transactionally. This is property-addressed replacement, not semantic inference over arbitrary memories.

## Caller and feedback paths

- The Pi remember surface shows up to three possible stale values and says similarity alone is insufficient. If the Agent confirms a genuine same-scope replacement, it calls `nmg_remember` with `action=supersede`, `newMemoryId`, and `supersededMemoryId`.
- `NmgStore.recordFeedback({ supersede })` is a write-path maintenance method. With both IDs it applies full supersession; with only the stale ID it marks that record `disputed` because the replacement has not yet been written. The later new-value write can then surface it as a candidate.
- The daemon/MCP `recordFeedback` method is a different API: it consumes labeled automatic-recall feedback for the online learner and requires the named graph. Do not conflate it with `NmgStore.recordFeedback` or with `recordClaimOutcomes`.
- `evals/omnimemeval/bridge.ts` has an evaluation-only external-judge path. It drops candidates known not to be strictly older than the incoming event (unknown candidate or incoming times remain eligible), keeps only strong `transition`/`polarity` priorities, caps the judge set at three, and applies accepted results. This harness behavior does not make the core store call an LLM or establish that product callers use the same judge.

## Retrieval projection

A superseded result can act as a lexical/vector anchor for its version chain. Unless `includeHistorical` is true, final projection resolves the chain to an active successor, or for `eventTimeTo` queries to the value valid at that time. The resolved target can be materialized by stable ID even when its wording was absent from the original candidate pool. Multiple stale anchors resolving to the same target are deduplicated; its combined score is at least the best anchor's combined score plus `SUPERSEDE_SUCCESSOR_BOOST` (`0.3`), unless its own score is higher.

An orphaned stale record is not treated as a current answer. A historical/as-of query can still return the value that was current at that time, including when its later successor falls outside the requested window. `includeHistorical` explicitly bypasses successor substitution.

## Source references

See [`types.ts`](../../src/core/types.ts), [`writes.ts`](../../src/core/store/writes.ts), [`retrieval.ts`](../../src/core/store/retrieval.ts), [`graph-policy.ts`](../../src/core/store/graph-policy.ts), the [Pi remember surface](../../src/integration/agent-surface.ts), the [daemon supersede handler](../../src/cli/service.ts), and the [OmniMemEval judge bridge](../../evals/omnimemeval/bridge.ts). The separate [feedback-loop design](feedback-loop-design.md) owns broader feedback and evidence-source semantics.