# A non-trivial change carries a decision record

[中文](2026-09-09-non-trivial-change-requires-decision.zh-CN.md)

**Status:** implemented
**Date:** 2026-09-09

## Problem

Decision records exist, but nothing states when one is required. The only
standing trigger is the meta-rule that changing a standing rule, a Skill
convention, or a decision convention needs a decision. Everything else is
discretion: the removal of a declared-but-unread field, the migration of a CI
job, or the redefinition of a check kind can land with no record of what was
given up.

This is how a repository ends up with design prose that no longer matches the
code. The 2026-09-08 session needed three decisions that no rule demanded: the
traceability matrix, the terminology index, and the chaos-job migration. Each
one changed a standing convention, so the meta-rule caught them by luck of their
category, not by their size.

DeepSeek Harness states the rule directly: every non-trivial change must add or
update at least one decision note in the same pull request, and only a purely
mechanical or local edit is exempt. NMG has the record format and the lifecycle
gates but not the obligation.

## Decision

Every non-trivial change adds or updates at least one decision record in the
same pull request. Updating the record that already owns the decision satisfies
the rule; a duplicate is not created for a refinement.

A change is non-trivial when it alters behavior, a contract shared across files
or packages, package or module structure, process or tooling, test strategy, or
an on-disk, wire, or configuration format. Purely mechanical or local edits are
exempt: formatting, comment wording, typo fixes, and dependency bumps with no
behavioral consequence.

The rule lives in `skills/repo-development/SKILL.md` beside the delivery
procedure, and the pull-request template carries it as a checklist item.

The rule is not mechanically gated. "Does this change need a decision?" is a
judgment about the change's meaning, and no path list answers it: a one-line edit
under `src/` can be a contract change or a comment fix. DeepSeek Harness, the
strongest available case for mechanization, also leaves this to review and gates
only the note's format and classification.

## Alternatives considered

**Gate on changed paths.** A check could fail when `src/**`,
`.rcp/contracts/**`, `agent-context.yaml`, or `skills/**` changed without a
`docs/decisions/**` change. It would fire on every refactor and comment fix, and
the escape hatch it needs — a `Decision-exempt:` trailer — would be written
reflexively, which converts a norm into a rubber stamp.

**Require a decision only for standing-rule changes.** That is the current
meta-rule, and it is why the three 2026-09-08 decisions exist. It misses
behavioral changes that alter a contract without touching a rule document, which
are the ones a future reader most needs to reconstruct.

**Require a decision for every pull request.** Uniform and trivially checkable by
counting files, but it produces records for typo fixes, which trains reviewers to
ignore them.

## Verification

- `skills/repo-development/SKILL.md` defines non-trivial, lists the exempt
  categories, and requires the record in the same commit.
- `.github/pull_request_template.md` carries the requirement as a checklist item.
- This decision is its own first case: it was added with the rule it describes.
- No gate exists, and the decision records why: the judgment is not
  mechanizable, so a gate would measure the wording rather than the work.

## Consequences

- **Over-recording.** If reviewers accept a record for every trivial change, the
  decision tree fills with noise. The exemption list is the counterweight, and the
  review of the record itself is the check.
- **Under-recording by habit.** Without a gate, an agent that forgets produces no
  signal. The pull-request checklist item is visible in the same place the
  reviewer already reads, and the omission is itself a reviewable claim under
  [declare what was not verified](2026-09-09-declare-what-was-not-verified.md).
