# Repository Control Plane

[中文](repository-control-plane.zh-CN.md) · [Terms used](repository-control-plane.terms.yaml)

**Authority:** [Code quality and CI/CD](../ci-cd-and-quality.md).

## Repository Control Plane

Use this architecture reference for authority, state ownership and provider
boundaries. It covers the run-to-completion core and the conditions for deferred
extensions. `src/rcp/`, `nmg-rcp`, compilation, observation, WorkOrder, independent
npm verification, local receipts, forge adapters and optional NMG integration
form that core. Resident watchers/queues/catalogs, multi-tenancy and portable
attestation are not established by it. The
[RCP decision](../../decisions/implemented/2026-08-29-repository-control-plane.md)
owns rationale and alternatives. [Completion audit](../completion-audit.md) owns
implementation status and historical execution evidence; this reference is not
a new real-harness or remote-CI run.

### Follow the relevant sub-contract

| Task | Required reference |
| --- | --- |
| Author or inspect a Contract and its evidence claims | [Contract surface and IR](repository-control-plane/contract-surface-and-ir.md) |
| Interpret a receipt and its trust limits | [Verifier and receipts](repository-control-plane/verifier-and-receipts.md) |
| Plan, apply, recover or bind PR/CI | [Run-to-completion CLI](repository-control-plane/run-to-completion-cli.md) |
| Install reviewed rules and verify a fixed candidate | [Trusted baseline](repository-control-plane/trusted-baseline-verification.md) |
| Determine narrow/full scope | [Gate selection](repository-control-plane/lightweight-verification.md) |

Read the sub-contract needed for the action; this page does not replace its
prerequisites or failure rules.

### Product boundary and dependency direction

RCP lives outside the NMG daemon. It turns declarative repository goals into
bounded Agent work and compares desired state, observations and receipts:

```text
Git contract + repository observation
                  |
                  v
       Repository Control Plane
       | compiler / policy / planner
       | scheduler / reconciler / verifier
       | receipt index / forge adapter
       +--------------------+
       |                    |
       v                    v
Agent harnesses          Git / PR / CI
(Pi/Codex/DSH)                |
       |                      |
       +----------+-----------+
                  |
                  v
          code and evidence

Optional only:
Repository Control Plane -> NMG client -> NMG daemon
```

Logical separation permits a modular CLI in this repository; it does not require
another repository or resident service. With `NMG_MODE=disabled` or NMG unavailable,
the core must still compile, plan, observe, verify and generate receipts. NMG may
provide transferable experience, historical recall and Task Board notifications.
The NMG daemon does not parse Contracts, launch Agents, judge CI, own PRs or write
control-plane state.

### Keep each truth domain at its owner

| Domain | Authority | Non-authoritative view |
| --- | --- | --- |
| Desired repository state | Version-controlled Contract in Git | Catalog, compilation cache, NMG memory. |
| Current repository state | Observer output for the selected commit/worktree | Agent descriptions and PR text. |
| Verification facts | Trusted executor observations; local receipt binds Contract digest, observed content revision and verifier identity, plus commit in clean/forge contexts | Self-reported logs, Task Board results and unauthenticated receipts. |
| PR/merge state | Git forge | Local caches and NMG. |
| Agent working memory and experience | Harness and NMG AG/STG/LTG boundaries | Receipt summaries. |

A Contract declares desired state; the Observer produces observed state; a receipt
records the executor's claimed inputs, checks and results. Only trust in the
executor and record source makes that receipt execution evidence. A self-hash
cannot prove execution occurred. Overwriting another domain is not convergence.

The Observer prunes directories conservatively using Contract includes: it skips
only directories whose descendants provably cannot match any include. A wildcard
in the first segment disables pruning conservatively; it does not mean the
pattern matches every directory. File-level allow/exclude semantics are unchanged,
and filtering precedes content reads/hashing. Pruning reduces unrelated directory
enumeration and descendant metadata calls, not a nonexistent whole-tree content
hash. A historical approximately 67GB directory-size figure is not measured read
bytes or speedup evidence.

`observedBytes` totals stat sizes of successfully read regular files. Above the
default 256MiB it adds a non-blocking diagnostic after observation—not a pre-scan
estimate or hard size gate. Text plans show completed file/byte counts and
diagnostics; JSON plans retain observation fields. Neither warns before reads.
`skills/repo-development/references/control-plane.md` owns the Agent's rule
against default oversized scans. Runtime observation must still include every
in-scope file, without silent skipping. Respecting `.gitignore` is a separate
digest-semantics decision, not part of pruning.

### Reconcile without trusting action completion

```text
Contract -> compile/validate -> DesiredState
                                |
Repository -> observe ---------+-> diff -> policy -> route/plan
                                                    |
                                                    v
                                             bounded Agent run
                                                    |
                                                    v
                                              code / Draft PR
                                                    |
                                                    v
                                             independent verify
                                                    |
                                                    v
                                                Receipt
                                                    |
                                                    `-> reconcile again
