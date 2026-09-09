# External Repository Control Plane

[中文](2026-08-29-repository-control-plane.zh-CN.md)

**Status:** implemented

The single-attempt run-to-completion control plane was merged through
PR #3 and subsequently hardened at its evidence and recovery boundaries. Contract compilation, observation, WorkOrders,
independent verification, append-only local receipts, provider boundaries, Draft
PR binding, automatic `agent:verify` delegation for uniquely covered changes, and
optional/no-NMG operation have deterministic product tests and a
real Contract-bound PR/CI/local-receipt run. Continuous reconciliation and portable
third-party attestations remain deferred.

## Problem

The repository already has routing, owned documentation, verification commands,
CI, and temporary Agent coordination. They reduce repeated setup work, but they
remain separate actions. There is no durable contract that links desired state,
an Agent work order, the exact repository revision, independent verification, and
merge readiness. An Agent can therefore produce a locally reasonable change while
implicitly changing architecture, leaving a design unimplemented, or reporting
completion without a machine-verifiable receipt.

Turning these scripts directly into NMG daemon responsibilities would solve the
wrong problem. Repository state and merge authority are not memories. It would
make the memory service control Git, CI, PRs, and Agent execution; prevent the
development loop from working when NMG is unavailable; and create competing
sources of truth between Git, receipts, and LTG.

## Decision

Introduce a Repository Control Plane (RCP) as an external, Agent-neutral control
plane. It compiles versioned repository Contracts into a canonical IR, observes
the repository, evaluates policy, emits bounded WorkOrders, delegates work to an
Agent harness, independently runs the selected checks and records a receipt through an append-only API.
This API does not make its files immutable or authenticate their producer.
Each explicit invocation performs one bounded reconciliation attempt ending in a
verified, failed, or blocked result. Iterative convergence is not implemented.

The dependency direction is one way:

```text
Repository Control Plane -> optional NMG client -> NMG daemon
```

NMG may provide recall, reusable experience, and Task Board notification. It does
not parse Contracts, own PR state, schedule Agents, judge CI, or reconcile the
repository. The RCP must complete its core loop when NMG is disabled or
unavailable. It may initially live as a modular CLI in this repository; logical
separation does not require an immediate repository or service split.

The control plane keeps four truth domains separate:

1. Git Contracts own desired repository state.
2. Repository Observer output owns current state for a named revision/worktree.
3. Receipts record the executor's observations and bind Contract digest, commit,
   scope, verifier identity, checks, and evidence.
4. The Git forge owns PR and merge state.

The first Contract surface is versioned YAML/JSON compiled into an Agent-neutral
IR. It borrows constraint unification from CUE and pure policy evaluation from
OPA without requiring either runtime. A Contract declares intent, scope,
preservation rules, invariants, verification, authority mode, and extension data;
it does not prescribe shell steps. Stable IDs remain unchanged after references
exist, while content digests identify exact revisions.

The reconciliation loop is:

```text
Contract -> compile -> desired state
Repository -> observe -> current state
desired + current -> policy -> route/plan -> bounded Agent WorkOrder
Agent -> patch/Draft PR -> independent verifier -> receipt
receipt + re-observation -> reconcile or terminate
```

Reconciliation is idempotent and keyed by Contract digest, observed revision, and
operation identity. It re-observes after an action instead of trusting tool
success. Plan mode is the default. Repository writes, pushes, PR creation,
merging, deletion, and permission changes require explicit Contract authority and
provider support; destructive drift is never repaired implicitly.

Draft PRs are durable in-flight change instances. The Task Board can point to a
WorkOrder or PR for discovery, claims, blockers, and handoff, but it is not the
work system of record. A design PR being merged means the proposal was accepted;
it does not make the proposed implementation complete.

RCP extension points are narrow providers for repositories/forges, harnesses,
verifiers, policy, receipt sinks, and optional memory. Providers declare
capabilities and cannot expand authority silently. RCP and NMG retain separate
application protocols, though transport, schema hashing, diagnostics, and
capability-negotiation libraries may be shared.

Delivery proceeds in six independently verifiable slices:

1. Contract schema, compiler, IR, digest, diagnostics, and fixtures.
2. Read-only observer plus run-to-completion planner/reconciler CLI.
3. Independent verifier and commit/Contract-bound receipts.
4. Draft PR/CI integration with idempotent re-observation and conditions.
5. Multiple harness providers and optional/no-NMG parity.
6. Continuous watcher, queue, catalog, and product split only after continuous
   contracts and independent release needs are demonstrated.

