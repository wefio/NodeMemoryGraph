# Automatic recall waiting budget

[中文](automatic-recall-budget.zh-CN.md) · [Terms used](automatic-recall-budget.terms.yaml)

**Status:** current

**Authority:** [Deadline decision](../../decisions/implemented/2026-10-02-automatic-recall-has-a-deadline.md) and [shared budget implementation](../../../src/integration/recall-budget.ts).

## Budget and completed results

When Pi automatic pre-turn context preparation runs, the whole `before_agent_start` preparation shares one absolute five-second deadline, not five seconds per RPC. Completed search candidates form a checkpoint. Later optional work, reranking or telemetry expiry must not discard timely candidates, and search data arriving after the deadline is not injected.

Completed typed items still pass through the same information-view admission protocol. Timeout does not restore a raw-header fallback or write disclosure history. Attribution uses only memory IDs admitted into the final output.

Daemon automatic search uses the caller's remaining budget. Unified local memory
caps query embedding at 850 milliseconds. The legacy path caps it at 4.5 seconds.
Project and shared-store query embeddings share the deadline. On expiry, lexical
results remain available. Explicit `nmg_search` uses the provider timeout.

## Cancellation and diagnostics

Agent-facing search results retain `automatic_recall_embedding_deadline` when
query embedding exceeds the automatic recall budget. The reason contains only
the stable code.

Supported HTTP requests abort together with response-body reading. The asynchronous deadline cannot preempt synchronous JavaScript/SQLite, and cancellation of an issued provider request does not guarantee remote cancellation.

Stage names, durations and completion/timeout states live in message `details.recallTiming`, not candidate DTOs. Pi `/nmg recall timing` reads the latest round without recording raw prompts or credentials.

WorkBuddy recall uses the same budget primitive for hello, turn admission and search. Its identity registration and wake polling are outside that function's budget. OpenCode and DSH use the same primitive with their tighter 1.5-second automatic-preparation limit. They reject late preparations instead of allowing a completed timeout race to publish later. Pi cancellation, replacement and session switching suppress even timely partial context; deadline expiry alone preserves it. First-output observation remains a separate opt-in feature; a waiting deadline is not a first-visible-output measurement.
