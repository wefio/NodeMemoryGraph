# Verifier and receipts

[中文](verifier-and-receipts.zh-CN.md) · [Terms used](verifier-and-receipts.terms.yaml)

**Authority:** [Repository Control Plane](../repository-control-plane.md).

## Verifier and receipts

Use this reference to interpret a verification receipt, locate its source and
decide what it supports. The verifier runs independently after the Agent's change
and checks at least structure, behavior, boundaries and provenance. A receipt is
an append-only sink record, not an operation log or a natural-language completion
claim.

### Identify the inputs behind the result

This sketch shows identity relationships, not a complete receipt that can pass
validation. The sink also supplies canonical `receiptId`, gate/work-order gate
binding and harness state; do not submit placeholder digests as evidence.

```json
{
  "receiptSchema": "repository.receipt/v1alpha1",
  "contractId": "rcp-001",
  "contractDigest": "sha256:...",
  "observedRevisionBefore": "sha256:...",
  "observedRevisionAfter": "sha256:...",
  "commit": "git-sha",
  "invocationId": "...",
  "verifier": { "id": "verify:product-ci", "digest": "sha256:..." },
  "workOrder": {
    "id": "wo-...",
    "routeDigest": "sha256:...",
    "routes": ["repository-control-plane"],
    "verificationChecks": ["check"],
    "budget": { "maxAttempts": 1, "timeoutMs": 1800000 }
  },
  "scope": { "declared": ["src/**"], "actual": ["src/**"], "matched": true },
  "checks": [{ "name": "...", "status": "passed", "evidence": "..." }],
  "decision": "verified"
}
```

The normative receipt binds immutable input/output identity. Its gate must agree
with the work order and `fullGateRun`. A `verified` decision requires matching
scope, a completed harness and a nonempty set of passed checks; a forge-bound
receipt must also bind its commit to the forge head. The canonical self-hash is
checked by [`validateReceipt`](../../../../src/rcp/receipt.ts). Passing these checks
establishes internal consistency, not an authenticated execution history.

### Locate the receipt and distinguish recovery state

`FileReceiptSink` appends receipts under the Git-ignored `.rcp/receipts/`.
Its `inflight/` subdirectory holds interrupted-attempt markers, not receipts or
proof. Normal terminal handling clears the marker. For an interrupted attempt,
follow the [explicit recovery path](run-to-completion-cli.md#recover-without-replaying-the-harness)
rather than treating a marker as success or replaying mutation automatically.

`npm run agent:verify` also writes `.nmg/verification/latest.json`. It uses
workspace-ready RCP verification when one authored Contract uniquely covers the
selected scope. Without an applicable authored Contract, ordinary verification
remains available: narrow synthesizes an in-memory Contract and records a receipt;
full executes the ordinary route plan without an RCP receipt. More than one full
covering authored Contract fails closed until intent ambiguity is resolved.
The [gate rules](lightweight-verification.md) own check selection.

### Keep local audit separate from external trust

Receipts support local idempotency, recovery and operator audit. They do not
travel with the PR, are not tamper-proof files and cannot alone serve as
third-party-verifiable proof. Self-hashes, filenames and determinism check
consistency; they neither authenticate the source nor prove that execution
occurred.

GitHub required checks accept results from trusted verifiers. PR text and
comments explain those results but are not the sole machine state. An indexed
receipt store or external artifact/attestation provider is possible, but an
external provider remains deferred until cross-machine independent review is
needed.

NMG may cite a receipt as a source. That does not automatically write LTG:
only attributable, reusable experience admitted through a separate `remember`
path becomes durable memory.
