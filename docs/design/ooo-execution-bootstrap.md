# Bootstrapping constrained OoO development

[中文](ooo-execution-bootstrap.zh-CN.md) · [Terms used](ooo-execution-bootstrap.terms.yaml)

**Status:** draft

**Updated:** 2026-09-18
**Related:** [Rationale](../decisions/implemented/2026-09-09-ooo-bootstrap.md), [admission experiment](../experiments/ooo-admission-2026-09-08.md)

> **Update, 2026-09-18:** The round instrument (`round-cli.ts`, `round-runner.ts`, `round-spec.ts`, `round-compare.ts`, `ooo-round-log.ts`, `src/integration/ooo-cycle.ts`) has been retired. The research entry point is now the experiment-arm driver `evals/ooo-execution/plan-driver.ts` ([decision](../decisions/implemented/2026-09-18-retire-the-round-instrument.md)). The S3/S4 rows and S2 note below remain as historical records.

## Goal and scope

Use out-of-order execution to develop out-of-order execution: let real tasks choose the next capability instead of building a scheduler first. This draft defines candidate contracts and phase acceptance; it does not claim runtime support. Experiment records own implementation evidence. Phase order is a dependency plan, not progress; the Task Board owns active work and blockers.

The first version keeps fixed order, explicit dependencies, at most one waiting and one executing task, no preemption, and no automatic replanning. Only host-side, token-free speculation is allowed (see the speculation break-even decision); guessing to hide a wait is forbidden. Only real external waits permit skipping the queue head. Stale input, dependency failure, or insufficient permission does not. With no independent task, run sequentially; do not add sleeps or artificial delays to manufacture out-of-order behavior.

The shared layer owns host-independent plans, selection, task versions, and acceptance state; the board owns cross-process handoff. Pi owns the model loop, tools, and execution process; adapters stay thin. This work will not build a general-purpose shell, sandbox, or Agent harness.

## Minimal bootstrap boundary

A single ordinary bootstrap may add only the three capabilities below, then must enter a real round. Existing exact-snapshot tasks cannot directly produce development patches.

1. Bind the input to frozen source, an explicit file set, and the task description. A Pi worker returns a size-bounded patch artifact and does not edit the shared workspace. Extend the constrained development-task contract; do not disguise it as an existing heading/join operation.
2. The host starts an explicitly permitted background check and reports its start identity, terminal state, and bounded logs as an external event. Once the task waits, it releases its execution claim; the waiting check process is not a second Agent executor. The worker gets no arbitrary-command permission.
3. The host validates the patch in a separate candidate directory against a check fixed in advance, returning accept, reject, or undecidable. Only acceptance unlocks dependencies. At first, an operator may approve application and promotion; a complete CLI is not a prerequisite.

Reuse the existing board, coordinator, and Pi SDK boundary; moving all experiment code is not a prerequisite. Put only the minimum bootstrap protocol in the shared layer; the research launcher may remain. Hidden-entry changes follow the [registry](hidden-features-registry.md); this document adds no switch.

Outside the round boundary, generate and validate a candidate patch in a one-shot worktree; the worker never touches the shared workspace, so construction excludes in-round contention and communication problems. **Promotion** (applying an accepted candidate to the shared tree) and inter-round time are unprotected; the host must protect them if needed.

Exit checks: a real Pi worker patches frozen OoO source; validation runs only in the specified candidate directory; a background check yields a real exit event; stale inputs and incorrect attempts are rejected. Until then, report “bootstrap,” not “self-bootstrap.”

## First real development task

Prefer “background-check identity and failure recovery” as the development request. Freeze the interface and check command first, then fix plan A, B, and C:

| Task | Input and responsibility | Dependencies and permitted output |
| --- | --- | --- |
| A | Wait for the real bootstrap-integration check; use its result to fix check identity, exit handling, or an exposed defect. If there is no defect, return an evidence-backed no-change conclusion. | External check event; patch or conclusion limited to the named implementation files |
| B | Against the same frozen interface, add missing regression checks for stale events, duplicate events, and late results after cancellation; first check whether coverage already exists. | Does not depend on A's logs or patch; patch limited to named test files or a conclusion that no test needs adding |
| C | Compose-check the accepted A/B artifacts and create a candidate suitable for promotion. | Depends on A and B; combined patch and verification evidence |

