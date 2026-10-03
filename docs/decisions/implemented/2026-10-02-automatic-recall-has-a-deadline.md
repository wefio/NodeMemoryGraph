# Automatic recall has a deadline

[中文](2026-10-02-automatic-recall-has-a-deadline.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Session memory hooks](../../design/session-memory-lifecycle-hooks-2026-08-10.md)

## Problem

Automatic recall is on the user's critical path. Several individually awaited operations can accumulate unbounded latency: connection/search, query embedding, session disclosure and optional controller work. A per-request timeout does not bound the whole hook. Discarding every result on a later timeout also loses candidates returned promptly.

## Decision

The user selected a five-second total waiting budget. One shared absolute `RecallBudget` covers the Pi pre-agent context hook, including its optional preparation, and WorkBuddy's automatic recall pipeline. Stages receive the same abort signal; a new RPC does not reset the budget. HTTP cancellation includes response-body consumption, and an aborted call does not trigger reconnect.

Completed search headers form a fallback checkpoint before optional reranking, disclosure and telemetry. On deadline, the adapter returns already available context and ignores late data. If search itself has not returned, no candidates from its later response are injected. Best-effort disclosure may repeat headers when the disclosure ledger misses the deadline.

The daemon's automatic search receives the remaining hook budget, capped at 4.5 seconds to leave time for transport and rendering. Query embedding uses that shared search deadline across local and shared stores. On expiry, lexical results remain available and the result names `automatic_recall_embedding_deadline`; this is not a provider-health diagnosis. Explicit searches do not inherit the automatic deadline.

Pi records phase durations and outcomes in message `details.recallTiming`. `/nmg recall timing` displays the latest timing without recording prompts or credentials. The normative hook contract is in [session memory hooks](../../design/session-memory-lifecycle-hooks-2026-08-10.md#自动召回等待预算).

## Alternatives considered

- **Five seconds per RPC.** Rejected: serial stages can still make the total much longer.
- **Discard all recall on any timeout.** Rejected: it loses timely search results because of optional later work.
- **Disable semantic recall.** Rejected: prompt semantic results still remain usable; only over-budget waiting is abandoned.
- **Only optimize one suspected stage.** Insufficient: no natural slow-turn measurement establishes a single cause, and other stages can still stall.

## Consequences

Latency protection trades late semantic information for a timely turn. Cancellation stops waiting and aborts supported HTTP operations; it cannot preempt synchronous JavaScript/SQLite work or guarantee that an embedding provider cancels a request already in flight. Late provider data cannot replace the returned graph. There are no new live-provider calls or benchmark requirements in the regression tests.

The deterministic [hook regressions](../../../tests/extensions/nmg/recall-budget.test.ts) drive the actual Pi handler with slow search/disclosure, and the [shared regressions](../../../tests/integration/recall-budget.test.ts) verify lexical preservation, late-vector isolation and explicit-search behavior.

## Deferred

The cause of the user's naturally slow turns is not established by synthetic delays. Phase timings supply evidence for later diagnosis. WorkBuddy presence registration and board-wake polling are separate from its recall function; this record does not claim a five-second ceiling for every hook activity.
