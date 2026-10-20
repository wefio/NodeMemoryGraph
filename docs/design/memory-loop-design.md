# Memory loop: open structures and reuse

[English](memory-loop-design.md) | [简体中文](memory-loop-design.zh-CN.md) · [Terms](memory-loop-design.terms.yaml)

Source-audited design summary. This describes the current open-memory lifecycle where implementation exists; it does not claim that every proposed memory-loop effect has been measured in product use.

The loop is **Retain → Retrieve → Reuse → Revise**. Its central design concern is preserving unresolved structures so later work can reach and reconsider them. “Open” describes unresolved state, not low quality or low confidence; a resolved record is not thereby proven true.

## Open and resolved

The API field is `resolution`, with exactly `open`, `resolved`, and `reopened`. “Closed” is explanatory prose for the `resolved` value, not a separate enum. `resolution` is distinct from `MemoryRecord.status` (`active`, `disputed`, `inactive`, `superseded`, `deleted`) and from storage state (`indexed`, `dormant`, `quarantine`, `archived`).

An open or reopened record needs at least one `relatedMemoryId` pointing to an existing record in the same store. The store supplies `openedAt` when needed and records resolution transitions with their prior/next values, time, related IDs, and optional reason. Examples of structures a caller might keep open include unresolved contradictions, unanswered questions, failed approaches, provisional abstractions, and conclusions reopened by new evidence; these are authoring examples, not automatically inferred categories.

## Retain

Open records use the ordinary memory write path, but require an existing related-memory anchor. LTG retention selection includes only `resolution='resolved'`; while a record is unresolved, the storage-state API rejects transitions away from `indexed` to dormant, archived, or quarantine storage. STG expiration likewise selects only resolved records, so an `open` or `reopened` record is not expired by its `expiresAt` while unresolved.

This is an eligibility boundary, not a claim that open records are immortal: deletion, explicit state changes, session/store ownership, or other lifecycle operations remain separate. Resolve the structure before placing it in LTG archival or quarantine tiers.

## Retrieve

In the context retrieval path, NMG uses directly retrieved memory IDs as anchors and attaches at most two indexed `open`/`reopened` records whose `relatedMemoryIds` include one of those anchors. Attachment candidates must be active or disputed and must satisfy the source-actor/session visibility rules. They are ordered by importance and then `openedAt`, placed near the end of the normal result window, and remain subject to the ordinary evidence budget. They do not start an independent search cascade.

The information surface labels an open or reopened record `[open]`. The system makes a related unresolved item reachable; it does not decide that the item is important to the answer or that it should be resolved now.

## Reuse and revise

Reused open records are presented as context; the Agent or user decides whether to investigate or leave them unresolved. The explicit `resolve` and `reopen` operations change `resolution`; each non-idempotent transition appends an auditable resolution event. A non-resolved record must retain at least one existing related-memory anchor. Reopening a record outside indexed storage restores it to `indexed` storage before it can re-enter the retrieval neighborhood.

A resolved record becomes eligible for ordinary retention checks, which still apply their own residence, type, importance, access, evidence-role, and age conditions. Supersession is a separate same-scope value-replacement relation; see [supersession design](supersession-design.md). Feedback and claim evidence have separate contracts in the [feedback-loop design](feedback-loop-design.md).

## Implementation status from source review

The repository implements the following parts of this lifecycle:

1. `remember()` and `setMemoryResolution()` validate related-memory IDs and require an anchor for `open`/`reopened` resolution.
2. LTG retention and STG expiry select only resolved records; archival and quarantine reject unresolved records.
3. Context retrieval attaches at most two related open structures within the regular result window and evidence budget.
4. `resolve`/`reopen` are exposed through the CLI, daemon, and Pi memory surface; transition events retain the old/new resolution and supplied reason.

These are source observations, not a claim that tests were executed in this documentation pass or that the loop improves answer quality. See the [theoretical analogies](memory-loop-design/theoretical-analogies.md) for the design's cited conceptual comparisons and their evidence limits.

## Source references

See [`MemoryResolution`](../../src/core/types.ts), [write validation](../../src/core/store/writes.ts), [retention and resolution transitions](../../src/core/store/maintenance.ts), [context retrieval attachments](../../src/core/store/retrieval.ts), [CLI commands](../../src/cli/commands.ts), [daemon service](../../src/cli/service.ts), and [Pi information rendering](../../src/integration/agent-surface.ts). Relevant test owners include [`retention.test.ts`](../../tests/core/store/retention.test.ts), [`retrieval.test.ts`](../../tests/core/store/retrieval.test.ts), and [`stg-v2.test.ts`](../../tests/core/stg-v2.test.ts).