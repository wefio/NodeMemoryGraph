# MAST failure-mode annotations for the OoO research probes

[English](mast-coverage-2026-09-12.md) | [简体中文](mast-coverage-2026-09-12.zh-CN.md) · [Terms](mast-coverage-2026-09-12.terms.yaml)

**Related:** [design](../../design/ooo-execution-bootstrap.md) ·
[wait value](wait-value-2026-09-12.md) ·
[admission run](../ooo-admission-2026-09-08.md) ·
[MAST taxonomy](https://arxiv.org/abs/2503.13657)

Observed 2026-09-12, zero model tokens: this is an annotation of evidence that already exists, not a
new run. It was requested after the value question moved from wall clock to failure-mode incidence.

## Evidence base

This is the historical research-driver assessment, not the product Task Board
contract or a measured reduction in natural failure incidence. The cited log,
mutant counts, suite counts and source-size/title counts are reported historical
observations, not artifacts reopened or tests rerun by this review. The
[admission report](../ooo-admission-2026-09-08.md#question-and-scope) owns the
probe boundary; its retired round instrument does not define current defaults.
External MAST and code-RL statements below were not reverified online.

- Seven live rounds and three promotions (`docs/experiments/ooo-admission-2026-09-08.md`), the
  round-7 log (`.nmg/ooo-live/round.jsonl`: 23 events, 10 declared mutants, 9 survived, 1 killed, no
  reopen, no pushback, no worker failure), `.nmg/ooo-live/rejections.json`, two real replays with no
  model calls, and the cancellation/multi-process suites.
- The record cites MAST (arXiv 2503.13657) as: 14 failure modes in three categories, from 200
  conversation traces across seven open-source frameworks. Per-category percentages could not be
  retrieved in the original review (it reported no such figures on the project
  page/arXiv HTML); that is not a fresh survey or proof they are absent today.
  No frequency is quoted here.
- MAST's traces are conversational planner/worker/reviewer systems, so its dialogue-level modes do
  not map directly to this fixed-envelope, non-dialogue research path. That is
  the annotation's scope, not a claim that all Task Board users have no dialogue.

## Annotation

The labels below classify the cited mechanism/evidence, not observed prevention
rates. In particular, `blocked` is a scoped guard claim, not full behavioral
conformance, OS isolation or evidence that a natural violation was refused.

| MAST mode                             | Verdict                           | Mechanism and evidence pointer                                                                                                                                                                                                                                                                    |
| ------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 disobey task specification        | blocked                           | Digest-bound envelope carrying editable/visible sets, admitted conclusions, case rules, budgets. A hand-written conclusion without the `kind` discriminator is refused as `invalid patch structure`.                                                                                              |
| 1.2 disobey role specification        | blocked (mechanism)               | A worker is never an approver; only the host accepts. Multi-process and cancellation suites. **No sample**: the cited round record contains no such worker attempt.                                                                                                                                      |
| 1.3 step repetition                   | blocked, with a counterfactual    | Attempt/fencing generations; "reissue fences old execution". The mutant `reopen-keeps-attempt` (reopen without advancing the generation) survived the baseline and was killed by the round-6 candidate.                                                                                           |
| 1.4 loss of conversation history      | not applicable                    | This probe path models no peer dialogue; task context is in its frozen envelope.                                                                                                                                                                                                                                         |
| 1.5 unaware of termination conditions | blocked                           | `cancel(reason)`, `abandonCheck`, `cancelled`, a check that never reports terminating as `undecidable`, and refusal to dispatch on an unmeasured premise — `rejections.json` holds two records reading "B not dispatched: B's declared fault could not be measured". `recovery.test.ts`, 8 tests. |
| 2.1 conversation reset                | not applicable                    | No peer-dialogue reset is modeled in this probe path.                                                                                                                                                                                                                                                                               |
| 2.2 fail to ask for clarification     | partial                           | A `cannot-complete` exit exists; this fixed protocol has no typed clarification channel, distinct from broader board coordination.                                                                                                                                                                                                                               |
| 2.3 task derailment                   | partial (no sample)               | Editable/visible sets, budgets and limits refuse out-of-scope edits (S0 negative cases). Zero recorded samples.                                                                                                                                                                                   |
| 2.4 information withholding           | partial, machine-side only        | The serial actionable-entry slot: a stale, unclaimed handoff held it and blocked every later claim (fixed in PR #45). No worker-side mechanism.                                                                                                                                                   |
| 2.5 ignoring peer input               | partial                           | Composition consumes accepted artifacts of A and B; this composition path has no direct A/B peer-dialogue channel.                                                                                                                                                                                                                     |
| 2.6 action-reasoning mismatch         | blocked (mechanism)               | Conclusions must carry citations that resolve against frozen sources, with case-and-token rules; `check-events.test.ts` (10,752 B, 17 titles). **No sample**: round 7 recorded zero rejections.                                                                                                   |
| 3.1 premature termination             | blocked                           | Successful reported completion is refused when the premise is unmeasured (`premise-unmeasured` stops that branch), and composition verification must complete first. Origin: a round that spent 204,164 tokens on an already-false premise produced the premise-before-dispatch rule.                                                                 |
| 3.2 weak verification                 | partial — exposed, not eliminated | The mutation matrix turns "can the acceptance rule kill this fault" into a mechanical judgement. Round 7 left 9 of 10 mutants surviving; after the promotion re-measurement 2 were killed and 5 still survive.                                                                                    |
| 3.3 no or incorrect verification      | blocked                           | The host is the only acceptance authority and the text channel passes the same envelope; one of the four S3 defects was text answers being recorded raw, so the host could only refuse them after paying.                                                                                         |

Tally: 7 blocked, 5 partial, 2 not applicable — counts of annotation labels,
not blocked incidents or independent trials.

Row 3.2 retains 9/10 survivors and later 2 killed / 5 surviving. The population
linkage is unspecified: if 2 were removed from those 9, 7 would remain, not 5.
This record does not establish that matching-population interpretation or resolve
the difference; do not infer extra kills, exclusions or an improvement rate.

## Outside the taxonomy, and the attribution correction

Peer occupancy, staging-boundary friction and communication do not appear in MAST, and one day of
three-agent work produced a real sample: six files belonging to another agent were present in my
diff; a mid-session `git checkout` moved the shared worktree onto another branch; local `main` was
stale (`df7456cd` against `8a099905`); two blob surgeries and three temporary worktrees were used to
avoid touching others' uncommitted work; and another agent used the board channel to negotiate the
staging boundary for `docs/design/design.md`.

That sample was initially reported here as a gap in what the design covers. **That was wrong.** The
friction happened outside any round: the plan assigns disjoint editable sets per task, the host is
the only writer and works in disposable candidate worktrees, and handoffs and claims are published
on the board, which is the communication channel. Within the cited admitted research path, that exclusion depends on disjoint
editable sets, one authoritative writer and isolated candidate worktrees. It is
not an OS sandbox or a guarantee against external writers or other coordinators. Two honest remnants: communication existed and was unused by me rather than absent
(another agent did negotiate a staging boundary on the board), and one boundary is genuinely
unprotected — **promotion**, where an accepted candidate leaves the disposable worktree for the
shared tree (the two blob surgeries are exactly that case), plus between-round windows, where two
coordinators or a long-lived uncommitted file sit outside any plan.

The original review could not derive a collision rate from the inspected history: one commit identity,
squash-merges leaving branches reported as unmerged, and rebase replays inflated two attempts by
orders of magnitude (785 files / 151,759 events, then 472 / 1,406, both dominated by my own stacked
history). Instrumentation was reported absent at that checkpoint; this is not a new
repository-wide instrumentation audit.

## Not established

- Mechanical guards and constructed negatives do not establish natural prevention
  rates. In particular, 1.2, 2.3 and 2.6 have no cited live violation to refuse.
- The record treats 3.2 as its sharpest weakness and cites an external observation:
  28.5 % of tasks in a code-RL environment had test suites weak enough that a Docker-verified wrong
  patch passed. That different task population/denominator is not quantitative
  corroboration or a transferable rate for this probe.
- Whether the 12 modes that do apply to a task-board design are the ones that actually occur in
  multi-session agent work is unmeasured. The cited multi-process fixtures used
  scripted actors in separately launched processes, not independent model-driven
  participants; process separation is real but is not behavioral independence.
