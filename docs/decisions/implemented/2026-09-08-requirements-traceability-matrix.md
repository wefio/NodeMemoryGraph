# Requirements traceability matrix and mutation testing for verification

[中文](2026-09-08-requirements-traceability-matrix.zh-CN.md)

**Status:** implemented

## Problem

RCP has two roles: it is the **entry point that briefs the agent**, and it is
the **independent verifier that records a receipt**. Both exist to answer
questions the repository cannot otherwise answer:

- **Q1 — was the design implemented?** (conformance)
- **Q2 — is the implementation correct?** (correctness)

An audit of the shipped code on 2026-09-08 found that neither role is fully
wired, and neither question is answered by a machine today.

**The guidance role is thin and unused in practice.** A contract compiles to a
bounded `WorkOrder` (allowed paths, owners, `preserve`, `invariants`, required
checks, budget, expected artifacts) that `nmg-rcp plan` prints and a command
harness receives on stdin; `intent` and `preserve` also seed a memory recall.
But `formatPlan` prints only the id, intent, allowed paths and checks —
`preserve`, `invariants`, `owners`, `budget` and `expectedArtifacts` appear only
in the JSON form. The repository's own development flow never produces a
`WorkOrder` at all: it runs `npm run agent:verify`, which verifies but does not
brief. `invariants` — the field the design calls the agent's prohibition list —
is carried into the `WorkOrder` and read by no code. Prose is the right shape
for guidance; it is the wrong shape for verification, and the same field serves
both.

**The contract IR is mostly a shell.** Of the `RepositoryContractIr` fields,
only `id`/`contractDigest` (work-order identity and receipt binding), `scope`
(allowed paths and the scope gate), `authority.mode`, `preserve`/`intent` (a
memory-recall query string) and `verification.forgeChecks` are consumed.
`invariants` is written into the `WorkOrder` and read by nothing; `extensions`
is parsed and never used. In the default narrow path, `planWorkOrder` takes its
route and checks from `agent-context.yaml` plus the hardcoded
`NARROW_SHARED_CHECKS`, so the contract's `verification.routes`/`checks` are
bypassed; when no authored contract covers the change,
`synthesizeNarrowContract` generates one from the route table. Three separate
places declare what to run: the `agent-context.yaml` route `verify.blocking`,
`NARROW_SHARED_CHECKS`, and `contract.verification.checks`.

**The CUE/OPA pipeline does not exist.** There is no `repo.contract.cue`, no CUE
runtime, no OPA/Rego, and no `Decision {drift, requiredChecks,
blockingViolations, advisoryViolations}` structure. `DefaultPolicyProvider` is
ten lines: an authority gate plus "the work order has checks". Observation is
file digests only.

**A Dafny experiment on 2026-09-08** formalized `changedPaths` from
`src/rcp/repository.ts`: 12 verified, 0 errors, 147 lines. A plausible bug
(missing modified files) was rejected, but a weakened contract plus an empty
implementation still verified. A proof checks the contract, not the intent, and
not the TypeScript body.

**Root cause.** Not the choice of DSL. In both roles the middle link is empty:
for guidance the brief never reaches the agent, and for verification the
contract's criteria are bypassed; and in both, the design stays prose that
nothing evaluates. No DSL, IR or prover fixes that.

**The process is not novel, and the industry version is more complete.** V-model
development pairs every design level with a verification level and mandates
bidirectional traceability. DO-178C, ISO 26262, IEC 62304 and ASPICE require
documented proof that every requirement is covered; DO-178C Level A requires
MC/DC structural coverage. The machine-readable form of a "did we do the
design?" argument is an **assurance case** — GSN (Goal Structuring Notation) or
the OMG Structured Assurance Case Metamodel (SACM) — a set of auditable claims,
arguments and evidence with explicit context and assumptions, recommended by
ISO 26262 and applied to AI systems. 2026 AI-native tooling (GitHub Spec Kit,
AWS Kiro, Tessl) already ships the spec-first phase model, and `spec-kit-trace`
already produces the requirement-to-test matrix. The proposal below is a cheap
subset of this, not a new idea.

**The chain is longer than the matrix.** Verification is one segment of a
chain: requirement, verifiable acceptance criteria, implementation, unit test,
integration test, E2E, deployment, observability, real-effect metric. The
proposal above covers the first six links and stops at "a check passed". The
repository already owns part of the right half — `evals/` holds retrieval,
benchmark, gate, disclosure, concurrency and scale evaluations, and
`verify:research` and `verify:chaos` are explicit execution groups — but those
evaluations are advisory, and **no assertion can name one**. Deployment is
build-time only: `build`, `package:check` (a `npm pack --dry-run` file-closure
check) and `verify:packages` (a clean-lockfile rebuild). Nothing packs, installs
into a clean consumer and runs it, so "it installs and works" is not
machine-checked. Production observability is absent: there is no telemetry,
metric or SLO code in `src/` or `docs/design/`. Real-effect metrics exist only
as offline evaluation scores. The chain therefore has a hard seam at the
boundary between "a check ran" and "the behaviour is right in the field".

