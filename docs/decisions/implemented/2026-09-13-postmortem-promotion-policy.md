# When a post-mortem record becomes a rule

[中文](2026-09-13-postmortem-promotion-policy.zh-CN.md)

**Status:** implemented  
**Approved:** explicit

## Problem

The post-mortem tier landed with a producer contract: when to write a record, which
sections it must answer, how it is numbered and indexed
([the tier decision](2026-09-13-postmortem-tier.md)). Nothing says what the corpus
is _for_. A record that names its guardrail in prose reads like a caught class
while nothing in the repository enforces anything, and a class that appears a
second time has no path from "this happened again" to "this now fails loudly".

The corpus is also entirely retroactive. Every record is written after the failure
and usually after the fix, so a promotion rule that assumed a record precedes its
guardrail would describe a process nobody has run. It has to be a reconciliation:
test the guardrail that already exists, and say plainly when there is none.

Two failures already show the gap. Both were found by accident, both are the same
class — a fallback that degrades silently instead of failing loudly — and neither
produced a rule naming that class. A third occurrence would change nothing.

## Decision

The tier owns its consumer side, in
[docs/postmortem/README.md](../../postmortem/README.md#consumption-from-record-to-rule):

- A record is evidence that a class exists; a guardrail is a mechanism that fails
  loudly. The record is never the guardrail.
- **Promotion takes the first owner that can carry the class**, in the
  repository's existing preference order: a check, then a standing rule in the
  owning `AGENTS.md` or Skill, then a decision record, then a section of the
  document that already owns that process.
- **Three triggers**: the class has escaped twice (two index rows carry one
  failure class); the only guardrail is the record's own prose; the record is
  `open`.
- **Not promoting is a valid outcome**, and it is stated in `Lessons` rather than
  left blank. A single occurrence whose prevention costs more than the failure is
  a story.
- `Status: resolved` means a guardrail exists and is linked; when the only
  guardrail is prose, the record stays `open` with the reason.
- Promotion into a Skill or `AGENTS.md` follows
  [the approval tiers](2026-09-09-approval-tiers.md).
- The policy is deliberately thin and is revised by a decision when the corpus
  shows it misfiring, not by editing the section.

[The classes table](../../postmortem/README.md#classes-and-typical-cases) owns the
taxonomy: one row per class with its canonical case — the record to read first —
and the rule the class produced. A record's class stays in the index rather than
in the record, so the taxonomy has one place to be read.

## Alternatives considered

**No consumer policy.** This is the status quo the two known incidents already
sat in: failure stories accumulate and nothing connects them. Rejected because the
corpus then earns nothing beyond a reading list, and the one fact worth computing
— which classes recur — is computed nowhere.

**A separate rulebook file** (`docs/postmortem/POLICY.md`, or a guide that
consumes the tier). A distinct 管理办法 is easier to point at. Rejected for now:
`docs:check` names records as `NNNN-slug.md` and treats any other file in the tier
as a naming error, so a second file needs a gate exception; and a second document
would restate the tier's own ownership and naming rules, which the README already
states. The README is about one screen. Revisit if the consumer side grows past
the tier's own rules.

**Make promotion mechanical**: fail or warn when two records share a failure class
and no class row names a canonical case. Deferred rather than rejected — it is
checkable in principle, but it needs the per-record index table parsed as data, and
no second record exists to test it against. It is also the judgement this policy
exists to guide: a gate would fire on legitimate single occurrences.

**Require a rule before a record can be `resolved`.** Rejected: the guardrail may
legitimately be a local convention with no artifact to link, and forcing one into
existence to close a record is the failure mode this avoids. `open` plus a reason
is the honest state.

**Put the promotion rule in `skills/doc-maintenance/SKILL.md`.** Rejected:
promotion is a property of the tier's corpus, not of the documentation workflow.
The Skill keeps a pointer, which is where an Agent meets it.

## Consequences

- The corpus has a consumer, and the classes table is the map from a failure class
  to whatever catches it. A class row with an empty rule cell is a deliberate,
  visible admission.
- Nothing mechanically enforces promotion. Two records of one class can sit
  un-promoted; the classes table is the signal and reading it is Agent or human
  judgement. The deferred check is the mechanical version, once the shape settles.
- `Lessons` gains a second job: saying when no rule applies. An evasive `Lessons`
  now hides a decision rather than merely reading thin.
- The policy is three triggers and four owners, and is expected to be wrong in
  detail. Revising it is a decision like this one.

## Deferred

A `docs:check` warning when two records share a failure class and no class row
names a canonical case, once a second record exists and the index table has a
stable shape to parse.

The two known incidents still have no record, so the taxonomy starts empty.
