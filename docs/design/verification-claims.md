# Verification claims: domain, assumptions, strength

[中文](verification-claims.zh-CN.md)

**Status:** draft  
**Authority:** this document describes the shape of the claim ledger. The rules it
motivates live in decisions; the workflow lives in
`skills/verification-traceability/SKILL.md`. Do not restate either here.

## What green means today

`rtm:check` prints `12 verified`. Read plainly, that says twelve properties hold.
What the evidence supports is weaker:

```
bound    = every declared assertion is bound to a named test
           that passed on this commit
verified = the property holds for every case in scope
```

A passing test is a **witness**: it shows the property at the inputs the test
exercises. It does not cover the scope the assertion claims. Until 2026-09-09 nothing
said what that scope was — the domain was never written down, so the gap could not
be seen, only assumed away.

## The form

```
∀ x ∈ D,  A(x) ⇒ P(x)
```

| Symbol                 | Artifact    | Home                                     |
| ---------------------- | ----------- | ---------------------------------------- |
| P                      | `statement` | contract assertion                       |
| D                      | `domain`    | contract assertion                       |
| A                      | `assumes`   | named entries in the assumption register |
| evidence               | `check`     | a test, a check, or a procedure          |
| what the evidence buys | `strength`  | contract assertion                       |

### strength

| value      | means                                                | example                                                |
| ---------- | ---------------------------------------------------- | ------------------------------------------------------ |
| `decision` | a deterministic procedure decides P for every x in D | `testOutputPassed(output)`, `validateReceipt(receipt)` |
| `witness`  | a sample passed; D is claimed, not covered           | most `node-test:` assertions                           |

`documented-only` is a third state, but on a different axis: it means _no evidence at
all_, and it lives in `documentedOnly`, not in `strength`. Two fields saying the same
thing is one too many.

Only two things here qualify as `decision`, and both are tiny. **Neither is bound to a
contract assertion today**, so the ledger reports `0 proven` against 12 `witness` — the
gap is visible instead of implied away. A `witness` assertion is not worthless: it is
the cheapest falsification instrument we have. It is only misread as a proof.

## Five artifacts, one home each

| Artifact              | File                           | Question it answers                                               |
| --------------------- | ------------------------------ | ----------------------------------------------------------------- |
| claim ledger          | `.rcp/contracts/*.yaml`        | what is claimed, over what domain, under what assumptions         |
| assumption register   | `docs/design/assumptions.yaml` | what is taken for granted, by whom, and how it would be falsified |
| counterexample ledger | `.rcp/counterexamples.yaml`    | what was raised against a claim, and with which input             |
| receipts              | `.rcp/receipts/*.json`         | what actually ran, on which revision                              |
| uncovered scope       | the PR's `## 未验证项`         | what was declared out of scope                                    |

Which of these exist today: the claim ledger, receipts, and the uncovered-scope
section. The assumption register and the counterexample ledger are proposed.

## Where the loop closes

Declaring D does not make D honest. The instrument that does is mutation testing, and
it belongs to this ledger rather than beside it:

```
ledger declares D / A / P
  → rtm bounds evidence to the claim
  → mutation measures whether the evidence discriminates
  → a surviving mutant is a counterexample inside the model
      → semantically impossible (outside D)?  → rewrite the domain, not the test
      → inside D?                             → fix the evidence,
                                                or accept that P does not hold
```

The first branch is CEGAR's move: a spurious counterexample refines the abstract
model, not the product. Here the model is the three-line claim, so the refinement is
an edit to `domain`.

The 2026-09-09 mutation pass found one real gap (`changedPaths` sort order) and fixed
the test. The domain statement that would have predicted the gap was never written,
so that fix has nowhere to be recorded as a claim — which is the cost of the missing
column, not a failure of the mutation pass.

## What the checks enforce, and what they cannot

Enforced, each asserting a property of a result and never the identity of a tool:

- every assertion that is not `documented-only` states a `domain`;
- every `assumes` entry resolves to the assumption register;
- every `open` counterexample carries a reproducer;
- `rtm:check` reports `bound` and `proven` separately, with the strength breakdown.

Not enforced, and not claimed:

- that D is complete;
- that A is reasonable;
- that P is what we want.

Those three were the open-ended questions. They are now arguable instead: an
assumption has an owner and a falsification path, a domain can be attacked with a
surviving mutant, and P is defended in a decision record.

## Stop condition

```
closed(change) =
    every assertion in scope is bound
      or is documented-only and listed in the PR's 未验证项
  ∧ no counterexample in scope is open
  ∧ every assumption the change touches is registered
```

## Reasons this stays small

- The two `decision` strengths already exist and their code does not change.
- The three new fields are optional, so an old contract stays valid and the backfill
  can be incremental.
- No new tool, no new entry point: the checks extend `rtm:check` and `docs:check`,
  which already run on every route.
