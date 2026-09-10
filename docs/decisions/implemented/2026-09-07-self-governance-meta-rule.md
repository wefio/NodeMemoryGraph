# Self-governance meta-rule: NMG's own rules are governed

[中文](2026-09-07-self-governance-meta-rule.zh-CN.md)

**Status:** implemented  
**Approved:** unrecorded

## Problem

NMG's standing rules, Skills, and decision conventions are themselves NMG
artifacts, but nothing governed how they change. A rule could be added, weakened,
or moved silently inside a code edit, a commit body, or a prose aside, so the
rule system could drift without a deliberate decision. Rules repeated across
several homes drifted out of sync, and a rule that had to be enforced in many
places was restated everywhere instead of enforced once. Borrowed from the dsh
harness, the highest-value meta-rule is the self-bootstrapping one: it makes
every future rule change deliberate rather than silent.

## Decision

Adopt a self-governance meta-rule, stated once in the documentation owner and
surfaced as a standing order:

- A rule change is a non-trivial change. Adding, weakening, or moving a standing
  rule, Skill convention, or decision convention is itself a decision: state what
  changed, what it replaces or beats (alternatives), and why, in the owning
  record, in the same change. Never change a rule silently.
- One home per rule. State each rule once at its owner and link elsewhere by
  relative Markdown path; delete duplicate copies.
- Prefer a gate to a reminder. When a rule must be followed in many places or
  protected against drift, turn it into one mechanical check at its owner rather
  than restating it.
- Keep a new rule reversible and grounded. Prefer a documented convention over
  entrenched machinery; record cost and what it beat.

The owning home is `skills/doc-maintenance/SKILL.md`; the standing order lives in
`AGENTS.md`. Other dsh meta-rules (one-home tier taxonomy, word budgets, slop
checklist, frozen archives, rules-as-gates inside the RCP reconcile) are
evaluated separately and adopted only when NMG's scale justifies them.

## Alternatives considered

- Keep informal conventions only. The documentation-lifecycle decision already
  covers document ownership; extending it with a rule about how rules change
  closes the remaining gap where rule changes were ungoverned.
- Add a machine gate immediately (e.g. fail a reconcile when a rule change lacks a
  decision). This is the eventual rules-as-gates direction, but heavier than the
  current change needs; it is deferred until the convention is exercised.
- Copy dsh's full Agent Note system with closed classes and archived-frozen
  enforcement. NMG's decision volume does not yet justify the taxonomy or the
  archive machinery.

## Consequences

Every future change to a standing rule, Skill, or decision convention carries its
own rationale and alternatives in the same change, so the rule system grows
deliberately and remains queryable. Rules are no longer silently mutated, and
duplication is corrected at its source. Enforcement remains documentary and
light: the meta-rule is a convention until a later decision turns one of its
sub-rules into a mechanical check.
