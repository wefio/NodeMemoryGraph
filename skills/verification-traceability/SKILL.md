---
name: verification-traceability
description: Make a declared design assertion checkable and traceable. Use when adding or changing a contract assertion, choosing how to verify a behaviour, or when a behaviour has no expected output.
---

# Verification traceability

The rules — every assertion resolves to a check, no orphan checks, the coverage
table in the receipt, the frozen rule — are owned by
[the requirements-traceability decision](../../docs/decisions/implemented/2026-09-08-requirements-traceability-matrix.md)
and enforced by `rtm:check`. Do not restate them here.

This Skill covers only the judgement those cannot enforce: what to assert, and
which kind of check supports it.

## Author one assertion per claim

One assertion is one claim a reviewer can read plus the evidence that supports
it. Keep `statement` in the agent's words — it briefs the agent. Keep `check`
executable — it judges the agent.

```yaml
assertions:
  - id: daemon-does-not-depend-on-rcp
    statement: NMG daemon and Core do not depend on or own the RCP
    stage: unit
    check: node-test:daemon-cli
    kind: test
```

## Place the assertion on the chain

A check proves one link, not the chain: requirement, acceptance, implementation,
unit, integration, E2E, deployment, observability, real-effect metric. Name the
stage the assertion actually verifies, and never let a unit test stand in for an
outcome. Evidence may be `node-test:`, `eval:`, `metric:`, `review:`, or
`documented-only`. When the last links are owned outside this repository, say so
and mark the assertion `documented-only` rather than borrowing someone else's
signal.

## Scope the assertion to its evidence

A check is a sample, not coverage. State the context the evidence actually
covers — platform, entry points, inputs, version matrix — and do not let the
statement claim more. "The two bin entry points start on this platform" is
checkable; "the package works" is not, and belongs in `documented-only`.

## Choose the cheapest kind that can actually fail

| Situation                                   | `kind`              | Why                                                            |
| ------------------------------------------- | ------------------- | -------------------------------------------------------------- |
| You can write the expected output           | `test`              | most direct                                                    |
| A relation holds for all inputs             | `property`          | examples are a sample; properties are not                      |
| The condition must hold while running       | `runtime-assertion` | design-by-contract; fails at the boundary, not only in a suite |
| No expected output exists                   | `metamorphic`       | assert a relation between runs instead of a value              |
| The claim is about structure, not behaviour | `coverage`          | statement, branch, MC/DC                                       |
| Pure logic where "for all inputs" matters   | `proof`             | Dafny or LemmaScript                                           |

## No oracle? Use a metamorphic relation

NMG has behaviours with no expected output: retrieval ranking, summaries,
consolidation. Do not fall back to "it ran". Assert a relation between runs:

- `changedPaths` is symmetric, and empty when the two observations are equal.
- Adding an unrelated memory must not evict a memory that was already relevant.
- Re-summarizing byte-identical input is stable.
- Reordering independent inputs leaves a set-valued result unchanged.

## Every check needs a negative control

A check that cannot fail is not a check. Add at least one input that breaks if
the logic breaks. The local example is the `NODE_TEST_CONTEXT` child-process
masking: the positive case passed while the real path was broken.

## `documented-only` is debt, not a pass

Use it only when no check is possible, and say why. It stays visible in the
coverage table so a reviewer can challenge it. Never use it to make the table
green.

## Do not chase coverage

Coverage is an analysis signal, not a target. A high coverage number with a low
mutation score means weak checks. Report the mutation score, not the assertion
count.

## Know the proof boundary

A proof checks a contract, not the intent, and not the TypeScript body. In this
repository the verifiable slice is small: classes, `await`, `node:` IO, regex
and float math are outside the fragment. Use `proof` only where the claim is
pure, central, and worth "for all inputs"; use `property` elsewhere. LemmaScript
annotates real TypeScript with `//@`, so it avoids the model gap plain Dafny
has.

## State the domain, not just the property

An assertion is a triple: `statement` is P, `domain` is D, `assumes` is A.

```
∀ x ∈ D,  A(x) ⇒ P(x)
```

The compiler requires `domain` and `assumes`; `assumes` ids resolve to
`docs/design/assumptions.yaml`. `strength` says what the evidence buys:
`decision` for a procedure that decides P for every x in D, `witness` for a
sample that passed — which is what most `node-test:` evidence is, and why
`rtm:check` reports `bound`, never `verified`.

A domain that is vague passes the check. The instrument that catches it is
mutation testing: a surviving mutant whose change lies outside the stated domain
means the `domain` line is wrong, not the test. Write the domain statement first,
then decide what to do with the mutant.

## A counterexample needs a reproducer

An opinion that something looks wrong and an input that shows the claim is false are
different things, and only the second is a counterexample. A challenge goes in
`.rcp/counterexamples.yaml`:

- `open` — **must** carry a `reproducer`: a command, an input, or a case another Agent
  can run. If you cannot produce one, say so and record it as `unsubstantiated`; that
  state exists so a real but unfalsifiable concern stays visible without blocking.
- `resolved` — must name what changed: the product, the evidence, or a `domain` line.
- `claim` names what was challenged, and need not resolve. A challenge against
  something not yet in the ledger is often the valuable one.

`docs:check` enforces both. The reason for the reproducer is that someone other than
the reporter decides whether the challenge holds: the model proposes doubts, it does
not settle them.

Claims, assumptions and open challenges live in the contracts, the register and
`.rcp/counterexamples.yaml`. This section states the rule once; the reasoning is in
[the claim-ledger design](../../docs/design/verification-claims.md) and in
[the domain decision](../../docs/decisions/implemented/2026-09-09-assertion-domain-and-strength.md)
and
[the reproducer decision](../../docs/decisions/implemented/2026-09-09-counterexample-needs-a-reproducer.md).