The vocabulary this proposal introduces — `assertion`, `check`, `stage`, `kind`,
`evidence`, `context` — is itself collision-prone: `invariants` already covers
part of `assertion`, and three places declare "what to run".
[The repository terminology index](2026-09-08-repository-terminology-index.md)
registers those names before this schema is implemented.

## Decision

The decision is a cheap **assurance case**: auditable claims (assertions), the
argument that each is supported by named evidence, and the context in which
that holds. It borrows the structure of GSN/SACM without their tooling, and the
phase shape of Spec Kit without its workflow.

1. Contract assertions become structured: `assertions: [{ id, statement,
   check, kind }]`, where `check` names an executable check, or the assertion
   is explicitly marked `documented-only`. `statement` is kept verbatim, so the
   field still briefs the agent while the `check` makes it verifiable.
2. `kind` names what the check is: a unit or integration test, a property-based
   test, a runtime assertion (design-by-contract, as JML and E-ACSL do), a
   metamorphic relation for behaviour with no oracle, a structural-coverage
   target, or a formal proof. Naming the kind matters: NMG has behaviours
   (retrieval quality, summaries) where no expected output exists.
3. Traceability is bidirectional and checked: every assertion resolves to at
   least one check, and every check belongs to at least one assertion; orphan
   checks are reported.
4. `agent:verify` reports a **coverage table** (assertions, verified,
   documented-only, uncovered, orphans) rather than a binary pass/fail, and
   records it in the receipt so the process outcome is auditable later.
5. Coverage is reported by criterion, not by count: statement/branch coverage
   (already measured by `test:coverage`), MC/DC where a decision is
   safety-like, and a mutation score. DO-178C's own guidance is that coverage
   is an analysis signal, not a target to chase.
6. Fail closed: an assertion with neither a `check` nor a `documented-only`
   marker fails verification.
7. Checks carry negative controls; positive examples alone can pass vacuously,
   as the `NODE_TEST_CONTEXT` child-process masking did.
8. Changing or withdrawing an assertion is not the implementer's authority, and
   is recorded with a reason and a diff.
9. The traceability check is not advisory. It is a blocking check (`rtm:check`)
   on both the narrow and full paths, and its rule is pinned by the trusted
   baseline, so a candidate cannot weaken the rule that judges it. The check is
   subject to its own rule: it has an assertion owner, or it is explicitly
   listed as `documented-only`. This is the same shape as `testOutputPassed`:
   the acceptance rule is frozen outside the code it judges.
10. An assertion's evidence is namespaced rather than a bare check name:
    `node-test:<route>`, `eval:<name>`, `metric:<signal>`, `review:<id>`, or
    `documented-only`. The assertion also names the `stage` it verifies:
    requirement, acceptance, unit, integration, e2e, deploy, observability, or
    outcome.
11. The coverage table is a **chain coverage table**: for each stage it reports
    whether the evidence is blocking, advisory, human, or absent. The existing
    `evals/` become first-class advisory evidence an assertion can point at,
    instead of living in a separate world.
12. Fail closed along the chain: an `outcome` or `observability` assertion
    cannot be closed by a unit test, and an `e2e` assertion cannot be closed by
    a unit test. When no machine evidence exists, the assertion is
    `documented-only` and the gap is visible rather than implied by a green
    suite.
13. Every assertion declares the **context** its evidence covers — platform,
    entry points, inputs, version matrix — because a check is a sample, not
    coverage. The chain table shows that context next to each stage, so "the two
    bin entry points start on this platform" is never read as "the package
    works everywhere".
14. **Boundary.** RCP is local-first and cannot own the last two links. It can
    require that a signal is declared and that an evidence artifact is
    recorded; it cannot observe a production metric or prove that a change
    caused it to move. The chain table makes that boundary explicit instead of
    letting a passing test suite stand in for a validated outcome. This is the
    verification/validation split: the matrix proves the thing was built as
    specified, not that the right thing was built.

