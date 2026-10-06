# First-response timing is opt-in

[中文](2026-10-04-first-response-timing-is-opt-in.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Recall deadline](2026-10-02-automatic-recall-has-a-deadline.md), [Session hooks](../../design/session-memory-lifecycle-hooks-2026-08-10.md)

## Problem

The symptom is intermittent waiting before the first visible response during ordinary use, with compaction excluded. Whole-task duration and a completed assistant message's timestamp do not measure that interval. Pi constructs the persisted user message after preparation, and persists an assistant after generation and message-end handlers. Existing records therefore cannot separate preparation from the first streamed output.

## Decision

The user approved preparing a minimal observer in the isolated worktree, not activating it. `/nmg-latency on|off|status` explicitly controls capture; it defaults off and resets on session replacement, branch navigation or reload. The shared timing primitive owns identities, monotonic elapsed time, first-only phases, exclusions, outcomes and safe sink failure. The Pi binding only observes native lifecycle events and appends metadata-only custom entries outside model context.

The user selected slow input-to-recall retention rather than persisting every observed input. Filtering belongs to the persistence sink, not the first-only clock: a retained trace includes its earlier short boundaries. The normative retention threshold, event, privacy and interpretation contract is in [session hooks](../../design/session-memory-lifecycle-hooks-2026-08-10.md#首次输出计时). The observation does not change recall deadlines, model settings, daemon lifecycle or provider request volume. It does not claim that a host event timestamp is client-visible TTFT.

## Alternatives considered

- **Use whole-turn duration or attribute the wait to compaction.** Rejected: neither matches the clarified symptom; compaction-bearing traces are excluded.
- **Infer the first response from assistant persistence.** Rejected: a response can stream earlier, and the timestamp omits preparation.
- **Log prompts, provider frames and request bodies.** Rejected: raw content is unnecessary for boundary timing and creates privacy and storage risks.
- **Always-on capture or probe requests.** Rejected: the investigation is opt-in, and natural traffic supplies the observations without additional model/embedding calls.
- **Only time Core retrieval.** Insufficient: it omits preparation, transport, model output and the host's event boundary.
- **Persist every input or filter individual short marks.** Rejected: fast inputs add unwanted log volume; dropping short marks loses the start and prevents reconstructing a slow preparation.

## Consequences

Each observed input has bounded first-only metadata events. Until recall completion, its events remain in memory; only a qualifying trace is persisted with its full boundary sequence. An unfinished trace remains visible in status without inventing a completion; closing or resetting it discards the undecided buffer. Retained samples are selected for slow preparation and do not establish the full latency distribution. Any compaction attempt or queued/steered input excludes the trace from ordinary-input comparison. Failed attempts remain visible across retry; settlement closes the trace. Missing boundaries remain missing. A sink failure disables observation, exposes failure in status and does not interrupt the conversation.

The [primitive tests](../../../tests/integration/first-response-timing.test.ts) verify time identity, exclusions, late-event isolation and failure handling. The [Pi binding tests](../../../tests/extensions/nmg/first-response-timing.test.ts) verify explicit activation, host boundary mapping, privacy, retry and reset without provider calls.

## Deferred

Loading or enabling the observer in the current runtime requires separate confirmation. No natural normal/anomalous pair, frontend send/render timestamps or cause attribution is established by the deterministic tests. Host events cannot by themselves distinguish exact network-send time, provider queueing or UI rendering; those remain later boundaries if the first sample points there.