If the interface cannot be frozen in advance, resolve the interface first and do not call B independent. B must not use an unaccepted A artifact, and A must not silently change a contract to which B is bound. If the interface must change, invalidate affected artifacts, end the round, and explicitly create a new plan.

The expected sequence is A waits for a check, B runs past A, A consumes the check result, and C verifies the composition. If the check finishes before B is selected, the round is sequential; if it finishes while B runs, do not preempt B. Preserve either real timeline; do not force a B→A→C sequence.

The first round need not invent a bug, but any patch or no-change conclusion needs checkable evidence. “Development self-bootstrap complete” requires a useful OoO change produced by this chain, independently accepted, and used next round. A title-only task, simulated worker, or no-change demonstration does not qualify.

## Contracts that must be checkable

### Checkable evidence for a conclusion

No-change is not a conclusion that can stand on narrative alone. Before a round, the host freezes a list of cases each task must cover. Each case is an explicit declaration: a case name and, on the patch path, tokens that a new test title must contain. Print that list verbatim in the worker's instructions; there are no undisclosed acceptance rules.

- A no-change conclusion must cite cases by name. The host parses the frozen source to check whether each title exists. Reject nonexistent references, title mismatches, missing cases, and invented cases.
- On the patch path, parse by tokens: each new test title must contain the corresponding tokens.
- “Cannot complete” is a blocker report, not completion: it prevents successor tasks from unlocking and does not release dependencies.

