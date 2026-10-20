# Run-to-completion CLI

[中文](run-to-completion-cli.zh-CN.md) · [Terms used](run-to-completion-cli.terms.yaml)

**Authority:** [Repository Control Plane](../repository-control-plane.md).

## Run-to-completion CLI

Use `nmg-rcp` for explicit planning, an external harness, interrupted-attempt
recovery, PR/forge binding or control-plane administration. It is an independent
entry point, not a service hosted by the NMG daemon. For ordinary Agent work,
`npm run agent:verify` discovers a uniquely covering authored Contract and runs
workspace-ready reconciliation without a second manual command.

### Inspect before applying

Replace `.rcp/contracts/change.yaml` with the intended Contract path. Confirm its
scope and authority before requesting mutation; a command flag is not additional
permission. Compilation and planning are the read-only entry points:

```text
nmg-rcp compile .rcp/contracts/change.yaml
nmg-rcp plan .rcp/contracts/change.yaml
```

`reconcile` also defaults to plan. To apply, pass `--apply` and explicitly choose
the existing workspace or an external harness. For an existing workspace:

```text
nmg-rcp reconcile .rcp/contracts/change.yaml --apply --workspace-ready --nmg disabled
```

### Recover without replaying the harness

An interrupted-attempt marker requires an explicit recovery choice. The recovery
command below verifies the existing workspace; `--recover-attempt` only handles
an existing marker and prohibits another external-harness run:

```text
nmg-rcp reconcile .rcp/contracts/change.yaml --apply --workspace-ready --recover-attempt
```

Failed receipts append rather than overwrite earlier records. After fixing the
external state, retry; only an integrity-valid verified receipt bound to the
current route, checks and verifier is eligible for idempotent reuse.
`.rcp/receipts/` is excluded from the observed repository revision so control-plane
output does not change its own input.

### Bind authorized PR and CI operations

These commands change forge state. Use them only with the required Contract and
provider authorization. Replace `main`, `feature/change` and `42` with the actual
base, head branch and PR number:

```text
nmg-rcp forge-create .rcp/contracts/change.yaml --base main --head feature/change
nmg-rcp forge-bind .rcp/contracts/change.yaml --pr 42
nmg-rcp reconcile .rcp/contracts/change.yaml --apply --workspace-ready \\
  --pr 42 --operation-key pr-ci --nmg disabled
```

Local-verification and PR/CI receipts use different `operation-key` values but
bind the same Contract digest. With `--pr`, convergence also requires agreement
between the PR body's machine marker, head commit and successful CI status.
Only checks explicitly listed in `spec.verification.forgeChecks` may veto remote
convergence. Other third-party or advisory states are recorded in the receipt,
but do not gain undeclared veto authority.

### Send optional session feedback

Add `--nmg optional --session-id <id> --task-frame-id <id>` to project a newly
persisted receipt into the specified session AG. Both identities are required;
supply the actual caller's session and task-frame IDs, not a guessed Contract ID.
This path connects only to the already-running, protocol/capability-compatible
`nmg.sqlite` daemon under `NMG_DATA_DIR`. It does not start, replace or stop the
daemon, perform ordinary recall or publish a Task Board result.

The `tool_observation` contains receipt ID, Contract digest, observed revision,
check results and bounded diagnostics. It follows AG activation, deduplication
and session-cleanup rules. The receipt remains the full evidence source; an AG
summary is neither a task-completion label nor automatic LTG/training input.

Integrity and success are separate: a scope-violating `failed` receipt may be
saved and projected, but cannot be reused as success; `verified` still requires
matching scope. RCP communicates through the packaged `nmg session observe` CLI,
not NMG internal imports. Plan and receipt reuse send no new notification.
Delivery failure is recorded in `memoryDiagnostics` without changing the
verification decision. This boundary does not include a general event bus,
automatic delivery retries, cross-session continuation or learning activation.

### Do not infer a continuous service

The supported path runs to completion. Contract authority `continuous` is an
upper permission bound, not evidence of an installed watcher. A resident queue,
catalog or watcher remains deferred until a real continuous Contract requires it.
