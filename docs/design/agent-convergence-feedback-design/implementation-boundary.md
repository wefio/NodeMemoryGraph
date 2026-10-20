# Implementation boundary (partial, not system completion)

[简体中文](implementation-boundary.zh-CN.md) · [Terms used](implementation-boundary.terms.yaml)

**Status:** draft
**Authority:** [Parent scope](../agent-convergence-feedback-design.md).

## Implementation boundary (partial, not system completion)

The first code slice implements only:

- `src/rcp/session-feedback.ts`: a validated receipt becomes a bounded temporary
  tool observation in an explicitly named session/task frame. CLI opt-in uses
  `reconcile ... --nmg optional --session-id <id> --task-frame-id <id>` and an
  already-running compatible daemon. It does not start/stop a daemon, write
  durable memory, mark a quest complete, or train a router. Receipt delivery
  failures are diagnostics, not changes to the verifier's decision. Plan mode
  and idempotent receipt reuse do not emit a new notification. AG visibility
  still follows the existing activation/disclosure lifecycle.
- `src/lab/context-router.ts`: an isolated 132-parameter action-value primitive
  using the existing autodiff substrate, allowed-action selection, explicit
  epsilon sampling with propensity, detached weight export, and observed-action
  regression. It is not connected to automatic recall, not exposed as a new Lab
  lease, and not a trained or enabled policy. Outcome admission remains the
  caller's responsibility; arbitrary numeric rewards are not verified evidence.

`tests/rcp/session-feedback.test.ts` exercises actual failed npm verification,
receipt/contract binding, duplicate projection, session isolation, outage
handling, plan behavior, and CLI-to-daemon HTTP delivery in a controlled fixture.
`tests/core/context-router.test.ts` covers the small head in interpreted and
compiled execution. These tests establish their exercised mechanisms, not
natural task success, convergence, or causal intervention benefit.

A subsequent in-process research boundary, `src/lab/context-intervention.ts`,
validates a versioned decision/execution/outcome envelope before asking a
caller-supplied independent evidence verifier to admit it. Natural, benchmark,
and synthetic origins stay explicit. Shadow choices, cancelled/timed-out
execution, scope/version mismatch, reopened outcomes, invalid windows and
missing evidence cannot produce an admitted row. This is not a receipt
validator, JSON parser, persistent event collector, or automatic training path;
the harness remains responsible for authenticating external evidence.

Benchmark tasks may supply calibration data when natural samples are scarce.
Execute the intervention before labelling it; official answers alone are not
counterfactual action outcomes. Split entire source tasks/conversations across
training, tuning and held-out evaluation, and keep benchmark conclusions scoped
to that distribution. Compare fixed rules and the linear baseline before adding
explicit history statistics, recurrent low-dimensional state or history-node
connections. None of those history architectures is implemented or selected by
this admission boundary; the design remains revisable by measured evidence.

The next experimental slice implements `context-features.ts` (versioned values
and missing masks), `context-executor.ts` (bounded fixed action adapters), and
`context-trial.ts` (awaited decision-before-execution sink and outcome admission).
`context-journal.ts` supplies a bounded single-writer append/fsync journal with
phase/identity checks, duplicate-execution refusal and replay; a stale lock or
torn tail requires operator inspection rather than automatic recovery.
`evals/controller-shadow/context-dataset.ts` replays revisions, rejects decision
identity collisions, retracts reopened labels, and partitions by caller-supplied
source group. These are explicit harness APIs, not automatic Pi/AG actuation.
The custom LoCoMo context probe exercises all four actions and trains a linear
head on training groups only. Its evidence-only metric is not answer accuracy;
see the [component report](../../experiments/context/router-component-2026-09-06.md).

Still open: general lifecycle producers, production recovery orchestration,
main-model exposure integration, external evidence-verifier adapters, bookmark
content ingestion, long-lived quest continuation, end-to-end held-out tasks,
and default-activation gates. The [parent scope's implementation boundary](../agent-convergence-feedback-design.md#implementation-boundary-partial-not-system-completion)
specifies the overall limits; this document does not claim these integrations
are implemented. The original theory remains provisional, and lifecycle
facts/SimHash are not universally unbiased rewards. Do not close the overall
implementation task on this slice.
