# An assertion records its domain, its assumptions, and its evidence strength

[中文](2026-09-09-assertion-domain-and-strength.zh-CN.md)

**Status:** implemented  
**Approved:** explicit

## Problem

`ContractAssertion` records a property (`statement`) and binds it to evidence
(`check`). It does not record the domain the property is claimed over, nor the
assumptions the claim rests on. The 2026-09-08 traceability work built the ledger and
did not notice the missing columns, because nothing consumed them.

The consequence is a specific over-claim. `rtm:check` prints `12 verified`. A passing
test is a witness at the inputs it exercises, not a proof over the scope the assertion
claims, so `verified` says more than the evidence carries. The gap stayed invisible
because the scope was never written down: a reader cannot check a claim whose domain
does not exist.

`docs/design/verification-claims.md` states the target form:

```
∀ x ∈ D,  A(x) ⇒ P(x)
```

## Decision

Add three optional fields to `ContractAssertion` (`src/rcp/types.ts`):

```ts
interface ContractAssertion {
  // existing: id, statement, check?, documentedOnly?, kind?, stage?, context?
  domain?: string; // D — the cases the property is claimed over
  assumes?: string[]; // A — ids in the assumption register
  strength?: "decision" | "witness"; // what the evidence buys; absent means witness
}
```

`documentedOnly` stays as it is. "No evidence at all" is a different axis from "how much
the evidence buys", and two fields saying the same thing is one too many.

and one register, `docs/design/assumptions.yaml`, whose entries carry an id, a
statement, an owner, and how the assumption would be falsified.

`tools/rtm-check.ts` then:

- fails when an assertion that is not `documented-only` omits `domain`;
- fails when an `assumes` id is absent from the register;
- reports `bound` and `proven` separately with the strength breakdown, e.g.
  `12 bound (0 proven / decision, 12 witness), 1 documented-only`;
- keeps `documented-only` assertions out of the bound count, as today.

`strength` defaults to `witness` when absent, so the report can never overstate while
the backfill is incomplete.

## Alternatives considered

- **Change the wording only** (`verified` → `bound`). Cheapest, and it removes the
  over-claim on its own. Rejected as the whole answer because it leaves the domain
  nowhere, so the next reader still cannot see what the evidence fails to cover.
  Kept as the first slice: it lands before the schema change and is not wasted.
- **Reuse the existing `context?: string`.** The field already exists and 3 of 13
  assertions use it. Rejected: `assumes` has to resolve to names to be checkable, and
  free text cannot.
- **Adopt a formal specification language** (Dafny, TLA+) and generate verification
  conditions. Rejected on 2026-09-08 for the control plane, and re-rejected here: it
  requires D and P to be formal for all 13 assertions, which is rewriting the
  contracts in service of a handful of them.
- **No fields; a Skill reminder only.** Prompt-only has already failed empirically in
  this repository, and the reminder would live in the file the reader opens after
  trusting the green line.

**What now has to hold:**

- `rtm:check` output contains `bound` and no longer contains `verified`;
- an assertion added without `domain` fails `rtm:check`, and the message names the
  assertion id;
- an `assumes` entry naming an id absent from the register fails `rtm:check`;
- the strength breakdown in the output equals the counts in the contracts;
- all 13 existing assertions carry a `domain` and an explicit `assumes` (possibly
  `[]`);
- `proven` counts only assertions whose evidence is a decision procedure. **Today that
  count is 0** — the two decision procedures in the code are not bound to any
  assertion — and the report says so rather than leaving it implied.

## Consequences

- `ContractAssertion` gained `domain`, `assumes` and `strength`; the compiler requires
  the first two, so every contract that compiles states what its evidence covers and
  what it rests on.
- All 13 authored assertions carry a `domain` and an explicit `assumes`.
- `tools/rtm-check.ts` reports `12 bound (0 proven / decision, 12 witness), 1
documented-only` and resolves `assumes` against `docs/design/assumptions.yaml`
  (5 entries).
- `proven` is 0: neither decision procedure in the code is bound to an assertion. The
  gap is now visible instead of implied.
- Cost: two new failure modes on a shared contract, and a `domain` that goes stale is
  detected by nothing.

## Risks

- **A vague domain satisfies the check.** Presence is checkable, specificity is not.
  The counter-pressure is mutation testing, not the check: a surviving mutant whose
  change lies outside the stated domain is evidence that the domain line is wrong.
- **Backfilling invites wording that fits the tests instead of the intent.** No check
  can detect this; it is review work, and the place to argue it is the domain line
  itself.
- **A schema change reaches the control plane.** The fields are optional and the IR is
  versioned, so an older contract stays valid; the risk is a reader treating an absent
  `domain` as "no domain claimed" rather than "not yet filled".
- **Two new failure modes on a shared contract block unrelated work.** Accepted for
  the same reason it was accepted for the terminology index.
- **The `domain` column may go stale.** Nothing re-reads a domain when the evidence
  behind it changes. **Repeal condition: if no counterexample is raised against a
  domain statement within three months, and no surviving mutant is attributed to one,
  drop the field** and keep only the wording change to `bound`; the over-claim it fixes
  is the part that stands on its own.
