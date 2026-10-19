# NMG design completion audit

**Authority:** current requirement-to-evidence ledger. Normative intent remains
in [design.md](design.md); implementation history in
[implementation-lineage.md](implementation-lineage.md); document ownership is
defined by [the documentation index](../README.md).

**Status:** current
**Updated:** 2026-10-18
This ledger answers two different questions without conflating them:

1. Is every intended NMG responsibility designed and owned by a component?
2. Has each optional policy earned default product activation?

The first can be complete while the second remains open. A missing natural-data
calibration is not permission to invent another subsystem; a passing unit test is
not evidence that a policy improves real Agent work.

## Status vocabulary

| State | Meaning |
| --- | --- |
| **Verified core** | Contract is designed, wired into the stable boundary, and covered by deterministic tests. |
| **Opt-in Lab** | Implemented and explicitly activatable, but omitted from the Lite default tool/prompt path. |
| **Designed target** | Normative target and ownership are accepted, but the current implementation still follows a superseded runtime shape. |
| **Calibration gate** | Mechanism exists; thresholds or default activation require independent natural evidence. |
| **Explicitly deferred** | Boundary is designed, but implementation waits for a stated prerequisite. |
| **Out of scope** | Another component owns it; NMG must only define an integration boundary. |

Lab is not a one-way holding area. The daemon publishes a capability directory and
session-scoped expiring leases through the existing client RPC. An Agent may
self-enable explicitly designated low-risk capabilities; controlled and active
actuation still require harness/operator authority and their existing receipts and
gates. Passing an evaluation is required to make a capability a Lite default, not
to use it explicitly for one suitable task.

## Requirement matrix

Read the complete responsibility: [Requirement matrix](completion-audit/requirement-matrix.md).

## Agent convergence feedback implementation slice

The [feedback design](agent-convergence-feedback-design.md) remains **partial**,
not completed by a documentation or implementation PR. `SessionFeedbackProvider`
and the explicit RCP CLI session/task target send validated, newly recorded
receipts into temporary AG observations. Controlled tests cover a real failing
check, HTTP delivery, identity binding, deduplication and failure isolation.
They do not prove overall task completion or natural Agent improvement.

The 132-parameter `ContextRouter` numerical primitive has action-mask, sampling,
observed-action update and weight round-trip tests, including compiled execution.
It is not automatically invoked, trained from natural outcomes, or exposed as a
new self-service Lab capability. The experimental harness now has a versioned
32-feature encoder, four bounded context executor adapters, ordered trial events,
caller-verified outcome admission and source-grouped dataset replay. Trial sinks
are awaited; a bounded local append/fsync journal checks phases, output identity
and duplicate execution reservations. Generated-output fingerprints and executor
call counts bind admission to execution without proving model exposure.
Reopening retracts a row on rebuild; production artifact revocation remains unwired.
The [LoCoMo component probe](../experiments/context/router-component-2026-09-06.md)
collected 6128 action rows and fitted a linear head, but matched fixed retrieve
on held-out evidence coverage. It used custom lexical ranking, no main LLM and
no official answer scoring. Validation-only cost sensitivity and per-source-group
counts now expose the degenerate policy and small independent sample size.
General lifecycle producers, production recovery orchestration, model exposure,
external verifier adapters and end-to-end efficacy remain
open. No completed system status or default promotion is implied.

## Actual active blockers

Four active work families remain; the first is narrower AG completion work and
the other three prevent evidence-backed default activation of adaptive policies:

1. The session AG core, explicit frame/branch lifecycle, bounded runtime items,
   and shared adapter disclosure ledger are implemented. Automatic semantic
   frame classification, the full multidimensional budget `B`, and optional
   typed HA/MGR artifact admission remain incomplete.
2. Natural Pi tasks rarely contain independently verified claim/evidence outcomes.
3. Retrieval/controller gains have not yet passed matched quality **and** token,
   tool-round, latency, and rollback gates.
4. Unattended STG consolidation and identity merge lack natural false-positive,
   contradiction, and reversal coverage.

The AG item is a deliberate breaking runtime redesign; the remaining items are
validation blockers rather than missing storage mechanisms. Their executable
checklist lives in [temporary-todo.md](temporary-todo.md).

## Completion rule

The NMG design is structurally complete when every intended responsibility is in
this matrix with an owner, invariant, activation authority, and evidence gate.
NMG is product-proven only when the active blockers pass on independent natural
use. New mechanisms should be added only when an observed failure cannot be
resolved by an existing owner; otherwise they increase maintenance cost without
closing a requirement.

Commit hashes are recorded only when they materially shorten recovery or prevent
repeating a superseded design. The curated owner map and notation live in
[implementation-lineage.md](implementation-lineage.md); Git remains the exhaustive
changelog.
