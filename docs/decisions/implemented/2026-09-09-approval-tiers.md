# Approval tiers: most documentation needs no approval

[中文](2026-09-09-approval-tiers.zh-CN.md)

**Status:** implemented  
**Approved:** explicit

## Problem

`docs/decisions/README.md` says an `implemented/` record is "accepted and implemented".
It does not say who accepts, what counts as acceptance, or whether anything checks it.
In practice the Agent asked for an explicit "accept" on every record, which made the
user the throughput limit of their own repository — and the ask was often the *second*
one for the same substance, because the record was written into `proposed/` before the
code was written.

The same hole covers the documentation around the records. Nothing said whether a
guide, a design note, or a README needed approval at all, so the safe-looking move was
to ask about everything.

## Decision

Approval attaches to **normative content that no check can decide** — not to file types,
and not to documentation as a class. The test is one question:

> If this file were wrong, what would fail?

| Content                                                        | Who approves | Examples                                                                                                                          |
| -------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Descriptive — a wrong file costs one edit                      | **nobody**   | `docs/experiments/**`, `docs/guides/**`, READMEs, `**Status:** draft` designs, notes                                              |
| Watched by a check — a wrong file turns a gate red             | **the check** | the parts shelf, `docs/glossary.yaml`, `.rcp/contracts/**`, `.rcp/counterexamples.yaml`, receipts                                  |
| Normative with no check that can decide                        | **`explicit` or `auto`** | `AGENTS.md`, standing rules in `skills/*/SKILL.md`, `**Status:** current` designs, `docs/decisions/implemented/**` |

### Where the check is missing, write the check instead of asking

A document that people must approve by reading is a document whose check has not been
written yet. The parts shelf stopped being an approval question on 2026-09-09 simply by
gaining a check (`docs:check` fails when it names a part that no longer exists). The
same move applies wherever a document has a checkable property.

### `**Approved:**` on an implemented record

Every record in `implemented/` carries one line in its header block:

- `explicit` — the user approved this substance. A record whose substance was already
  agreed is written **straight into `implemented/`**; it is not parked in `proposed/` to
  be asked about a second time.
- `auto` — the Agent accepted it under the four conditions below.
- `unrecorded` — accepted before this rule existed, without a recorded act. Debt, in the
  same sense as `documented-only`: it is replaced with `explicit` the next time the
  record is touched.

### When `auto` applies

All four, no exceptions:

1. **No verification apparatus.** The change touches no `.rcp/contracts/**`, no
   `*check*.ts`, no `scripts/verify-docs.mts`, no `agent-context.yaml`, and no lifecycle
   rule in `docs/decisions/`.
2. **Implemented and green in the same change**, with `agent:verify -- <owned paths>`
   covering every route the change lands on.
3. **A repeal condition** under `## Risks` or `## Consequences`.
4. **Reversible in one commit** — no data migration, no external contract, no
   irreversible side effect.

Condition 4 is both the entry test and the safety property: what can be promoted
automatically must be demotable automatically. `implemented/ → proposed/` costs one
commit and needs no new decision. A record for which that is not true cannot be `auto`.

### Self-reference guard

A record that changes **approval, lifecycle, or evidence** is never `auto`. This record
is one of those, which is why it is `explicit`.

### What this does not change

- `proposed/` still exists, for a choice that is genuinely undecided.
- Merging a pull request is still an explicit act.
- `auto` says a record may move. It says nothing about whether its content is right.

## Alternatives considered

- **Keep everything explicit and accept the interruption.** Rejected: it put the user on
  the critical path of their own repository, and it produced duplicate asks for the same
  substance.
- **Let the Agent approve anything it implemented.** Rejected: that is the
  self-certification shape this repository already rejects
  (`harness-cannot-self-certify`), with one actor writing, implementing, verifying and
  accepting.
- **Approve by diff size or file count.** Rejected: a one-line change to a standing rule
  outweighs a five-hundred-line guide, so the axis would be wrong.
- **Approve by file type** — `docs/**` needs it, `src/**` does not. Rejected:
  `docs/design/**` at `current` is normative and `docs/experiments/**` is deliberately
  non-normative, so the type does not decide. The check question does.
- **Convention without the `**Approved:**` field.** Rejected: nothing would then
  distinguish a rule the user chose from a rule the Agent chose, and that distinction is
  the field's entire purpose.

## Consequences

- `docs/decisions/README.md` gains a fourth header field, `approved`, and `docs:check`
  requires it on every record in `implemented/`.
- The records already there carry `explicit` where the acceptance is on record, and
  `unrecorded` otherwise. The debt is visible rather than implied.
- Guides, experiments, READMEs and draft designs stop being approval questions.
- Cost: `unrecorded` can rot, and a record marked `auto` in bad faith is not detected by
  anything. The counter-pressure is cheap reversal — and the repeal condition below.
- **Repeal condition: if two `auto` records are moved back to `proposed/` within 30 days,
  this rule is repealed** and every record returns to explicit acceptance.

## Deferred

- `docs/design/**` has the same hole: `draft → current` has no owner. The proposed
  criterion — `current` means something normative points at the file — is not
  implemented by this record.
