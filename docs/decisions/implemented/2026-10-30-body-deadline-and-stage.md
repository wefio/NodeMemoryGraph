# A stalled request body cannot hold an invocation, and slow reports name their stage

[简体中文](2026-10-30-body-deadline-and-stage.zh-CN.md) · [Terms](2026-10-30-body-deadline-and-stage.terms.yaml)

**Status:** implemented
**Approved:** explicit

## Problem

The 19:34-19:50 window has twelve kills at the 120 s ceiling, and they split on memory:

| group | memory                   | rows                   | reading                                                                                                         |
| ----- | ------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| X     | 601-667 MB               | 7, inside 153 s        | business logic ran; the embedding chain (already addressed by the per-invocation breaker and the fold deadline) |
| Y     | **51.3359 MB, constant** | 5, spread over 9.4 min | memory never moved - the invocation was still waiting for its **request body**                                  |

`readJson` awaited `reader.read()` with **no deadline of its own**. A client that stops
uploading halfway (or an edge that holds the connection) therefore occupies the entire invocation
budget, allocates nothing, and is killed at 120 s with no trace of what it wanted. The platform's own
per-invocation memory figure is the only fingerprint, and it says "nothing ever happened".

The second problem is diagnostic: every 120 s kill so far needed a code read to say where it was.
The 60 s slow report carries memory, queue state and the last embedding call, but not the stage the
isolate is sitting in.

## Decision

- `readJson(request, env)` gives the body `BODY_TIMEOUT_MS` (30 s, `NMG_BODY_TIMEOUT_MS`), cancels
  the stream and answers `408 request_body_timeout`. Thirty seconds is generous for the 6 MiB limit
  and leaves most of the invocation for the work the body asked for.
- `diagnostics.mjs` tracks `activeStage`: the name of the measured stage currently executing, set
  and restored around `measure`/`measureSync`, exposed as `currentStage()`. The slow-request line
  reports it as `stage_isolate`.

## Evidence

| before                                                     | after                                                                             |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 5 rows at 120 s with memory frozen at the runtime baseline | the body read fails at 30 s with `408 request_body_timeout` and a stage of `null` |
| a 120 s kill names only memory and the last embedding call | the 60 s self-report names the stage the isolate was inside                       |

## What this does and does not establish

- It does not prove those five rows were stalled uploads. Memory that never moves is consistent with
  it, not proof: an edge-side wait that never reaches the handler would look the same and would leave
  **no** `nmg_request` line at all. The stage field plus the absence of a request line is what
  distinguishes the two next window.
- The X group is untouched here. Its mechanism (embedding timeouts, single-instance serialization)
  is documented in `2026-10-30-embedding-breaker` and `postmortem/0006`; the remaining lever there
  is the provider and the harness concurrency.
- `stage_isolate` is exact on this platform (fresh isolate per request) and approximate if an isolate
  is ever reused for concurrent requests, which is why the field names the isolate rather than the
  request.

## Alternatives considered

- **Rely on the platform's 120 s kill.** That is what happens today: a stalled body turns one
  request into a full-budget orphan and tells us nothing.
- **Read the body with a `Promise.race` timeout instead of a deadline check.** A race leaves the
  reader pumping into a dead promise; checking before each read and cancelling the stream is the
  version that actually releases the connection.
- **Infer the X/Y groups from memory alone.** Memory is a fingerprint, not evidence: a request that
  is killed during its first provider call and one killed while waiting for a body differ by more
  than a number, which is why the stage field is part of this change.

## Consequences

- A stalled upload now costs 30 s and returns a clear 408 instead of consuming the invocation.
- Log lines gain one string per slow request; nothing per ordinary request changes.
- The next 120 s window is diagnosable: `stage_isolate` says what the isolate was doing, and a
  missing `nmg_request` line says the request never reached us at all.