```

Reconciliation is idempotent and recoverable. Reuse identity binds Contract,
observed revision, operation key, route/check declarations and verifier definition.
Re-observe after execution; a tool return is not convergence. Persist an in-flight
attempt before the harness and clear it only after the receipt is saved. An
interruption between them fails closed on ordinary retry. Explicit recovery
verifies the existing workspace without replaying mutation.

Default execution produces a plan. Writing files, pushing, opening PRs, merging,
deleting or changing permissions requires Contract authority and the corresponding
provider. Destructive drift is not automatically repaired. A run-to-completion
change reaches a terminal condition after verification of a design/implementation
PR; a continuous
Contract monitors fitness or document/protocol/generated-artifact drift only when
a watcher is explicitly enabled. The permission name is not a watcher installation.

### Work orders, Agents and PRs

The Planner turns IR and observations into a bounded `WorkOrder` containing at
least Contract ID/digest, allowed paths, owners, checks, preserved behavior,
assertions and budget. The single-attempt/timeout budget reaches the harness; process harnesses
may use the same or a stricter timeout. The same WorkOrder contract supports at
least two of Pi, Codex and DSH. Agents submit patches/PRs and evidence, not their
own `verified` transition. Out-of-scope work returns `scope_violation` or requests
a Contract amendment.

`expectedArtifacts` and `HarnessResult.artifacts` are not supported artifact
checks: the unused string arrays were neither consumed nor receipted. A future
per-Contract existence check would need explicit path/glob declarations, not a
restored unread array.

A Draft PR is a durable in-flight change and review entry. Task Board provides
short-lived discovery, claiming, blockers and notifications, pointing to the
WorkOrder/PR; it is not their system of record. Merging a design PR accepts the
proposal, not unimplemented acceptance criteria. Completion audits advance only
from implementation and verification evidence, not plans or PR text.

### Extend through provider boundaries

Narrow interfaces prevent plugins from writing core state directly:

- `RepositoryProvider`: Git/worktree/forge observation and authorized mutation.
- `HarnessProvider`: WorkOrder delivery and result collection for harnesses.
- `VerifierProvider`: named checks, timeout, evidence and trusted identity.
- `PolicyProvider`: pure decisions over IR, plans and receipts.
- `ReceiptSink`: local files, CI artifacts or remotely auditable storage.
- `MemoryProvider`: optional NMG recall/board/experience, with failure degradation.

Capabilities register providers; Contract requests and policy select them.
Providers cannot silently expand authority. RCP and NMG memory protocols remain
independent, although transport, schema-hashing, diagnostics and capability
negotiation libraries may be shared. Ordinary reconciliation rejects detected
scope/check failures and self-reported completion but does not isolate the
candidate's npm, tests or rules; use the trusted-baseline sub-contract for that
separate approval boundary.

### Keep extensions conditional

The delivery sequence is compiler/schema/IR/digest/fixtures and read-only plan;
Observer/reconciler and WorkOrder using `agent:context` routes; independent
verification and receipts using `agent:verify` primitives; Draft PR/forge
conditions with re-observation, retries and idempotence; then multiple harnesses
and optional NMG with disconnection behavior. Each stage needs behavioral tests,
fail-closed paths and removable compatibility edges.

Local receipts bind commit/scope/Contract/verifier but are not published remotely.
An operator can bind Draft PR, required CI check and local receipt to one commit
and digest; an external reviewer can inspect Git/PR/CI, not ignored local files.
NMG adds memory/coordination value, not a dependency for the loop.

A resident watcher, queue, backoff, catalog or multi-tenancy requires a real
continuous Contract. Cross-machine independent review is the prerequisite for
an external artifact/attestation provider. Do not prebuild a service catalog,
general DSL, distributed queue or control-plane database. Separate product or
repository boundaries depend on provider count, independent releases and runtime
isolation evidence, not conceptual size. Receipt validation, reuse bindings,
provenance, scans, harness timeouts and recovery have product tests; those tests
do not establish a continuous controller or third-party proof.

### Observe CI status without granting authority

After the canonical `CI` workflow, `.github/workflows/ci-status.yml` runs a
read-only GitHub-hosted worker. It reads jobs/failed steps, writes a compact Step
Summary and uploads an `nmg.ci-status.v1` JSON artifact marked `observation-only`.
It neither authorizes merge, creates local receipts nor replaces required checks.

The worker does not comment, label, run repository tests or connect to a local
NMG daemon; permissions are only `actions: read` and `contents: read`. Consumers
must reread current GitHub state through the Forge provider before reconciliation:
workflow-run payloads and artifacts can be stale and are not another truth source.
A later external polling/webhook bridge could wake local work without changing
this read-only contract.

### Design background

Background, not required first-version dependencies: [OpenGitOps](https://opengitops.dev/)
for declarative/versioned/reconciled state; [Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/)
for spec/status and idempotence; [Backstage](https://backstage.io/docs/features/software-catalog/)
for repository-owned truth; [Crossplane](https://docs.crossplane.io/latest/whats-crossplane/)
for provider/composition boundaries; [CUE](https://cuelang.org/docs/tour/basics/constraints/)
for constraint unification; [OPA](https://www.openpolicyagent.org/docs/philosophy)
for policy/decision separation; [GitHub Spec Kit](https://github.github.com/spec-kit/)
for spec-to-task traceability; and [SLSA provenance](https://github.com/slsa-framework/slsa/blob/main/spec/build-provenance.md)
for input, builder, invocation and artifact identity.
