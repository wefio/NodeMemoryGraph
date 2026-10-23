# Refuse an unbounded process position at the write boundary

[简体中文](2026-10-23-coordination-state-write-guard.zh-CN.md) · [Terms](2026-10-23-coordination-state-write-guard.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Mechanism, not policy](2026-09-21-mechanism-not-policy.md)

## Problem

`assessMemoryWrite` refused secrets, explicit "do not retain" instructions, and a
short transient-word list (`temporarily`, `for this session only`). Every refusal
there is a wording check, and the boundary's own comment says the harness owns
the invariants while semantic usefulness stays the model's job.

A different class slipped through: a claim about the live position of an ongoing
process — "local main is 16 commits ahead of origin/main and unpushed, wait for
the PR", "the next step is to re-run the gate". Its wording contains no transient
marker, so it was admitted with an unbounded lifetime. It is true when written
and false the next day, it duplicates a live source (`git log`), and it displaces
nothing: nothing in the record says it stopped being true. Stale durable memory
that reads as current is worse than absent memory, because a later session has no
reason to doubt it.

The transient-word list cannot cover this: the defect is not the word "temporary"
but the absence of a bound.

## Decision

A coordination-state statement is refused unless the caller states when it stops
being true.

- New assessment reason `coordination_state`, matched by a narrow pattern set:
  `unpushed`/`unmerged`/`uncommitted`, `not yet pushed|merged`, `pending review|merge|push|approval`,
  `next step`, `N commits ahead of origin`, `waiting/blocked on … to land|merge`,
  and the Chinese counterparts (未推送、尚未合并、待办/待定/待审、下一步、领先 origin、等…落地后再).
- The escape hatch for this rule is `expiresAt`, not `bypass`: naming the end of
  the claim is the information an unbounded record lacks. `bypass` still overrides,
  because the explicit unsafe hatch must stay unconditional to remain auditable.
- `memoryType: "event"` is exempt, as it already was for the transient-word rule:
  an event records a dated occurrence, not a live position.
- A bare verb is never matched. "Merges require a green gate", "the release order
  is staging then production" and other durable rules that merely mention process
  vocabulary stay admitted; the pattern set keys on present-tense position phrases.

The agent policy text now names the class as well, so the rule is stated where a
caller reads it and enforced where it cannot be argued with.

## Alternatives considered

- Extend the transient-word list with `pending`, `waiting`, `next`: too broad.
  "Waiting is the failure mode of a retry loop" would be refused.
- Make the model classify durability and reject on its judgment: that is the
  responsibility the boundary exists to keep out of the model's hands.
- Reject instead of requiring an expiry: no legitimate path, and a caller with a
  genuinely bounded position would rephrase to dodge the check.
- Accept and rely on decay/retrieval ranking to age the record: decay shortens a
  lifetime, it does not bound a claim the caller never bounded.

## Consequences

Writing a snapshot of ongoing work now fails with a reason that names the fix:
give it an expiry, or put it in working state. The refusal is recorded through
the existing rejected-write path, so the frequency of this class is observable
rather than anecdotal.

The pattern set is a heuristic and will have both false negatives (a position
phrased without any process vocabulary) and, in principle, false positives (a
durable rule that happens to read as a position); `bypass` remains the audited
path for the latter. This record does not claim the boundary now catches every
transient write — only that one identifiable class can no longer be stored
without a stated end.