The normative data contracts, lifecycle, security defaults, phased plan, and
full completion criteria are owned by
[ci-cd-and-quality.md §7](../../design/ci-cd-and-quality.md#7-repository-control-plane).

### Fixed trusted baseline

The opt-in fixed-baseline CLI uses a separately approved external installation to
verify an explicit candidate Git commit. Acceptance policy and test definitions
come from that installation; candidate product code is tested in a disposable
snapshot. Rule/dependency changes require a separately reviewed new installation,
never candidate self-promotion. This extends the local workflow; it does not
silently strengthen ordinary reconciliation or flip the lightweight default.
Commands, supported inputs and acceptance boundaries are owned by
[§7.13](../../design/ci-cd-and-quality.md#713-fixed-trusted-baseline-verification).

The choice borrows the separation of evidence production and small acceptance
rules, not a claim of cryptographic succinctness. Its adversarial contract checks
are in `tests/rcp/trusted.test.ts`; code presence is distinct from validation in a
particular environment.

## Alternatives considered

1. **Put the control plane inside NMG daemon.** Rejected because repository
   authority is not memory, reverses the desired dependency, and makes core
   development depend on an optional memory service.
2. **Keep independent scripts and rely on Agents to follow documentation.** This
   preserves simplicity but cannot reconcile desired/current state or prove that
   the claimed checks apply to the exact Contract and commit.
3. **Split a new product/repository immediately.** Deferred. Logical modules and
   provider boundaries give the required separation; physical separation should
   follow independent release, isolation, or ownership evidence.
4. **Adopt CUE, OPA, Backstage, or a Kubernetes-style API server immediately.**
   Rejected for the MVP. Their semantics are useful, but full runtimes would make
   a local repository loop heavy before its minimal contract is validated.
5. **Use the Task Board or NMG LTG as the work system of record.** Rejected because
   TTL coordination and semantic memory cannot replace versioned desired state,
   repository observation, forge state, or immutable verification receipts.

6. **Candidate-owned tests plus self-hashed receipts.** Insufficient for trusted
   baseline verification: a candidate can weaken both implementation and tests,
   or fabricate a receipt and recompute its digest. Fixed baseline rules address
   the former; local result authenticity still assumes a trusted execution path.
7. **Local services, separate accounts or random ports.** Deferred for this
   non-hostile same-user workflow. A fixed external installation is simpler;
   random ports do not provide tamper resistance.
8. **PCP/SNARK/STARK or formally proved kernel.** Not required for this slice,
   not rejected as mathematically impossible. Computational proofs can verify a
   specified execution; formal verification can establish specified kernel
   properties. Neither is implemented here. Adoption requires a concrete proof
   relation and deployment/cost evidence.

## Consequences

- RCP remains outside the NMG daemon and can complete its run-to-completion path
  with NMG disabled; memory and Task Board integration are optional value only.
- The implemented CLI binds a Contract, scoped observation, WorkOrder, named
  checks, forge state, and one append-only receipt. It does not make preservation
  prose executable or prove semantic equivalence by itself.
- The default `FileReceiptSink` writes `.rcp/receipts/`, which is intentionally
  ignored by Git. Those receipts support local idempotency and operator audit, but
  are not portable third-party attestations. The standard `npm run agent:verify`
  entry automatically delegates to one RCP Contract only when that Contract fully
  and uniquely covers the selected scopes; otherwise it keeps ordinary verification,
  and overlapping Contracts fail closed instead of being guessed.
- GitHub CI remains the repository's remote verification authority. A future
  artifact/attestation provider may publish receipt evidence when an independently
  reproducible external proof is required.
- Only single-attempt run-to-completion reconciliation is implemented. Watchers, queues,
  continuous convergence, general catalogs, and multi-tenant operation still
  require demonstrated demand and separate safety design.
- Reusable receipts are validated and bound to the active route, checks, and
  verifier definition. Apply fails closed without Git provenance, process harnesses
  are bounded, and an in-flight journal prevents interrupted mutations from being
  replayed without explicit recovery. The journal is local coordination state, not
  verification evidence, and is removed after a receipt is recorded.

## Risks

- The control plane can become a second product before the repository needs it.
  The phased plan therefore starts with a run-to-completion CLI and defers daemon,
  catalog, queue, multi-tenancy, and general DSL work.
- A weak Contract or verifier can formalize the wrong behavior. Architecture and
  check strength still require review; the control plane carries decisions but
  does not supply product intelligence.
- Multiple state stores can drift. Desired, observed, receipt, PR, and memory
  domains must remain separately owned and joined by stable IDs/digests.
- Provider plugins can become authority escape hatches. Capability declarations,
  policy checks, scope matching, and fail-closed unknown operations are required.
- Process metrics can incentivize ritual rather than useful engineering. A local
  receipt's digest checks self-consistency, not execution truth or provenance.
  Named acceptance tests support only their stated obligations; they do not prove
  arbitrary prose is implemented. The fixed installation assumes trusted local
  tools/dependencies and does not resist malicious same-user or administrator
  modification. Hashes and deterministic code do not establish a formal proof.

## References

- [OpenGitOps principles](https://opengitops.dev/)
- [Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/)
- [Backstage software catalog](https://backstage.io/docs/features/software-catalog/)
- [Crossplane control planes](https://docs.crossplane.io/latest/whats-crossplane/)
- [CUE constraints](https://cuelang.org/docs/tour/basics/constraints/)
- [OPA philosophy](https://www.openpolicyagent.org/docs/philosophy)
- [GitHub Spec Kit](https://github.github.com/spec-kit/)
- [SLSA build provenance](https://github.com/slsa-framework/slsa/blob/main/spec/build-provenance.md)
