# Code quality and CI/CD

[中文](ci-cd-and-quality.zh-CN.md) · [Terms used](ci-cd-and-quality.terms.yaml)

**Created:** 2026-07-20

**Updated:** 2026-10-15
**Authority:** Repository test, CI and Agent development contracts

Tests prevent reproducible failures; they do not freeze unvalidated designs.
Product contracts, research measurements and fault injection use separate tracks,
so benchmark conveniences do not define product behavior.

## Read by task

| Task | Entry | Decision it supports |
| --- | --- | --- |
| Choose product, research or fault injection | [Verification tracks](ci-cd-and-quality/verification-tracks.md) | Blocking status and what did not run. |
| Find a change's owner and route | [Repository context](ci-cd-and-quality/repository-context.md) | Where to edit and which checks apply, not architectural correctness. |
| Run and interpret local checks | [Verification pipeline](#agent-verification-pipeline) | Actual scope, command status, timeout and failure attribution. |
| Determine narrow or full | [Gate selection](ci-cd-and-quality/repository-control-plane/lightweight-verification.md) | Check surface and escalation conditions. |
| Review a receipt | [Verifier and receipts](ci-cd-and-quality/repository-control-plane/verifier-and-receipts.md) | Identity bindings and proof limits. |
| Use independent reviewed rules | [Trusted baseline](ci-cd-and-quality/repository-control-plane/trusted-baseline-verification.md) | Installation, authority and failure paths. |

Shared word meanings belong to the [RCP](ci-cd-and-quality/repository-control-plane.terms.yaml)
and [verification](ci-cd-and-quality/verification-tracks.terms.yaml) definitions.
The companion lists terms used here without copying them. First use still needs
local explanation; complete behavioral conditions remain at their owners. Query
canonical words or aliases without reading the whole vocabulary:

```sh
npm run glossary:check -- --resolve 收据
npm run glossary:check -- --resolve "assertion context"
```

## Repository governance invariants

These constrain the development control plane, Agent workflows and maintenance
automation—not a new state store or approval layer:

1. **Repository as environment.** Stable entries, owners, routes, Skills and checks
   let an Agent find the next action from its target. Repeatedly needed implicit
   knowledge returns to its existing owner, not another side explanation.
2. **Proof before trust.** Completion claims, PR prose and local output are not
   sufficient evidence. Targeted tests, independent verification, clean CI and
   applicable real external runs supply layered evidence, each limited to what
   it measures. Benchmarks or one green check do not replace architecture review.
3. **Explicit state transitions.** Work, PRs, decisions, guardrails and releases
   have explicit states and prerequisites. Automation may request a transition,
   not bypass checks, authority, failure states or rollback with “done” or “ship it”.
4. **Aggressive detection, conservative destruction.** Find completed temporary
   work, expired guardrails, duplicate tests, unused compatibility, stale branches
   and abstractions. Contracts may clean generated/cached/explicitly expiring
   material automatically. Source, historical evidence, public APIs, issues and
   PRs first need reviewable candidates, then owner evidence and authorization.
5. **One fact, one owner.** GitHub owns PR/CI state, Contracts desired state,
   observers current observations, and verifiers/receipts verification facts.
   Other components observe/cache/reference; NMG adds memory and notifications,
   not a competing source of truth.

Reduce rediscovery costs without making local convenience permanent architecture.
Tests protect mechanically checkable boundaries; owners and review judge semantic
soundness, deletion authority and architectural choices.

## Test classifications

| Kind | Protected surface | CI | Lifetime |
| --- | --- | --- | --- |
| Safety | Corruption, leaks, unsafe deletion, security regressions | Blocking | Durable. |
| Contract | Public API, protocol, package, persistence, supported integration | Blocking | Durable. |
| Guardrail | Known regression during a repair | Blocking | Temporary; exit or promote. |
| Characterization / research | Current behavior, hypotheses, benchmark adapters | Non-blocking | Follows research. |

Temporary guardrails live under `tests/guardrails/<id>/` with `guardrail.yaml`:

```yaml
id: daemon-startup-race
status: active
reason: Prevent duplicate daemons while lifecycle ownership is being redesigned.
review_after: 2026-10-01
exit_criteria: Replace with a stable contract test or remove after the redesign ships.
```

`agent:context:check` rejects active guardrails missing `reason`, `review_after`
or `exit_criteria`. On exit, delete or explicitly promote to durable Safety or
Contract coverage.

Resource choice is independent of blocking classification. A narrow-verifier
fixture asserting route-test failure may decline inapplicable shared checks while
retaining real CLI, Git and route tests. Representative default-narrow coverage
still tests shared-check execution; see [the decision](../decisions/implemented/2026-09-23-route-only-verifier-fixtures.md).

## Verification tracks

[The track reference](ci-cd-and-quality/verification-tracks.md) separates product,
research and fault injection. Results cover executed checks, not architectural
review or unrun tracks.

## CI contract

`.github/workflows/ci.yml` calls named package contracts—`verify:static`,
`verify:product-ci`, `verify:research`, `verify:node-compat`, `verify:chaos`—instead
of copying command lists into every job. Local and CI execution share owners:

- `static`: build, package, types, lint, format, docs, glossary, traceability,
  Agent context and production dependency audit. `verify:static` runs blocking
  `check:tests`, not a duplicate advisory type step. The two development-surface
  ESLint liveness rules remain warnings, separate from TypeScript type/unused
  checking; see [static coverage](../decisions/implemented/2026-09-16-ci-static-coverage.md).
- `tests`: Node 24 product tests and coverage.
- `research-tests`: visible non-blocking research/benchmark characterization.
  It is excluded from `all-checks-passed`; failure does not block merge, but no
  `continue-on-error` hides it, so the PR check is red on failure. See
  [the decision](../decisions/implemented/2026-09-12-visible-non-blocking-research-track.md).
- `node-compat`: build/package on minimum supported Node 22.19.
- `chaos`: Windows resource/daemon fault injection on pushes to `main` only.
  The [decision](../decisions/implemented/2026-09-09-chaos-tests-on-main-pushes.md)
  records the historical one failure in 145 CI runs, on `main`.
- `all-checks-passed`: aggregates blocking tracks only.
- `ci:uncovered-tests` within `static`: derives test files uncovered by any job
  from actual called globs. `evals/` research harnesses may be acknowledged as
  on-demand; other uncovered tests fail closed and are named.
- `.github/workflows/on-demand-suites.yml`: `workflow_dispatch` only. Runs those
  uncovered suites on Linux/Windows with `--test-concurrency=1`, uploading verbatim
  TAP artifacts; it is not a required check.

For CI/packaging rule changes, run the full affected commands in a clean checkout
or equivalent worktree as well as targeted tests. Untracked local files must not
manufacture success.

## Composable test runtime

Only `tests/support/cordis-adapter.ts` uses Cordis. It exports
`createTestRuntime()`, minimal composable effects and idempotent `dispose()`,
without NMG Core, CLI or daemon imports. `tests/support/test-runtime.ts` composes
NMG resources for integration tests:

```text
TestRuntime
├── testWorkspace
├── testDatabase
└── testDaemon
```

`withTestRuntime(...)` or explicit `dispose()` supplies RAII-style cleanup.
Dependencies are explicit: database requires workspace, daemon requires database;
missing dependencies fail rather than create hidden global state. The in-process
daemon uses the real HTTP JSON-RPC handler, testing the protocol without leaving
a background process.

Choose the lightest isolated resources that expose the assertion boundary;
[the decision](../decisions/implemented/2026-09-24-resource-matched-test-fixtures.md)
owns this distinction:

| Assertion boundary | Resource | Preparation that can be omitted |
| --- | --- | --- |
| Pure data/decision | In-process input | Workspace, database, external processes. |
| One SQLite connection | Independent `:memory:` store | Database files and cleanup. |
| Reopen, migration, WAL, separate connection or path | Unique file database/workspace per case | Unrelated files/services. |
| CLI, Git, HTTP, daemon lease, cross-process sharing | Actual required processes, ports and workspace | Starts/checks that do not participate in the assertion. |

File/cross-process assertions retain real boundaries. Policy/receipt/harness-only
assertions may inject `RepositoryProvider` observations, with separate real Git
tests for discovery, dirty scope, commit and forge bindings. `testDatabase()` uses
real paths shared with the daemon. Git fixtures retain `init/add/commit`, passing
identity to `commit` instead of spawning two `git config` calls per case. Resource
choice neither changes Safety/Contract/Guardrail classification nor blocking or
narrow/full scope, which remain owned by routes and verification contracts.

`@deepseek-ai/cordis@4.0.1` is pinned as a devDependency for effect/fiber lifecycle
only. NMG Core, daemon, Pi adapter and released packages do not depend on it; no
loader, HMR or configuration system is adopted. Separating the adapter from NMG
fixture composition confines a framework replacement to the lifecycle adapter.

## Agent-native repository context

Use [repository context](ci-cd-and-quality/repository-context.md) when ownership
or checks are unclear. It separates declarations, observations and evidence;
returned owners are lookup paths, not mandatory whole-file reading.

## Agent verification pipeline

After edits, run:

```powershell
npm run agent:verify
```

No arguments derives scope from dirty Git paths and selects routes. Without Git
it fails closed, not an empty success. In a shared worktree, positional owned
paths (or compatibility `--scope <target-path>`) limit scope; do not add
`--changed` unless all dirty changes should be included.

[Gate selection](ci-cd-and-quality/repository-control-plane/lightweight-verification.md)
owns default narrow and full escalation. In a full plan, the executor aggregates
matched routes, deduplicates by first occurrence and runs all blocking commands.
For `ci-and-tests`, `verify:static` expands into the same atomic checks as the CI
contract. Cross-route shared checks run once, retaining individual status and
route attribution; CI still invokes the named contract.

Non-RCP full plans use bounded parallel independent static checks after
build/package write barriers, then product tests. Results retain plan order;
RCP and narrow plans remain serial. A failed exit, launch error or signal belongs
to that command, does not prevent later evidence collection, and fails the run.

The official wrapper defaults to a 150-second whole-run budget, adjustable with
`--timeout-ms`. The watchdog returns failure and `incomplete` evidence on timeout.
Ordinary and RCP full/narrow execution share the remaining budget measured from
executor entry; each child receives only what remains. Exhaustion prevents later
starts, records each as failed and cannot produce a passing run. Reduce/redivide
the check work and rerun; earlier partial passes are not whole-run success.

Advisory checks are displayed, not executed, unless `--include-advisory` is set;
their failure does not change the blocking result. `--dry-run` plans only,
`--json` emits machine-readable output, and `--require-clean` adds the clean-tree
precondition for work such as packaging/CI. A formed report overwrites ignored
`.nmg/verification/latest.json` with run ID, timestamps, runtime, HEAD, scope,
routes and command results; it does not create unbounded history.

Automation performs routing, declaration/observation reconciliation, execution,
failure attribution and latest-evidence persistence—not architecture judgment,
automatic formatting, edits or commits. It does not call LLMs, embeddings,
benchmarks or official datasets automatically. Real external evaluations require
explicit selection. GitHub runs named contracts on push/PR; no mandatory local
Git hook is installed to introduce implicit side effects during incomplete work.

## Repository Control Plane

For Contracts, planning, execution or receipt lifecycle, use
[the RCP reference](ci-cd-and-quality/repository-control-plane.md) and its complete
sub-contracts. Agent completion claims do not establish independent verification,
authority or merge state.

## Verify a change

The gate reference owns product-change selection: narrow runs shared invariants
plus owner tests; other cases use the applicable full blocking set. A full product
gate includes targeted tests, `npm run check`, `npm run test:product` and
`npm run build`; this is not a requirement for every documentation-only full plan.
Docs use `npm run docs:check` under [their CI contract](../README.md#ci-contract).
Repository tooling also checks `npm run agent:context:check`; package boundaries
use `npm run package:check`.

Commit only owned files. Preserve user/other-Agent edits; never revert them to
manufacture a clean result.
