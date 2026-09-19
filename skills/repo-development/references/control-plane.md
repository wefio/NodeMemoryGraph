# Repository Control Plane beyond agent:verify

`npm run agent:verify` auto-discovers the contract that uniquely covers the
current scope and runs the equivalent reconcile — that is the default for
ordinary changes (see [`ci-cd-and-quality.md` §7.11](../../../docs/design/ci-cd-and-quality.md)).
Use the standalone `nmg-rcp` CLI (`node bin/nmg-rcp.mjs`, contract path first)
only in the scenarios `agent:verify` does not cover:

- **Check CI state without opening the browser:** `nmg-rcp forge-status --pr <n>`
  reads the forge's status-check rollup (`checks[]` with name/conclusion). Use
  it before claiming "checks pass" or deciding a PR is mergeable.
- **Review what a reconcile would do before running it:**
  `nmg-rcp plan <contract>` (and `nmg-rcp compile <contract>` when the contract
  itself changed).
- **Inspect verification evidence:** `nmg-rcp receipt-list` /
  `nmg-rcp receipt-verify <receipt>` / `nmg-rcp receipt-scan` — receipts live
  under `.rcp/receipts/` and are append-only.
- **Retry after a failed reconcile, or run an explicit workspace-ready pass:**
  `nmg-rcp reconcile <contract> --apply --workspace-ready [--recover-attempt]`.
- **Bind a PR or create a draft PR through the forge provider:**
  `nmg-rcp forge-bind <contract> --pr <n>` / `nmg-rcp forge-create <contract> --base main --head <branch>`.

`--apply` never runs by default; reconcile plans unless `--apply` is explicit.
When a Contract's status or verification drift from the design doc, update the
owning document (the Skill entry or this reference, `ci-cd-and-quality.md`, the
RCP decision) in the
same change — an improved tool that stays undocumented is a tool agents will
not reach for.

**Do not recursively scan oversized directories by default.** This is an
Agent operating rule for searches, inventories, size estimation, and repository
observation—not a claim that the runtime enforces a size-based rejection.
Avoid known large dataset, benchmark, virtual-environment, and generated trees
unless the task explicitly requires them. Start with named files or narrow
paths; do not walk an entire large tree merely to estimate whether it is large.
When a large-tree scan is genuinely needed, obtain explicit authorization for
the paths and bound the scan to that scope. A broad wildcard alone is not a
substitute for that authorization.

For RCP, choose narrow contract includes before observing. Directory pruning
only avoids include-unreachable subtrees; it is not a size guard, and broad
patterns may still reach large trees. Never silently omit in-scope files to
reduce cost, since that would change observation/digest semantics. Runtime
observation behavior is owned by
[`ci-cd-and-quality.md` §7.2](../../../docs/design/ci-cd-and-quality.md#72-真相域).
