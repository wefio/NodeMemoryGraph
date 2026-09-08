# RCP lightweight verification by default

[中文](2026-09-07-rcp-lightweight-verification-default.zh-CN.md)

**Status:** implemented
**Date:** 2026-09-07

## Problem

Route-level verification was all-or-nothing. `agent:verify` either ran a
route's whole declared blocking set (often `test:product` plus `build` for a
one-file change) or, via the optional `--narrow` path, ran a smaller set that
bypassed reconciliation entirely: it did not go through `reconcileOnce`, wrote
no `.rcp` receipt, and recorded nothing about which gate ran. A receipt from a
narrow run and one from a full run were therefore indistinguishable, and any
statement that a partial run "verified" the change overstated what happened.

The fixed trusted baseline
([RCP decision](2026-08-29-repository-control-plane.md),
[operating contract](../../design/ci-cd-and-quality.md#713-fixed-trusted-baseline-verification))
protects the acceptance rules from a candidate weakening them. It does not, by
itself, reduce the cost of an ordinary change, and it is a separate explicit
command.

## Decision

Make narrow verification the default, but only where the selection rule is
sound and the record is honest.

- **Selection rule.** A change is narrow-eligible only when every changed scope
  is owned by exactly one route and no scope sits under a shared / cross-cutting
  root (`src/`, `tests/`, `scripts/`, `tools/`, `.github/`, `package.json`,
  `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`,
  `agent-context.yaml`, `AGENTS.md`). Cross-route, unowned, ambiguous,
  shared-root, or empty scope sets escalate to the declared blocking set.
  `--full` forces full; `--narrow` forces narrow; they are mutually exclusive.
  When in doubt the gate is full.
- **Narrow is a first-class RCP mode.** It runs through `reconcileOnce` and
  writes a `.rcp/receipts/` receipt like any other run. When no authored
  contract covers the change, an in-memory contract is synthesized for the
  reconciliation. There is no side execution path.
- **Always-run shared set.** Every narrow run runs `check`, `docs:check`,
  `format:check`, `lint`, `package:check` plus the owning route's own
  `node --test` globs (a synthetic `node-test:<routeId>` check, because route
  tests are not npm scripts). A route's `verify.blocking` set is what a full
  escalation runs.
- **Honest gate record.** `RepositoryReceipt.gate` carries
  `{ mode: "narrow" | "full"; reason?: string; fullGateRun: boolean }`.
  `fullGateRun` is `false` for every narrow run, so "the full gate did not run"
  is a machine-readable fact rather than an inference. `validateReceipt`
  rejects a receipt whose `fullGateRun` contradicts its `mode`, and
  `nmg-rcp receipt-verify` / `agent:verify --receipt <id>` re-checks a receipt
  independently.
- **Binding and fail-closed rules unchanged.** Results still bind candidate,
  baseline, verifier, policy and invocation digests; no evidence reuse;
  missing, skipped, empty, timed-out, mutated or dependency-changed inputs fail.

Narrow reduces the checks that run. It does not widen what may be claimed:
`gate.fullGateRun: false` says exactly that a partial gate ran, and no receipt
asserts that a design is fully implemented.

## Alternatives considered

- **Keep the default unchanged** until representative cost evidence exists.
  Rejected because the narrow rule and its honesty record are now explicit and
  tested; keeping the coarse default only keeps the cost. The evidence question
  becomes a measurement of an implemented, auditable behavior instead of a
  precondition.
- **Self-hashed receipts as succinct proofs.** Rejected. Anyone can fabricate a
  result and recompute its hash; receipt validation checks self-consistency,
  not execution authenticity.
- **PCP/SNARK/STARK as the authoritative gate.** Deferred. These are legitimate
  proof systems, but this local workflow has no implemented proof relation,
  prover, or cost evidence, and they do not cover empirical execution or the
  test-specification gap.
- **Formal verification of a small decision kernel.** Remains possible; a model
  proof needs a justified connection to the running implementation, which is not
  claimed here.
- **Keep explicit narrow/full selection only.** Rejected as the default because
  the selection rule is deterministic and auditable; the flags remain as
  explicit overrides.

## Consequences

- Ordinary small changes no longer rerun the product suite, and the receipt
  states whether the full gate ran.
- Narrow selection is a route-ownership heuristic, not a dependency analysis.
  A change whose real impact spans a shared path but does not touch a shared
  root can still be incomplete. This is why `fullGateRun` is recorded and why
  escalation is the default when ownership is unclear.
- Narrow runs shared checks plus route tests, not the route's full
  `verify.blocking` set. Route blocking remains the full-escalation contract.
- The trusted baseline and this default are separate. A green narrow run is not
  a trusted-baseline pass, and neither is a general correctness proof.
- Reliability is bounded by the local trust model: same-user modification of the
  installation or the runtime is outside it, and hashes do not prove execution.
