# Declare what was not verified

[中文](2026-09-09-declare-what-was-not-verified.zh-CN.md)

**Status:** implemented
**Date:** 2026-09-09

## Problem

NMG's central failure mode is a claim that outruns the code: a document says a
behavior is implemented and the code does not deliver it. RCP closes part of that
gap by recording what ran. It records nothing about what did not run.

Failure is visible in a receipt: `status: failed`, plus `evidence` written on
failure. An omission is not. A change that skipped a route, could not build, had
no reproducer, or exercised one platform looks identical to a change that was
verified. Absence has no representation, so it cannot be reviewed, counted, or
checked.

The Linux kernel's AI-coding-assistant policy makes this a hard requirement for
the opposite reason: maintainers "waste too much time analyzing unverified
reports and untested fixes", so an assistant must state explicitly what it could
not build, test, or reproduce. NMG has no equivalent obligation, and the
2026-09-08 corrections in this repository were all omissions of this kind: a
receipt that never carried coverage numbers, a field that was declared and never
read.

## Decision

Every agent-delivered change declares its unverified surface in the pull request
that carries it, in a `## Not verified` section of the pull-request description.
The section names the surface that was not exercised, using the vocabulary the
repository already has: a route that did not run, a platform or environment that
was not built or booted, a build mode, or a behavior with no reproducer. The
literal content `None.` is a claim that nothing is outstanding, and is reviewable
like any other claim.

The declaration is prose about scope, not evidence. It never substitutes for a
check, and a green gate never makes it unnecessary: a `gate.fullGateRun: false`
receipt, a `documented-only` assertion, and a check whose evidence is a named
test rather than a behavior are exactly the cases that belong in this section.

The normative rule lives in `skills/repo-development/SKILL.md`, beside the
delivery procedure it qualifies. `.github/pull_request_template.md` renders the
section in every pull request, so the reminder is the mechanism.

## Alternatives considered

**Put it in the receipt.** The receipt is machine-written from what the planner
and the providers observed. "What I could not verify" is a statement by the
author about what did not happen, which no provider can observe. Adding it to
the receipt would either be unverifiable machine text or invite the verifier to
certify a claim it cannot check.

**Rely on `gate.fullGateRun` and `documented-only` assertions.** They record that
coverage was partial. They do not record what the author knew was missing and
chose not to cover, which is the case that misleads a reader.

**Gate it in CI by reading the pull-request body.** GitHub exposes the body, so a
check could require a non-empty section. It would be satisfied by the word
`None.`, and it would add a network and token dependency to a gate whose current
inputs are local files. The reminder is the template; the content is reviewed.

## Verification

- `skills/repo-development/SKILL.md` states the obligation and its scope in the
  pull-request step.
- `.github/pull_request_template.md` carries a `## 未验证项` section with a
  `**Not verified**` line whose guidance names routes, platforms, environments,
  build modes, and reproducers.
- Unfinished or unverified items use the `## Deferred` section owned by
  [enforce the documented documentation rules](2026-09-09-enforce-documentation-rules.md).
- A reader of a merged pull request can answer "what did this change not verify?"
  without reading the diff.

## Consequences

- **Ritual compliance.** A required section invites an unconsidered `None.`. It
  is read in the same review as the change, where a wrong `None.` is a checkable
  claim about a known surface.
- **No check exists.** Nothing verifies that the section is filled, because no
  test distinguishes "this change needs no verification" from "this change claims
  it needs none"; a gate would be satisfied by writing a sentence.
- **Overlap with the trade-off record.** A decision already records what it gave
  up. The section is narrower: a surface that was not verified, not a trade-off
  that was accepted. When both exist, the trade-off record owns the trade-off and
  `## Deferred` owns the omission.
