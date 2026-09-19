# A running sweep makes the tree unreadable, and evidence has no third state

[中文](2026-09-19-sweep-and-evidence-rules.zh-CN.md)

**Status:** implemented
**Approved:** explicit
**Relates to:** [post-mortem 0003](../../postmortem/0003-checks-read-a-live-mutant.md), [post-mortem 0004](../../postmortem/0004-flaky-was-a-clock-boundary.md)

## Problem

Two failure classes from this branch could not be closed by the mechanisms that already existed.

1. **A check can read a mutant.** A mutation sweep substitutes a named wrong version into a target file
   and restores it afterwards; between those writes the file on disk *is* the mutant. `lint` and
   `complexity:gate` run in that window reported on the mutant, and a check that *passes* there is
   evidence about code that never existed. The rule that covered this named only writes ("do not edit or
   stage a file a sweep is rewriting"), which is the side the sweep's own process controls - a check only
   reads, so the rule never fired. The same class then escaped a second time when a killed sweep left its
   mutant in the tree and the next sweep inherited it as its baseline.
2. **A label can close a question.** `test:product` failed once under load, was recorded in the ledger as
   "flaky, not fixed", and stayed unexamined for a session. It was a real product defect (a 1-2 ms
   disagreement between JavaScript's `Date` and SQLite's `now` at the current-value boundary), found only
   when the label was refused.

The mechanism of (1) has a mechanical guardrail now (the lock, the refusal). What remains for both is
session behaviour that no check can decide: how a reader treats a tree while a sweep holds it, and what a
ledger row is allowed to say about a failure that could not be reproduced.

## Decision

Three rules land in `skills/repo-development/SKILL.md`, which already owns this workflow:

- **A running sweep makes the tree unreadable, not only unwritable.** The lock is the signal
  (`tools/mutation-lock.ts`), `npm run agent:verify` refuses while it is held, and `npm run agent:context`
  prints it. A reader never re-derives this from memory.
- **Evidence has no third state.** An intermittent failure is recorded with its reproduction attempt and
  rate, or left open - never as "flaky", which is a label that closes a question nobody answered.
- **Progress signals differ per lane, and are not interchangeable.** A test lane streams TAP; a sweep
  writes its summary only at the end, so its live signal is the lock's `target` (which moves as it takes
  each target) plus the target file's mtime.

## Alternatives considered

- **Leave all three as prose inside the two post-mortems.** Rejected: the promotion rule in
  `docs/postmortem/README.md` says a class whose guardrail is the record's own prose is not caught, and
  class (1) had already escaped twice - the trigger for promotion.
- **Write a check for the label ban** (fail a ledger row that says "flaky" without a reproduction).
  Rejected as over-fitted: the word is legitimate in the sentence that records why it was wrong, and the
  rule it would enforce is a judgement about what a failure *meant*, not about a string.
- **Make the harness print a line per target or per mutant** so the old Skill claim ("one log line per
  mutant") became true. Not rejected but deferred, and the decision does not depend on it: the lock
  already answers "is it alive and where" without a new output contract, and a harness change is its own
  slice.
- **Put the rules in `AGENTS.md`** (the other home the promotion table allows). Rejected: the owning
  document for this workflow is the repo-development Skill, and the rules are about how to run its lanes.

## Consequences

- The mechanical half is carried by code and is pinned: `tools/mutation-lock.ts`, the refusal in
  `tools/agent-verify.ts`, the warning lines in `tools/repo-context.ts`, and
  `tests/tools/mutation-lock.test.ts` (including a case that runs a real sweep and asserts a substituted
  mutant is reported `live: true`).
- The judgement half is carried by the Skill, so a session that reads it cannot conclude "the sweep
  prints nothing, so it is wedged" - and cannot close a failure by naming it.
- A ledger row can no longer end a question with a label: the row that said "flaky, not fixed" now
  carries the reproduction rate and the fixed defect, and its earlier wording was wrong in a way a
  reader can see.
- These rules were written into the Skill before this record, which the approval tier
  ([2026-09-09](2026-09-09-approval-tiers.md)) requires to be explicit. The operator approved them on
  2026-09-19 in the same session that produced them; this record is that approval, and the ordering
  mistake is stated rather than hidden.
