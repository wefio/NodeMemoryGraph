# Narrow and full verification gates

[中文](lightweight-verification.zh-CN.md) · [Terms used](lightweight-verification.terms.yaml)

**Authority:** [Repository Control Plane](../repository-control-plane.md).

## Narrow and full verification gates

Use this reference to determine which checks `npm run agent:verify` selects and
what the resulting evidence means. Gate selection is an ownership heuristic,
not dependency analysis. If actual impact crosses owners or ownership is unclear,
use full rather than inferring safety from the changed filenames.

### Determine the selected gate

Default narrow requires every changed scope to have exactly one owner, the same
route to own the whole change, and no scope under a shared/cross-cutting root.
Shared roots are `src/`, `tests/`, `scripts/`, `tools/`, `.github/`,
`package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`,
`agent-context.yaml` and `AGENTS.md`.

| Situation | Selected check surface |
| --- | --- |
| One unambiguous non-shared owner | Narrow: shared invariants plus that route's tests. |
| Cross-route, unowned, shared-root, ambiguous or empty scope | Full: the routes' declared blocking set. |
| `--full` | Force full. |
| `--narrow` | Request narrow; ineligible ownership still escalates to full. |

`--full` and `--narrow` are mutually exclusive. Full refers to the applicable
blocking set, not every benchmark, platform or advisory check in the repository.

The `NARROW_SHARED_CHECKS` invariants are `check`, `docs:check`,
`format:check`, `glossary:check`, `lint`, `package:check` and `rtm:check`.
Route `tests:` patterns resolve to actual files, excluding matched directories;
zero matches fail closed. Their combined check is `node-test:<routeId>`.

### Reject skipped or empty route-test runs

The route-test child does not inherit `NODE_TEST_CONTEXT`; inheriting it can make
Node skip execution and mistake an empty run for a pass. The TAP acceptance rule
is the same as trusted-baseline route tests: `tests > 0`, `pass == tests`, and
`fail` / `cancelled` / `skipped` / `todo` all zero. A skip, a skip-only run or
zero execution is not success.

### Interpret a route's shared-check declaration

A route may declare `verify.sharedChecks: none` instead of the default `always`
when those invariants do not apply to its own surface. This takes effect only for
a change exclusively owned by that route; narrow then runs the route tests only.
It cannot exempt a shared/cross-cutting root from escalation. Configuration
loading rejects the declaration if the route has no tests, so declining shared
checks cannot manufacture an empty successful plan.

The receipt's `gate.reason` names the declaration; the reader need not discover
it by counting checks. The
[decision](../../../decisions/implemented/2026-09-16-route-declines-shared-checks.md)
records the rationale and rejected alternatives.

### Distinguish verification evidence from a receipt

Narrow executes through `reconcileOnce`, using an authored Contract or a
synthesized in-memory Contract, and writes a `.rcp/receipts/` receipt. Full also
uses RCP when an authored Contract applies. Without one, full executes the
ordinary route plan and records verification evidence without an RCP receipt.
The selection branches are owned by [the executor](../../../../tools/agent-verify.ts).

For RCP receipts, `gate.mode` is `narrow` or `full`; `gate.reason` is optional,
and `gate.fullGateRun` is always `false` for narrow. `validateReceipt` rejects a
contradiction between mode and flag. Use `nmg-rcp receipt-verify` with the receipt
file to check integrity independently; `agent:verify --receipt <id>` is not a
supported executor option.

### Keep the evidence boundary

Narrow reduces check scope, not the identity requirements of its verifier mode.
Candidate, baseline, verifier, policy and invocation bindings still apply where
that mode requires them; ordinary verification does not become an isolated
trusted-baseline run. Historical or differently bound evidence cannot substitute
for current checks. Missing checks, skips, timeout, empty reports, snapshot
changes or dependency changes fail closed. Identity-valid same-state receipt
reuse follows the [reconciliation contract](run-to-completion-cli.md), not a claim
that old results certify a different revision.

A narrow run does not cover checks it did not execute; `gate.fullGateRun=false`
records that limit. Filename ownership can miss real cross-boundary effects even
outside shared roots. The adversarial fixtures live in
`tests/tools/agent-verify.test.ts`, `tests/tools/narrow-verify.test.ts` and
`tests/rcp/receipts.test.ts`.
