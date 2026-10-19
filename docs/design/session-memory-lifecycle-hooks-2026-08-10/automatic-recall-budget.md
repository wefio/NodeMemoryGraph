# Automatic recall waiting budget

[中文](automatic-recall-budget.zh-CN.md) · [Terms used](automatic-recall-budget.terms.yaml)

**Status:** current

**Authority:** [Deadline decision](../../decisions/implemented/2026-10-02-automatic-recall-has-a-deadline.md) and [shared budget implementation](../../../src/integration/recall-budget.ts).

## Budget and completed results

When Pi automatic pre-turn context preparation runs, the whole `before_agent_start` preparation shares one absolute five-second deadline, not five seconds per RPC. Completed search candidates form a checkpoint. Later disclosure, reranking or telemetry expiry must not discard timely candidates, and search data arriving after the deadline is not injected.

Completed typed items still pass through the same information-view admission protocol. Timeout does not restore a raw-header fallback or write disclosure history. Attribution uses only memory IDs admitted into the final output.

Daemon automatic search uses the caller's remaining budget, capped at 4.5 seconds. Project and shared-store query embeddings share that deadline; expiry retains lexical results and a degradation reason. This automatic deadline does not bound explicit `nmg_search`.

## Cancellation and diagnostics

Supported HTTP requests abort together with response-body reading. The asynchronous deadline cannot preempt synchronous JavaScript/SQLite, and cancellation of an issued provider request does not guarantee remote cancellation.

Stage names, durations and completion/timeout states live in message `details.recallTiming`, not candidate DTOs. Pi `/nmg recall timing` reads the latest round without recording raw prompts or credentials.

WorkBuddy recall uses the same budget primitive for hello, search and disclosure. Its identity registration and wake polling are outside that function's budget. First-output observation remains a separate opt-in feature; a waiting deadline is not a first-visible-output measurement.
