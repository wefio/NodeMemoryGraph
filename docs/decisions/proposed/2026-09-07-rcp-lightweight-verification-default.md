# RCP lightweight verification by default

[中文](2026-09-07-rcp-lightweight-verification-default.zh-CN.md)

**Status:** proposed
**Date:** 2026-09-07

## Problem

Coarse route checks can rerun the product suite for small changes. The optional
narrow path and Contract-bound reconciliation have different execution and
recording paths. Their results must not be described as interchangeable without
checking their actual obligations and coverage.

Reliability of the verifier is a separate concern. The accepted fixed-baseline
implementation is owned by the [RCP decision](../implemented/2026-08-29-repository-control-plane.md)
and [operating contract](../../design/ci-cd-and-quality.md#713-fixed-trusted-baseline-verification).
It does not implement this default-change proposal.

## Proposal

Keep the default unchanged until a conservative selection rule and its evidence
exist. A future narrow default would run applicable baseline-owned acceptance
obligations and all required shared checks, escalating when dependencies are
unknown. Route ownership alone is not a sound dependency analysis.

Record the selected obligations, omitted checks and selection reason. A partial
run supports only its named claims, not a claim that the full gate ran. Integrate
such evidence with reconciliation only after defining the compatibility and
failure rules; this proposal does not claim that integration already exists.

## Alternatives considered

- **Fixed trusted baseline first:** accepted separately. It prevents an ordinary
  candidate from weakening both implementation and acceptance rules; it does not
  by itself reduce test execution cost.
- **Self-hashed receipts as succinct proofs:** rejected. Anyone can fabricate a
  result and recompute its hash. Receipt validation checks self-consistency, not
  execution authenticity; there is no independently anchored digest chain here.
- **PCP/SNARK/STARK:** legitimate proof-system techniques, not inherently
  unreliable because of probabilistic soundness. They can certify specified
  computations under their assumptions. Deferred because this local workflow
  has no implemented proof relation, prover or cost evidence requiring them.
- **Formal verification of a small decision kernel:** remains possible; a model
  proof needs a justified connection to the running implementation. No such
  proof is claimed by the current RCP.
- **Retain explicit narrow/full choices:** remains the conservative option until
  selection evidence justifies a default change.

## Acceptance criteria

- Demonstrate that selected checks cover the affected baseline obligations;
  ambiguous or unknown dependency cases must not silently omit obligations.
- Test shared-check inclusion, missing/failed/skipped/timeout handling, and
  explicit partial-versus-full reporting.
- Bound evidence to the candidate snapshot and trusted policy/verifier versions.
- Never infer all design claims are implemented from a green aggregate result.
- Measure execution savings against the unchanged default on representative
  changes before changing it.

## Risks

Incomplete dependencies can make a narrow selection unsound. Tests can encode
incorrect or incomplete requirements. Hashes and deterministic execution do not
repair either problem. Even a full test suite is not a general correctness proof.
Trusted local installations assume a non-hostile runtime and same-user processes;
protection against malicious same-user modification requires a different boundary.