Title parsing proves only that a test with a matching title exists; it does not prove the test asserts the case. The mechanical criterion already used in this field is mutation testing: retain a new test only if it passes on the original implementation and fails on at least one surviving mutant (the retention rule in [Mutation-Guided LLM-based Test Generation](https://arxiv.org/abs/2604.01518v1)); this filters out both hollow and duplicate tests. To establish that a case is uncovered, use that criterion rather than title matching: first demonstrate with mutation that “breaking this behavior still leaves the frozen checks green,” then give the proven gap to a repair task.

A worker failure, timeout, or truncated output is not completion. Record it as a failed attempt with its reason; do not retry automatically or unlock successors. Pre-fill the worker's format contract with the digest, editable paths, and the two permitted JSON shapes; asking the worker to restate identity fields is a known failure mode.

- The plan and execution ticket bind the task ID, plan/input digests, dependency-artifact digests, attempt number, and lease. External events also bind the check-run identity; a PID or task name alone is insufficient to establish ownership. A worker submission is not completion. On acceptance, the shared coordinator rechecks versions, attempts, cancellation state, and lease; late, duplicate, or stale results cannot unlock a successor. Do not copy a particular state enumeration if the semantic requirements can express it.
- If an external check is lost or its result cannot be confirmed after restart, return undecidable or explicitly rerun it; process absence is not success. Automatically retry only checks declared re-entrant.
- Cancellation and acceptance races need a deterministic terminal state; after cancellation, do not accept that attempt's artifact. Checks and model calls have time limits, log/artifact size limits, and a cleanup owner.
- Before applying a patch, check the baseline digest and path permissions; reject out-of-scope paths, traversal, and symlink escape. The verifier and live coordinator are outside the candidate patch's editable execution surface.
- A worktree is file-collaboration isolation, not a security sandbox. Candidate tests execute code. The first round is limited to approved repository code and fixed checks; it does not claim safe execution of arbitrary untrusted code. If a task needs stronger isolation, the host must provide it before opening that task.

Security acceptance must cover at least: duplicate/late events, patches based on old versions, an old worker after lease transfer, cancellation races, worker exit, coordinator restart, lost checks, out-of-scope artifacts, and A/B that pass separately but fail when composed. Reuse existing checks; add only checks for real gaps.

## Advance on real blockers

| Phase | Deliverable slice | Evidence required to leave the phase |
| --- | --- | --- |
| S0 Bootstrap | The three minimum capabilities above; record permitted tools and checks. | A real patch and real wait event pass through the constrained boundary; negative security cases are rejected. |
| S1 First self-bootstrap round | Execute A/B/C and collect blockers and no-change conclusions. | The timeline proves legal overtaking; a useful development artifact is independently accepted and used next round. |
| S2 Recovery bootstrap | Use the S1 baseline to address a recovery, cancellation, or budget gap actually exposed in that round. | Fault injection shows no duplicate completion, incorrect unlock, or infinite wait; restart recovers or terminates explicitly. |
| S3 Usable entry point | Add submit/query/cancel only for manual actions that recur; stabilize the shared persistence contract. | Supported tasks can be repeated without editing the research script; scope regressions pass. **Historical record:** S3 was completed 2026-09-12 with `round-spec.ts`, `round-runner.ts`, `round-cli.ts`, and a thin `ooo_round` Pi tool; the tool left the product tool directory on 2026-09-14. The dated details and explicit product-integration boundary are in the [S3/S4 tooling record](ooo-execution-bootstrap/historical-round-tooling.md). |
| S4 Comparative evaluation | Compare sequential and OoO execution against the same frozen plan. | Report quality, elapsed time, tokens, failures, and human intervention without presuming a benefit. **Historical record:** comparison tools and offline arms were completed 2026-09-12; live-model comparisons were not run and require 2×N paid rounds plus operator authorization. See the [S3/S4 tooling record](ooo-execution-bootstrap/historical-round-tooling.md). | |

At the start of each round, revisit the previous round's exposed problems, then freeze the current plan. When a gap appears, record the task, expected behavior, observed behavior, minimal reproducer, and blocked capability; fix the smallest issue that affects the next round's closed loop. Put investigation details and timelines in experiment records, not duplicated here. Keep general platform capabilities out of scope until evidence requires them.

## The old version drives; the candidate version is tested

At each round's start, pin coordinator, Pi adapter, verification rules, and input baseline by version or digest; freeze uncommitted content too. Never reference a changing shared directory. A task may patch the next scheduler version, but the running process cannot hot-reload it.

Keep the verifier separate from execution artifacts: an Agent cannot make itself pass by changing the test command or acceptance criteria. A new test may be an artifact, but it does not replace the safety checks fixed before the round. Changes to the verifier itself require review outside the current round.

Promote a candidate to the next round's baseline only after composition acceptance and independent approval; retain the previous runnable version. On failure, discard the round's execution environment, retain evidence, and return to the old baseline rather than endlessly repairing itself inside the failed version. Independent review provides bounded confidence, not a mathematical proof that arbitrary code is correct.

## Position relative to public work

Read the complete responsibility: [Position relative to public work](ooo-execution-bootstrap/related-work.md).

## Evidence and stop conditions

Record each round's baseline/plan/verifier digests, both worker identities, attempts/input versions, real-wait start/end, task-selection/acceptance times, rejection reasons, artifact digests, check results, tokens, human intervention, and promotion outcome. Do not store credentials; truncate logs to the task budget and retain traceable references.

Distinguish four outcomes: sequential fallback; legal out-of-order execution with no useful change; completed self-bootstrap change; and an observed comparative benefit. Time overlap between background work and B is evidence that a wait was used; a B→A→C output list alone is not.

Compare with the same inputs, model settings, check work, and acceptance criteria. Record cache and external-load differences, repeat runs, and retain failures. No stable benefit does not mean the scheduler is wrong, but it does prohibit a speedup claim.

Stop self-bootstrap on privilege violations, incorrect unlocks, unlocatable input drift, or a candidate that can rewrite acceptance. Return to ordinary development, fix the smallest blocker, and verify again. Record human fallback explicitly; do not widen permissions to bypass the problem.

This plan does not require AG migration, same-session pause/resume, multiple concurrent executors, speculative execution, automatic replanning, or irreversible external operations. A future extension must demonstrate a concrete need and receive separate review.