Implemented 2026-09-08: `spec.assertions: [{ id, statement, check |
documentedOnly, kind, stage, context }]` replaces `spec.invariants`, and both
authored contracts migrated. Thirteen assertions: twelve name the exact test
that covers them (`node-test:<route>#<test name>`) and one is `documentedOnly` —
the "runtime registration stays unavailable" absence claim that no test asserts.
`npm run rtm:check` fails closed when a check resolves to neither a package.json
script, a declared route, nor an existing test name in that route's test files,
and reports the checks no assertion claims. `nmg-rcp plan` now prints owners,
preserve entries and assertions.

## Alternatives considered

- **Add CUE and OPA runtimes.** Rejected. `DefaultPolicyProvider` is ten lines;
  the control-plane decision already defers a general DSL and the CUE/OPA
  runtimes. The missing links are an executable design and a consumed decision,
  not a policy engine.
- **Use Dafny or LemmaScript as the contract IR/DSL.** Rejected as an IR. Both
  are function-level contract tools, not repository-level configuration.
  LemmaScript is TypeScript-native (no model gap) and remains a candidate
  *check type* for pure-logic invariants; the verifiable slice here is small
  (45 classes, 116 `await`, 94 `node:` imports and 33
  `Math.log/exp/pow/sqrt` in `src/`).
- **Freeze the tests and forbid modification.** Rejected as stated. Withdrawal
  is the modification channel unless authority is separated; versioning plus a
  separate approver is required instead.
- **Delete the contract layer.** Rejected for now. The per-change scope
  declaration and the receipt binding are load-bearing; only the inert fields
  should go.
- **Adopt the full V-model / ASPICE / DO-178C process.** Rejected as too heavy
  for a single-maintainer repository: certification-grade traceability, review
  records and tool qualification are the cost of regulated industries. Take the
  cheap subset that yields the property — traceability, named evidence,
  independence, and a frozen acceptance rule.
- **Adopt GSN/SACM tooling.** Borrow the structure (claim, argument, evidence,
  context, assumption), not the XML metamodel and its tooling.
- **Adopt Spec Kit / Kiro / Tessl wholesale.** Borrow the phase shape
  (constitution, specify, plan, tasks, implement, validate) and
  `spec-kit-trace`'s matrix, not the branch-per-spec workflow; this repository
  already has contracts and routes.

## Verification

Verified as of 2026-09-08:

- `invariants: string[]` is replaced by `assertions`, and both authored
  contracts migrated.
- An assertion with neither a `check` nor a `documented-only` marker fails: the
  contract does not compile, and `rtm:check` fails.
- `rtm:check` is blocking on both the narrow and full paths, fails closed on a
  check that resolves to nothing and on a named test that does not exist, and
  reports orphan checks without failing on them.
- The docs state that a green matrix means "the declared assertions were
  checked", not "the design is correct".

## Deferred

- `agent:verify` does not print a coverage table; `rtm:check` prints one summary
  line. The receipt records each check's pass/fail and its digests, but not the
  coverage numbers: check evidence is written only when a check fails.
- The `rtm:check` rule digest is not pinned in `.rcp/trusted-policy.json`.
- There is no mutation gate and no mutation score. Four hand-picked mutants of
  `changedPaths` and `isPathAllowed` were applied by hand on 2026-09-08 and
  reverted; the one that drops the `changedPaths` sort was killed only by a test
  added for it.
- Only `node-test:<route>`, `node-test:<route>#<test name>` and `documentedOnly`
  resolve. The `eval:` / `metric:` / `review:` namespaces are not implemented.
- The receipt carries no chain coverage table, and an `outcome` or
  `observability` assertion closed by a unit test does not fail verification.
- No `deploy` assertion exists, so the install-time-evidence requirement is not
  exercised.

## Consequences

- The rule is enforced while part of the program is not: the open criteria
  above are the honest size of the gap between "adopted" and "finished".
- The matrix is maintenance cost and can rot.
- Mutation testing is slow; scope it to changed code.
- A green matrix does not close the specification gap: the design can be
  incomplete or wrong. The matrix makes gaps visible, not absent.
- A coverage number can become a target and be gamed (Goodhart). Mutation score,
  not assertion count, is the strength signal.
- The matrix cannot close the validation gap: it shows the thing was built as
  specified, not that the right thing was built.
- Outcome metrics are lagging and confounded; the repository can require the
  signal is defined and emitted, not that it improved. Claiming more would be a
  causal overclaim.
- The last two links may be owned by the consuming product rather than this
  repository; asserting them here can create false ownership of someone else's
  telemetry.
- No check is coverage. A check proves the sampled path, not the property.
  Mutation score measures how tightly a check constrains the code, and
  `documented-only` records what nothing checks; an assertion whose wording
  exceeds its context is a claim without evidence.
