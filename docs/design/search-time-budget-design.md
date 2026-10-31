# How a search spends its time

**Status:** draft
**Created:** 2026-10-31

This document owns the **mechanism** of a `/search` request's time: the phases, their
order, which phase owns which bound, and which invariants follow. It owns no numbers.
The reasons behind the design live in
[2026-10-30-search-is-a-read](../decisions/implemented/2026-10-30-search-is-a-read.md)
and
[2026-10-30-search-degrades-on-unreadable-partition](../decisions/implemented/2026-10-30-search-degrades-on-unreadable-partition.md);
incident attribution lives in `postmortem/`; the current value of every knob lives in
the code.

**A tuning change must not edit this file.** If an incident forces an edit here, the
mechanism changed — treat that as a design event, not a parameter update. This
document was written once, after a tuning round had been misread as a mechanism
change twice.

## The phases

| #   | phase                  | what bounds it                                                                                                                                           | owner                  |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | read the request body  | its own body deadline                                                                                                                                    | `readJson`             |
| 2   | read the user manifest | one object read, no dedicated bound                                                                                                                      | `readManifest`         |
| 3   | read partitions        | a gate evaluated **before each partition**; when it trips, the rest is skipped and the answer is marked partial                                          | `readSearchCandidates` |
| 3a  | one partition download | the object store's per-call timeout                                                                                                                      | `openPart`             |
| 4   | read the query vector  | an **independent clock** started when the embedding client is built (or, for a write, the write clock), plus a deadline the caller enforces on each call | `embeddingClient`      |

Two phases are not in this list because they are not bounded by us at all: the
platform's invocation ceiling, and the client's patience. Both are external facts, owned
by [edgeone-runtime-mechanism](edgeone-runtime-mechanism.md) and measured there.

## Invariants

These hold regardless of what the knobs are set to. Each one has been violated at least
once by a well-intentioned patch.

1. **No knob is a request bound.** Every bound above is scoped to a phase. The request's
   worst case is a composition, and it is always larger than any single knob — by
   construction, not by accident.
2. **The gate is before a partition, so one partition always runs.** A budget already
   exhausted still pays for the partition the gate has not yet seen. This is why a
   "tiny budget" does not make a request fast.
3. **A partition's cost is bounded by the download timeout, not by the remaining
   budget.** A slow partition spends its own bound and the gate learns about it
   afterwards.
4. **The embedding phase does not inherit the read phase's clock.** It starts its own,
   so the two phases add rather than nest.
5. **A short answer says it is short.** Whenever partitions were skipped — by the gate
   or by an unreadable object — the response carries `partial`, and an unreadable object
   also contributes `degraded: <code>`, the code of the first one.
6. **An error that is not a missing dependency propagates.** Only timeouts, resets,
   aborts and replaced snapshots degrade the answer; anything else stays a failure, so a
   bug remains visible.
7. **A write degrades and a read must too.** The write path commits an entry and defers
   the expensive part; the read path has no equivalent deferral, so its only graceful
   failure is a shorter page. A 5xx from `/search` costs a whole attempt.
8. **A cancel signal is not a bound.** Every dependency call carries a deadline enforced by
   the caller as well as whatever the transport does with the signal. The transport's own
   backstop is measured in minutes — undici's `headersTimeout` and `bodyTimeout` both
   default to 300 s, and its documentation does not promise exact firing — so a signal that
   fails to settle leaves nothing behind it but the platform killing the invocation. A
   dependency that ignores, defers or loses an abort must still cost a bounded amount of a
   request.
9. **A stage name is not evidence; its age is.** Any report that names a stage also carries
   how long that stage has been entered, and a request that ends records the stage it ended
   in. Without the age, "blocked in embedding for 58 s" and "entered embedding at 58 s" are
   the same log line, and a name that lags the code looks exactly like a name that is
   correct. This invariant exists because a wrong label is indistinguishable from a right
   one until the age is printed.

## Reading a log line without guessing

One line per request is always written, with the route, status, elapsed time and whether
SQLite was ready. A failure record adds the stage and a code.

| what you see                                        | what it rules in                                                                | what it rules out                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| no request line at all                              | the handler never finished — look at phase 1 and at the platform                | any phase above                                                          |
| a 200 whose elapsed time exceeds the smallest knob  | the gate released another partition, or the embedding phase spent its own clock | a single phase hitting one bound                                         |
| `stage` naming a download with a dependency timeout | phase 3a                                                                        | the embedding provider; its fields are absent from that record by design |
| `partial` / `degraded`                              | the answer was shortened, and why                                               | that the store was healthy                                               |

Two log fields are read as a contradiction when they are not, because their **scopes
differ**: the readiness flag is evaluated at the moment the line is written, while the
database high-water mark is the peak of the whole **container**. A request that loaded
nothing, inside a container that loaded something earlier, reports exactly that pair.

## Changing a bound

Start from the request, not from the phase. Compute the new composition from the
invariants above, state it, and then change the knob. A patch that lowers one phase
without recomputing the request is how a "25 s" claim and a much longer behaviour came
to coexist, and the cost of that divergence was an operator reading a correct log
correctly and reaching a wrong conclusion.

If the change requires editing this document, then the invariants no longer hold — say
which one broke and why, in a decision record, and let this text follow.
