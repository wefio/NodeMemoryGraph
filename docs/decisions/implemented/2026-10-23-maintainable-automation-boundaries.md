# Keep automation maintainable at its execution and evidence boundaries

[中文](2026-10-23-maintainable-automation-boundaries.zh-CN.md) · [Terms used](2026-10-23-maintainable-automation-boundaries.terms.yaml)

**Status:** implemented
**Approved:** explicit
**Relates to:** [Result properties, not tool identity](2026-09-09-gates-assert-results-not-tools.md)

## Problem

Small analyses can become maintained tooling without a deliberate change in how
shared logic, resources and saved results are managed. The motivating review
found repeated process-lifecycle code, local variants of shared measurements,
result reuse based on row identity rather than computation identity, and helper
tests that did not establish whether the command still ran. Corrections appended
to reports also left older conclusions looking current.

The existing rules already address reuse and evidence scope. Their one-off-script
framing and general reminders leave the decision points above underspecified.
The user chose general prevention rules, not a retrofit of the reviewed files.

## Decision

Extend the existing workflow owners rather than add a second checklist:

- [Script reuse](../../../skills/script-reuse/SKILL.md) covers maintained and
  resumable automation as well as disposable analysis. Its parts rules own
  reuse and shared semantics; its execution section owns resource isolation,
  compatible result reuse and durable completion.
- [Verification traceability](../../../skills/verification-traceability/SKILL.md#verify-the-executed-boundary)
  owns the evidence needed for a runnable entry point, including the distinction
  between controlled checks and an untested live dependency.
- [Reader review](../../../skills/doc-maintenance/references/reader-review.md#review-and-acceptance)
  owns reconciliation of a changed claim with current conclusions and guidance.
- [Repository development](../../../skills/repo-development/SKILL.md#before-editing)
  routes script work to these owners even when the script is retained.

These are authoring and review obligations for new or changed work. This change
adds no runtime framework, registry or CI gate, and does not refactor existing
experiment code, results or reports. Independent verification remains distinct
from maintaining a competing implementation of the same operational contract.

## Alternatives considered

- **Refactor all motivating files now.** Rejected for this change: it exceeds the
  requested preventive scope and would disturb concurrent experiment work.
- **Add a new anti-duplication Skill or root checklist.** Rejected: the existing
  owners already handle these decisions; another entry would duplicate rules.
- **Require a universal runner, manifest format or fixed directory layout.**
  Rejected: tools have different execution costs and lifecycles. The necessary
  properties can be met through existing owners without a new framework.
- **Add a whole-repository duplicate-body gate.** Rejected: identical text is
  not the same as shared semantics; the related decision records that limit.
  Existing type, test and documentation checks remain useful evidence.
- **Keep the original one-off-only framing.** Rejected: retention and resume are
  precisely where temporary assumptions become long-lived dependencies.

## Consequences

The added review work occurs at a concrete boundary: a second consumer, a shared
measurement, resource acquisition, result reuse, an executable change or a
changed conclusion. No per-file registration or mandatory abstraction is added.
Disposable scripts remain disposable; a command needed for reproduction is
maintained rather than discarded under that label.

A small controlled execution can verify command wiring without paying for a live
workload. It cannot establish live integration or answer quality. Likewise,
document checks establish structure, not that Agents follow these rules or that
historical artifacts now satisfy them.

## Risks

Identity can be too weak or too broad. The execution owner chooses fields that
change result meaning and excludes secrets; a blanket dump of the environment is
not a substitute. Reuse can also become over-abstraction, so extraction follows
actual consumers and leaves task-specific choices with the caller.

If a clause repeatedly creates work unrelated to the affected boundary, revise
or remove it at its existing owner. Do not compensate by adding another checklist.
